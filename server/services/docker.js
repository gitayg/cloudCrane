import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { getDb } from '../db.js';
import {
  publicPortForApp, dataPlanePortForApp, releasePendingPortAfterRecreate, CONTROL_PLANE_PORT,
} from './tcpIngress.js';
import log from '../utils/logger.js';

const execFileAsync = promisify(execFile);
// Imported rather than re-declared as 3000. v2.45.0's data-plane guard is
// "data_plane_port must not be the control-plane port", and tcpIngress.js is
// where that comparison happens — if the two constants ever drifted, the guard
// would compare against a number this file no longer publishes and the control
// plane could be exposed raw with every check still passing.
const CONTAINER_PORT = CONTROL_PLANE_PORT;
const APPCRANE_LABEL = 'appcrane=true';

// v2.42.1 SECURITY. Every app container used to be started with no --network at
// all, which put all of them on Docker's default `bridge`. Containers there can
// route to each other freely, so any one app could open
// http://<other-app-ip>:3000 directly and reach a sibling's origin — behind
// Caddy's back, with no forward_auth, no identity headers, no audit entry and no
// rate limit. One compromised app owned every app on the box.
//
// The obvious fix — a network per app — does not survive this platform's size.
// A user-defined network isolates its members from OTHER networks, but members
// of the same network still reach each other, so isolation would mean ~one
// network per app; and Docker's DEFAULT address pools only subnet into roughly
// 16-31 bridge networks before `docker network create` starts failing with "all
// predefined address pools have been fully subnetted". At ~57 apps that design
// dies partway through, at deploy time, with an error about subnets that reads
// like nothing to do with the app being deployed.
//
// So: ONE shared network, with the bridge driver's own inter-container
// connectivity switch turned off. `enable_icc=false` makes the daemon drop
// container-to-container traffic across that bridge. Measured on Docker 29.6.1,
// each against a control container on an otherwise identical network with the
// option left at its default, where every one of these SUCCEEDS:
//   - sibling -> victim's container IP:3000        blocked (times out)
//   - sibling -> victim by container DNS name      blocked (name still resolves
//     via 127.0.0.11, the connection does not complete)
//   - sibling -> bridge gateway:<published port>   blocked. This is the one
//     worth naming: a tcp-ingress app also publishes on 0.0.0.0, and the
//     hairpin back in through the gateway looks like it should re-open the door
//     for a sibling container. It does not.
// while everything that must keep working does, all four verified against the
// exact argv below:
//   - the 127.0.0.1:<hostPort> publish Caddy proxies to
//   - v2.42.0's second 0.0.0.0:<public_port> publish for tcp-ingress apps
//   - --add-host host.docker.internal:host-gateway, i.e. container -> AppCrane
//   - outbound DNS and internet egress
// One network also means nothing to tear down when an app is deleted: a per-app
// design leaks a subnet per deleted app until the pool is exhausted, which is a
// second way the same design breaks.
//
// SCALING LIMIT, stated plainly: capacity is now one subnet for the whole
// platform — every app container, production and sandbox, takes one address in
// it. Docker's default pools hand this network a /16 or a /20 (thousands of
// addresses) so there is no practical ceiling, but an operator who has narrowed
// `default-address-pools` in daemon.json to small blocks can create a network
// too small to hold the fleet. ensureAppNetwork() measures the allocated subnet
// and warns while there is still room to widen it.
const APP_NETWORK = 'appcrane-apps';
const ICC_OPTION = 'com.docker.network.bridge.enable_icc';
const MIN_NETWORK_ADDRESSES = 256;

// Cap on processes/threads per container, so a fork bomb in one app cannot
// exhaust the host's pid space and take the other 56 down with it. Deliberately
// generous: a node:20 http server measured 11 threads (V8 plus the libuv pool)
// and nginx runs one worker per core, so 512 is far above anything legitimate
// here. Enforced by the kernel, not advisory — cgroup pids.max reads 512 inside
// the container, against "max" without the flag.
const PIDS_LIMIT = 512;

async function dockerExec(args, opts = {}) {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      timeout: 60000,
      ...opts,
    });
    return stdout.trim();
  } catch (e) {
    // stderr FIRST. `docker run -d` writes the new container id to stdout even
    // when the run fails, so a stdout-first pick returned a bare 64-char hex
    // string and threw away the reason on stderr — "Bind for 0.0.0.0:31000
    // failed: port is already allocated" became an unreadable id in the deploy
    // log. v2.42.0's public publish is the first routine way to hit a host-port
    // collision (loopback ports are slot-derived and effectively never clash),
    // which is what surfaced it. Matches index.js, spaBuilder.js and
    // appstudio/worker.js, which all already read stderr first.
    const output = e.stderr?.toString().trim() || e.stdout?.toString().trim() || e.message;
    log.debug(`docker ${args[0]} failed: ${output}`);
    throw new Error(output);
  }
}

function containerName(slug, env) {
  return `appcrane-${slug}-${env}`;
}

async function inspectAppNetwork() {
  try {
    const out = await dockerExec(
      ['network', 'inspect', APP_NETWORK, '--format',
        `{{index .Options "${ICC_OPTION}"}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}`],
      { timeout: 10000 }
    );
    const [icc = '', subnets = ''] = out.split('|');
    return { icc: icc.trim(), subnet: subnets.trim().split(/\s+/)[0] || '' };
  } catch (_) {
    return null;
  }
}

/**
 * Create the shared, inter-container-isolated app network if it is not there,
 * and verify an existing one is actually isolating. Idempotent, and re-checked
 * on every container start rather than cached: this is a deploy-path call, one
 * `docker network inspect` next to a docker build, and a cached "it was fine
 * once" would go on asserting isolation after someone removed or replaced the
 * network by hand.
 *
 * Throws if the network cannot be created. That is deliberate: AppCrane cannot
 * configure the Docker daemon from here, so the alternative is falling back to
 * the default bridge, which would leave every app reachable from every other
 * app while the deploy still reported success — the security fix silently inert,
 * which is worse than a deploy that stops and says what to fix.
 */
export async function ensureAppNetwork() {
  let net = await inspectAppNetwork();

  if (!net) {
    try {
      await dockerExec(
        ['network', 'create', '--label', APPCRANE_LABEL, '--opt', `${ICC_OPTION}=false`, APP_NETWORK],
        { timeout: 20000 }
      );
      log.info(`docker network ${APP_NETWORK} created with inter-container connectivity disabled`);
    } catch (e) {
      // Two deploys racing: whoever loses the create still wants the network.
      if (!/already exists/i.test(e.message)) {
        throw new Error(
          `Cannot create the isolated app network '${APP_NETWORK}': ${e.message}. ` +
          `AppCrane will not start app containers on Docker's default bridge, where every app ` +
          `can reach every other app's port ${CONTAINER_PORT} directly and bypass Caddy's ` +
          `forward_auth. Free a daemon address pool ('docker network prune' to drop unused ` +
          `networks) or widen "default-address-pools" in /etc/docker/daemon.json, then deploy again.`
        );
      }
    }
    net = await inspectAppNetwork();
  }

  if (net && net.icc !== 'false') {
    // Docker has no `network update`, so this cannot be repaired in place while
    // containers are attached — warn on every start until an operator acts,
    // rather than pretending the platform is isolated when it is not.
    log.warn(
      `SECURITY: docker network ${APP_NETWORK} exists with inter-container connectivity ENABLED. ` +
      `App containers on it can reach each other's port ${CONTAINER_PORT} directly, bypassing Caddy ` +
      `auth. Docker cannot change this on a live network: stop the app containers, run ` +
      `'docker network rm ${APP_NETWORK}', then redeploy — AppCrane recreates it isolated.`
    );
  }

  // Usable hosts in a /N, minus network, broadcast and the bridge gateway.
  const prefix = Number(net?.subnet?.split('/')[1]);
  if (prefix > 0) {
    const usable = 2 ** (32 - prefix) - 3;
    if (usable < MIN_NETWORK_ADDRESSES) {
      log.warn(
        `docker network ${APP_NETWORK} has subnet ${net.subnet} — only ${usable} container ` +
        `addresses for the whole platform, and each app uses one per environment. Widen ` +
        `"default-address-pools" in /etc/docker/daemon.json, then remove and let AppCrane ` +
        `recreate the network, before container starts begin failing for lack of an address.`
      );
    }
  }

  return APP_NETWORK;
}

function imageTag(slug, env, commitHash) {
  const raw = commitHash && commitHash !== 'unknown' ? commitHash : `t${Date.now()}`;
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  // Must be env-scoped: Vite/other bundlers bake APP_BASE_PATH into the artifact
  // at build time, so sandbox (/<slug>-sandbox/) and production (/<slug>/) MUST
  // have different images even when built from the same commit.
  return `appcrane-${slug}-${env}:${safe}`;
}

// v2.21.10: exposed so the Nixpacks path can tag its image identically.
export function imageTagFor(slug, env, commitHash) { return imageTag(slug, env, commitHash); }

export async function buildImageIfNeeded({ slug, env, contextDir, commitHash, appBasePath, onLog }) {
  const tag = imageTag(slug, env, commitHash);
  if (commitHash && commitHash !== 'unknown') {
    try {
      await dockerExec(['image', 'inspect', tag, '--format', '{{.Id}}'], { timeout: 5000 });
      onLog?.(`Using cached image: ${tag} (skipping rebuild)`);
      return tag;
    } catch (_) {}
  }
  return buildImage({ slug, env, contextDir, commitHash, appBasePath, onLog });
}

export async function getContainerImage(slug, env) {
  const name = containerName(slug, env);
  return dockerExec(['inspect', name, '--format', '{{.Config.Image}}'], { timeout: 5000 });
}

export async function buildImage({ slug, env, contextDir, commitHash, appBasePath, onLog }) {
  const tag = imageTag(slug, env, commitHash);
  const args = ['build', '-t', tag, '--label', APPCRANE_LABEL, '--label', `slug=${slug}`, '--label', `env=${env}`];
  // Build-time only: bundlers (Vite, CRA, Next) need APP_BASE_PATH to emit
  // correct asset URLs. Caddy strips this prefix at runtime, so it must NOT
  // appear in the runtime container env — see bugs/2026-04-26-appcrane-app-base-path-resolution.md
  if (appBasePath) {
    args.push('--build-arg', `APP_BASE_PATH=${appBasePath}`);
    args.push('--build-arg', `PUBLIC_URL=${appBasePath}`);
    args.push('--build-arg', `VITE_BASE_PATH=${appBasePath}`);
  }
  args.push(contextDir);

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'pipe' });
    let outputBuf = '';

    const emit = (line) => { if (line.trim()) onLog?.(line); };
    child.stdout.on('data', (c) => {
      const s = c.toString();
      outputBuf += s;
      s.split('\n').forEach(emit);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString();
      outputBuf += s;
      s.split('\n').forEach(emit);
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('docker build timed out after 10 minutes'));
    }, 600000);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`docker build failed: ${outputBuf.slice(-3000)}`));
      resolve(tag);
    });
  });
}

/**
 * BOTH ends of this app's 0.0.0.0 publish — `{ host, container }` — or null when
 * it publishes nothing. Resolved from the database here rather than taken as a
 * parameter: every container recreation — deploy, rollback, the env-var restart
 * in routes/deploy.js — funnels through startApp(), and a caller that forgot to
 * pass it would silently bring a tcp app back loopback-only, taking it off the
 * network its clients are pinned to with no error anywhere.
 *
 * v2.45.0: the container side is no longer assumed to be CONTAINER_PORT. A
 * 'dual' app's data plane listens on its OWN port inside the container, and
 * publishing CONTAINER_PORT for it would put the HTTP control plane — the origin
 * Caddy fronts — on a public port with no TLS, forward_auth, identity headers or
 * audit. tcpIngress owns that decision for both types: it answers CONTAINER_PORT
 * for a pure-tcp app (whose whole container IS the data plane, since PORT=3000 is
 * all it is told), and null for any row it considers unsafe or half-specified.
 * data_plane_port must therefore be in the SELECT — omitting it would make every
 * dual app read as unconfigured and silently stop publishing.
 *
 * The two calls are one decision, not two: tcpIngress derives both ends from the
 * same check, so a row it refuses reports null for BOTH. Measured, not assumed —
 * a 'dual' row hand-edited to data_plane_port=3000, and one with no data-plane
 * port at all, each return a null HOST port here and so publish nothing, which is
 * why the host being non-null is the only condition this function needs.
 *
 * Production only. There is one public_port per app but two containers, so
 * publishing it for both would make the second `docker run` fail with "port is
 * already allocated" — and the loser could be production. Sandbox stays
 * loopback-only and therefore cannot take the port production's clients use.
 */
function publicPublishTargets(slug, env, containerPort) {
  // v2.46.0: sandbox can publish too, on its OWN port. The old rule was
  // `env !== 'production' -> null`, justified by "one public_port, two
  // containers, so the second docker run dies with 'port is already
  // allocated'". That argued against one port on two containers, never against
  // two different ports — sandbox was excluded because there was only one
  // number to go round. There are now two, and the registry in migration 076
  // makes it impossible for them to be equal.
  //
  // Still null for anything that is not a publishable environment, so a future
  // third env cannot start publishing by accident.
  if (env !== 'production' && env !== 'sandbox') return null;
  const app = getDb()
    .prepare('SELECT ingress_type, public_port, sandbox_public_port, data_plane_port FROM apps WHERE slug = ?')
    .get(slug);
  const host = publicPortForApp(app, env);
  if (host === null) return null;
  const container = dataPlanePortForApp(app, env);
  // tcpIngress answers CONTROL_PLANE_PORT for a pure-tcp app because "the whole
  // container is the data plane, and it is told PORT=3000". That premise is a
  // property of an image AppCrane built. A pulled image listens where its
  // author put it (postgres on 5432, odoo on 8069) and does not read $PORT, so
  // for a source_type='image' tcp app the publish would target a port nothing
  // is bound to and every raw-TCP client would get connection-refused.
  //
  // Only the pure-tcp answer is rewritten: a 'dual' app's container side is its
  // own data_plane_port, which validateDataPlanePort() refuses to let equal
  // CONTROL_PLANE_PORT — so `container === CONTAINER_PORT` identifies the
  // pure-tcp case exactly, and a dual app's data plane is left where the
  // operator configured it. With the default containerPort this is a no-op, so
  // no existing app's argv moves.
  if (container === CONTAINER_PORT && containerPort !== CONTAINER_PORT) {
    return { host, container: containerPort };
  }
  return { host, container };
}

// v2.59.0: the port inside the container is a parameter, not a constant.
//
// It was `-p 127.0.0.1:<hostPort>:3000` with `PORT=3000` in the environment,
// which is a contract only an image AppCrane built can keep: the generated
// Dockerfile and the Node apps behind it listen on $PORT and default to 3000.
// A pulled third-party image obeys neither half — odoo listens on 8069 and
// ignores $PORT entirely — so every image-source deploy published a port with
// nothing behind it and died at the health probe with no hint as to why.
//
// Optional, defaulting to CONTAINER_PORT, so every existing caller (deployer.js,
// routes/deploy.js, healthChecker.js) is byte-for-byte unchanged.
export async function startApp({ slug, env, image, hostPort, envVars = {}, volumes = [], memoryMb = 512, cpus = 0.5, addHostGateway = false, containerPort = CONTAINER_PORT }) {
  const name = containerName(slug, env);

  // apps.container_port is nullable and NULL MEANS the 3000 default (migration
  // 083). A default parameter only fires on `undefined`, so a caller reading the
  // column straight out of the row and passing it through would otherwise emit
  // `-p 127.0.0.1:<hostPort>:null` and `PORT=null` — a container that starts,
  // publishes nothing reachable, and fails the health probe as if the app were
  // broken. Normalised here so every caller can pass the column as-is.
  const port = Number.isInteger(containerPort) ? containerPort : CONTAINER_PORT;

  // Before the old container goes away, so a host that cannot provide the
  // isolated network fails with that explained and the app still running,
  // instead of being torn down for a start that was never going to happen.
  const network = await ensureAppNetwork();

  await stopApp(slug, env).catch(() => {});

  const args = [
    'run', '-d',
    '--name', name,
    '--label', APPCRANE_LABEL,
    '--label', `slug=${slug}`,
    '--label', `env=${env}`,
    // v2.48.0: on-failure:2, down from 5. The direction was right and the count
    // was not. A process that OOMs under load OOMs again on the way back up, so
    // five attempts re-pressure a host that has no memory left to give, five
    // times, at the exact moment the fleet is already over-committed (~25 GB of
    // per-container limits against 7.6 GB of RAM). Two tries covers the restart
    // that actually helps — a transient crash — and stops before the loop turns
    // one app's OOM into the host's.
    '--restart=on-failure:2',
    '--network', network,
    `--memory=${memoryMb}m`,
    // Equal to --memory, which is Docker's spelling for "no swap at all": the
    // flag is the combined memory+swap ceiling, so swap budget = memory-swap -
    // memory = 0. Omitting it does NOT mean no swap — Docker then defaults to
    // 2x memory, silently doubling the real ceiling on any host that has swap.
    //
    // Measured against a real daemon, not read off the docs: `--memory=512m`
    // alone inspects as MemorySwap=1073741824 and gives the container
    // memory.swap.max=536870912 in its cgroup — half a gigabyte of swap nobody
    // asked for. With `--memory-swap=512m` the same container gets
    // memory.swap.max=0. See test/docker-resource-flags.test.js, which runs both.
    //
    // The August 2026 OOM review: a container ran --memory=512m --memory-swap=1g
    // and so read as having 512 MB of swap to fall back on. The host had zero
    // swap configured, so the kernel enforced 512 MB of RAM and nothing else,
    // and the extra 512 MB was a contract nothing could deliver. Pinning the two
    // together removes the question — the configured number IS the ceiling, on a
    // host with swap and on a host without, and it means the same thing on both.
    `--memory-swap=${memoryMb}m`,
    `--cpus=${cpus}`,
    `--pids-limit=${PIDS_LIMIT}`,
    // Blocks the setuid/setgid escalation path: a process in the container can
    // no longer gain privileges by exec'ing a setuid binary. Verified not to
    // disturb the usual root -> app-user drop in an entrypoint (su-exec/gosu
    // keep working, since dropping privileges is not gaining them); what it does
    // break is an entrypoint that calls `sudo`, which is the escalation this is
    // here to stop.
    '--security-opt', 'no-new-privileges',
    // Removes AF_PACKET and SOCK_RAW (measured: both fail EPERM with this flag
    // and both open without it). enable_icc=false drops ROUTED traffic between
    // containers, but they still share one bridge's L2 broadcast domain, so
    // without this an app could craft raw frames and ARP-spoof its way around
    // an L3-only block. Cost is smaller than it looks: `ping` still works
    // (measured), because busybox/iputils use ICMP *datagram* sockets under
    // net.ipv4.ping_group_range, which do not need CAP_NET_RAW. Verified
    // harmless to node:20 and nginx:alpine; --cap-drop=ALL was measured and
    // rejected below.
    '--cap-drop', 'NET_RAW',
    '-p', `127.0.0.1:${hostPort}:${port}`,
    '--log-opt', 'max-size=10m',
    '--log-opt', 'max-file=3',
  ];

  // Deliberately NOT added, both measured against real base images rather than
  // assumed:
  //   --read-only    breaks apps that write anywhere outside their volume, and
  //                  adding a tmpfs for /tmp is not enough: WITH --tmpfs /tmp,
  //                  nginx:alpine still dies at boot on mkdir("/var/cache/nginx/
  //                  client_temp") EROFS, and a Node app creating a cache dir
  //                  outside /tmp throws the same way. Covering that needs a
  //                  per-image list of writable paths nobody has. Too broad to
  //                  enable for 57 existing apps.
  //   --cap-drop=ALL breaks nginx:alpine at startup: chown("/var/cache/nginx/
  //                  client_temp") fails with EPERM, which takes out every
  //                  static-serve app. NET_RAW alone is the part that buys
  //                  isolation here anyway.

  // v2.42.0: a tcp app publishes a SECOND binding on 0.0.0.0 so raw TCP
  // clients (a CONNECT proxy's tunnel, say) reach the container directly —
  // Caddy is an HTTP reverse proxy and cannot express a tunnel. The loopback
  // publish above is deliberately kept: it is what the health probe, the
  // Caddy vhost and every internal caller still use, so nothing about an
  // http app's argv changes and a tcp app keeps its private door.
  //
  // v2.45.0 widens that to a 'dual' app, where the loopback publish is not just
  // kept but load-bearing: 127.0.0.1:<hostPort>:3000 carries the CONTROL plane
  // through Caddy untouched, while this publish carries the DATA plane to a
  // different port inside the same container. Only the container side moved —
  // for an http app there is still no second -p at all, and for a pure-tcp app
  // the container side is still CONTAINER_PORT, so both argvs are unchanged.
  //
  // SECURITY: this bypasses Caddy entirely, so the published port has no
  // forward_auth, no identity headers, no request audit, no rate limiting, no
  // security headers and no TLS from AppCrane — the app owns authentication.
  // AppCrane publishes the port; it does NOT open the host firewall. That is
  // deliberately a separate operator step so a mis-click in the dashboard
  // cannot put an app on the internet.
  const publish = publicPublishTargets(slug, env, port);
  if (publish) {
    args.push('-p', `0.0.0.0:${publish.host}:${publish.container}`);
  }

  // v2.8.0: only email-enabled apps need to reach AppCrane from inside the
  // container (for the email service). host-gateway maps host.docker.internal
  // to the host so CRANE_INTERNAL_URL resolves. Off by default — every other
  // container start is unchanged.
  if (addHostGateway) {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }

  for (const vol of volumes) {
    args.push('-v', `${vol.host}:${vol.container}`);
  }

  const runtimeEnv = {
    ...envVars,
    // Tracks the published port rather than staying pinned at 3000. An image
    // that DOES honour $PORT (most buildpack output, and AppCrane's own builds)
    // must be told the same number the -p above targets; telling it 3000 while
    // publishing 8069 is the exact failure this change exists to remove, just
    // inverted. An image that ignores $PORT — odoo, postgres, nginx — is
    // unaffected either way.
    PORT: String(port),
    NODE_ENV: env === 'production' ? 'production' : 'development',
    DATA_DIR: '/data',  // platform guarantee — every app container has /data mounted
  };
  for (const [k, v] of Object.entries(runtimeEnv)) {
    args.push('-e', `${k}=${v}`);
  }

  args.push(image);
  const id = await dockerExec(args);
  invalidatePublishedPortsCache();   // the bindings just changed
  invalidateResourcesCache();        // and so did the applied limits
  log.info(`docker started: ${name} (${id.slice(0, 12)}) from ${image}`);
  if (publish) {
    // The container port is in the line because it is the one fact that says
    // WHICH plane got exposed. `-> 3000` is the control plane and is only ever
    // correct for a pure-tcp app; on a dual app it would mean the guard failed.
    log.info(`[tcp-ingress] ${name} also published on 0.0.0.0:${publish.host} -> container port ${publish.container} — NOT behind AppCrane auth; restricting it is still the operator's firewall job. On Linux this publish is a DNAT rule evaluated in FORWARD and never in INPUT, so a plain 'ufw deny' does NOT block it — filter in DOCKER-USER or in an upstream security group.`);
  }

  // v2.42.0: this is where a tcp -> http flip actually takes effect, and so
  // where the port it left reserved goes back in the pool. The flip cannot
  // close a port on its own — the publish is an argv flag — so it keeps the
  // reservation instead of handing a still-bound port to the next app that
  // asks. The container just created is the proof the old one is gone.
  //
  // v2.47.0: both environments, and both reasons. A re-pin leaves the OLD port
  // draining — still reserved so nobody else can be given it while the previous
  // container answers on it — and this is the moment that container is proven
  // gone. Without the sandbox half, a sandbox re-pin would hold its old number
  // reserved forever.
  const released = releasePendingPortAfterRecreate(getDb(), slug, env);
  if (released) {
    log.info(`[tcp-ingress] ${name} was recreated without ${released.join(', ')} — ` +
      `${released.length > 1 ? 'those ports are' : 'that port is'} now closed and back in the allocation pool.`);
  }
  return id;
}

export async function stopApp(slug, env) {
  const name = containerName(slug, env);
  try { await dockerExec(['stop', name], { timeout: 15000 }); } catch (e) {}
  try { await dockerExec(['rm', '-f', name]); } catch (e) {}
  invalidatePublishedPortsCache();
  invalidateResourcesCache();
  log.debug(`docker stopped: ${name}`);
}

export async function restartApp(slug, env) {
  const name = containerName(slug, env);
  try {
    await dockerExec(['restart', name], { timeout: 20000 });
    log.info(`docker restarted: ${name}`);
  } catch (e) {
    log.warn(`docker restart ${name} failed: ${e.message}`);
    throw e;
  }
}

export async function getProcessMetrics(slug, env) {
  const name = containerName(slug, env);
  try {
    const inspectOut = await dockerExec(['inspect', name, '--format', '{{.State.Status}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.RestartCount}}']);
    const [status, pid, startedAt, restarts] = inspectOut.split('|');
    if (status !== 'running') return { status, cpu: 0, memory: 0, pid: Number(pid) || 0, uptime: 0, restarts: Number(restarts) || 0 };
    const statsOut = await dockerExec(['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', name]);
    const [cpuPerc, memUsage] = statsOut.split('|');
    const cpu = parseFloat(cpuPerc.replace('%', '')) || 0;
    const memory = parseMemoryUsage(memUsage);
    const uptime = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;
    return { status: 'online', cpu, memory, pid: Number(pid) || 0, uptime, restarts: Number(restarts) || 0 };
  } catch (e) {
    return { status: 'stopped', cpu: 0, memory: 0 };
  }
}

function parseMemoryUsage(s) {
  if (!s) return 0;
  const m = s.trim().split('/')[0].trim().match(/([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mul = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3 }[unit] || 1;
  return Math.round(n * mul);
}

export async function getAppLogs(slug, env, lines = 100, search = '') {
  const name = containerName(slug, env);
  try {
    const output = await dockerExec(['logs', '--tail', String(lines), name]);
    const allLines = output.split('\n');
    if (!search) return allLines;
    const q = search.toLowerCase();
    return allLines.filter(l => l.toLowerCase().includes(q));
  } catch (e) {
    return [];
  }
}

export async function listAll() {
  try {
    const format = '{{.Names}}|{{.Label "slug"}}|{{.Label "env"}}|{{.Status}}|{{.ID}}';
    const output = await dockerExec(['ps', '-a', '--filter', `label=${APPCRANE_LABEL}`, '--format', format]);
    if (!output) return [];
    return output.split('\n').map(line => {
      const [name, slug, env, status, id] = line.split('|');
      return { name, slug, env, status, id };
    });
  } catch (e) {
    return [];
  }
}

/**
 * Every NON-LOOPBACK port binding, per app slug, in ONE `docker ps` call.
 *
 * Feeds ingressDrift(), which answers "is the configured publish actually
 * live". Deliberately a single invocation rather than an inspect per app: the
 * catalog endpoint lists every app on the platform, and a subprocess spawn per
 * app there is exactly the shape of cost that made Settings slow.
 *
 * Only RUNNING containers, and only production — a stopped container publishes
 * nothing, and the public port is production's alone (see publicPublishTargets).
 *
 * Returns a Map<slug, { publishes: [{hostIp, hostPort, containerPort}] }>, with
 * an entry for every running production container INCLUDING those that publish
 * nothing (an empty array is the meaningful answer "it is up and binds no public
 * port"). A slug absent from the map has no running production container, which
 * the caller must report as unknown rather than as unpublished.
 *
 * Null on failure — never an empty map, which would read as "nothing is
 * published anywhere" and turn a Docker outage into a wall of false drift.
 */
// /api/apps is one of the hottest endpoints on the platform, so this cannot
// spawn a subprocess on every call. Bindings only change when a container is
// created or destroyed, and both of those paths invalidate below — the TTL is
// just a backstop for a container changed by something other than AppCrane.
const PUBLISHED_PORTS_TTL_MS = 5000;
let publishedPortsCache = null;   // { at, map }

export function invalidatePublishedPortsCache() { publishedPortsCache = null; }

export async function publishedPortsBySlug() {
  if (publishedPortsCache && Date.now() - publishedPortsCache.at < PUBLISHED_PORTS_TTL_MS) {
    return publishedPortsCache.map;
  }
  try {
    const out = await dockerExec([
      'ps', '--filter', `label=${APPCRANE_LABEL}`,
      '--format', '{{.Label "slug"}}|{{.Label "env"}}|{{.Ports}}',
    ]);
    const map = new Map();
    if (!out) return map;
    for (const line of out.split('\n')) {
      const [slug, env, ports] = line.split('|');
      if (!slug || !env) continue;
      // Keyed by slug AND env now that both containers can publish. Reporting
      // only production would leave a sandbox publish invisible to drift — the
      // same blind spot, one environment over.
      map.set(`${slug}:${env}`, { publishes: parsePublishedPorts(ports) });
    }
    publishedPortsCache = { at: Date.now(), map };
    return map;
  } catch (e) {
    log.warn(`[ingress] could not read published ports: ${e.message}`);
    return null;   // never cached — a Docker blip must not pin "unknown" for the TTL
  }
}

/**
 * Parse the `{{.Ports}}` column, e.g.
 *   "127.0.0.1:4013->3000/tcp, 0.0.0.0:8080->10800/tcp, 9229/tcp"
 *
 * Loopback bindings are dropped: 127.0.0.1:<slot>->3000 is the control-plane
 * publish every app has and is not reachable off the host, so reporting it as a
 * public port would make every app look like it drifted. Entries with no host
 * side at all (an EXPOSE with no publish) are not bindings and are dropped too.
 */
export function parsePublishedPorts(ports) {
  if (!ports) return [];
  const out = [];
  for (const part of ports.split(',')) {
    const m = part.trim().match(/^(\[[^\]]+\]|[^:]+):(\d+)->(\d+)\/\w+$/);
    if (!m) continue;
    const hostIp = m[1];
    if (hostIp === '127.0.0.1' || hostIp === '[::1]') continue;
    out.push({ hostIp, hostPort: Number(m[2]), containerPort: Number(m[3]) });
  }
  return out;
}

/**
 * The resource limits ACTUALLY applied to every AppCrane container, in two
 * `docker` calls for the whole fleet.
 *
 * `--memory` and `--cpus` are `docker run` arguments, exactly like a port
 * publish: changing max_ram_mb on a running app rewrites the row and nothing
 * else until the container is RECREATED. Every AppCrane surface reported the
 * configured number, so a container running with no memory limit at all looked
 * identical to one running with 512 MB.
 *
 * That is not hypothetical. An August 2026 incident had clamd OOM-killed at
 * 992 MB anonymous RSS on an app configured for 512 MB — figures that cannot
 * both be true, because a 512 MB cgroup limit kills the process at 512 MB. The
 * limit was not in force, and no surface could have said so.
 *
 * Two calls rather than one inspect per app: `docker inspect` takes many
 * containers at once but needs their ids, and `docker ps` cannot report
 * HostConfig. Cached and invalidated on the same events as the port reader.
 *
 * Returns Map<"slug:env", { memoryBytes, nanoCpus, restartPolicy, running }>,
 * or null when Docker could not be read — never an empty map, which would read
 * as "no app has limits" and turn an outage into a wall of false findings.
 */
const RESOURCES_TTL_MS = 5000;
let resourcesCache = null;

export function invalidateResourcesCache() { resourcesCache = null; }

export async function containerResourcesBySlug() {
  if (resourcesCache && Date.now() - resourcesCache.at < RESOURCES_TTL_MS) return resourcesCache.map;
  try {
    const listed = await dockerExec([
      'ps', '-a', '--filter', `label=${APPCRANE_LABEL}`,
      '--format', '{{.ID}}|{{.Label "slug"}}|{{.Label "env"}}',
    ]);
    const map = new Map();
    if (!listed) { resourcesCache = { at: Date.now(), map }; return map; }

    const rows = listed.split('\n').map(l => l.split('|')).filter(r => r[0] && r[1] && r[2]);
    if (!rows.length) { resourcesCache = { at: Date.now(), map }; return map; }

    const inspected = await dockerExec([
      'inspect', ...rows.map(r => r[0]),
      '--format', '{{.Id}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.Running}}',
    ]);
    const byId = new Map();
    for (const line of (inspected || '').split('\n')) {
      const [id, mem, cpus, restart, running] = line.split('|');
      if (!id) continue;
      byId.set(id, {
        memoryBytes: Number(mem) || 0,
        nanoCpus: Number(cpus) || 0,
        restartPolicy: restart || '',
        running: running === 'true',
      });
    }
    for (const [id, slug, env] of rows) {
      // `docker ps` truncates ids; inspect echoes them in full.
      const full = [...byId.keys()].find(k => k.startsWith(id));
      if (full) map.set(`${slug}:${env}`, byId.get(full));
    }
    resourcesCache = { at: Date.now(), map };
    return map;
  } catch (e) {
    log.warn(`[resources] could not read container limits: ${e.message}`);
    return null;
  }
}

export async function pruneOldImages(slug, env, keep = 2) {
  // Two independent passes, and the second must run even when the first finds
  // nothing. It used to `return` on an empty listing from inside this try — with
  // the pulled-image pass bolted on after it, that early return would skip it
  // for exactly the apps that need it, since an image app's label filter always
  // matches zero rows.
  await pruneOldBuiltImages(slug, env, keep).catch(() => {});

  // v2.59.0: the pass above reclaims nothing for a source_type='image' app, so
  // every redeploy of a moving tag ('odoo:19' picking up a patch release) left
  // the previous image on disk forever. `label=slug=` is written by
  // buildImage()'s `docker build --label`; a PULLED image carries whatever labels its
  // author baked in and never ours, so the filter matches zero rows and the
  // loop has nothing to do.
  //
  // Two ways out, and the labelling one does not work here. `docker run --label`
  // labels the CONTAINER, and the container is not what fills the disk — the
  // image outlives it. Labelling the IMAGE means building a derived one
  // (`FROM <ref>` + LABEL), which (a) produces a new image id, so
  // deployments.image_ref would record a digest that is not the digest the
  // registry serves and provenance stops meaning anything, and (b) reintroduces
  // a build step to the one source type whose entire purpose is not having one.
  //
  // So the prune is extended instead: for an image app, scope by REPOSITORY —
  // the thing every tag and digest of that image shares — and apply the same
  // keep-N-newest rule.
  await pruneOldPulledImages(slug, keep).catch(() => {});
}

/** Keep-N-newest over the images buildImage() tagged and labelled for this app. */
async function pruneOldBuiltImages(slug, env, keep) {
  const filters = ['--filter', `label=slug=${slug}`];
  if (env) filters.push('--filter', `label=env=${env}`);
  const out = await dockerExec(['images', ...filters, '--format', '{{.ID}} {{.CreatedAt}}']);
  if (!out) return;
  const rows = out.split('\n').map(l => {
    const sp = l.indexOf(' ');
    return { id: l.slice(0, sp), created: l.slice(sp + 1) };
  });
  rows.sort((a, b) => b.created.localeCompare(a.created));
  for (const row of rows.slice(keep)) {
    try { await dockerExec(['rmi', '-f', row.id]); } catch (e) {}
  }
}

/**
 * Keep-N-newest over the images pulled for an image-source app's repository.
 *
 * Repository scope is wider than one app: two apps on 'odoo:19' share a
 * repository and its image ids. What makes `rmi -f` safe anyway is the in-use
 * exclusion below — any image referenced by a container, running or stopped,
 * for any app, is skipped outright. The worst remaining case is removing an
 * image a second image-app has configured but has no container for, and that
 * app re-pulls on its next deploy.
 *
 * --no-trunc throughout: `docker images` prints 12-char ids by default while
 * `docker ps` prints 'sha256:<64hex>', and comparing the two forms is how a
 * still-in-use image gets deleted anyway.
 */
async function pruneOldPulledImages(slug, keep) {
  const app = getDb()
    .prepare('SELECT source_type, image_ref FROM apps WHERE slug = ?')
    .get(slug);
  if (!app || app.source_type !== 'image' || !app.image_ref) return;

  const { parseImageRef } = await import('./imageSource.js');
  const { registry, name } = parseImageRef(app.image_ref);
  const repo = registry ? `${registry}/${name}` : name;

  const listed = await dockerExec(['images', repo, '--no-trunc', '--format', '{{.ID}} {{.CreatedAt}}']);
  if (!listed) return;

  const psOut = await dockerExec(['ps', '-a', '--no-trunc', '--format', '{{.ImageID}}']).catch(() => '');
  const inUse = new Set(psOut.split('\n').map(l => l.trim()).filter(Boolean));

  const rows = [];
  const seen = new Set();
  for (const line of listed.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 1) continue;
    const id = line.slice(0, sp);
    // One row per TAG, so a multi-tagged image appears several times. Counting
    // it twice would make `keep` retain fewer distinct images than asked.
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, created: line.slice(sp + 1) });
  }
  rows.sort((a, b) => b.created.localeCompare(a.created));

  for (const row of rows.slice(keep)) {
    if (inUse.has(row.id)) continue;
    try { await dockerExec(['rmi', '-f', row.id]); } catch (e) {}
  }
}

// Reclaim dangling/untagged images left behind by failed or interrupted builds.
// Safe by default — `docker image prune -f` only removes images with no tags
// AND no descendant tagged images, never touches anything in use by a container.
export async function pruneDanglingImages() {
  try { await dockerExec(['image', 'prune', '-f']); } catch (e) {}
}

export async function dockerAvailable() {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}
