import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import log from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const CONTAINER_PORT = 3000;
const APPCRANE_LABEL = 'appcrane=true';

async function dockerExec(args, opts = {}) {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      timeout: 60000,
      ...opts,
    });
    return stdout.trim();
  } catch (e) {
    const output = e.stdout?.toString() || e.stderr?.toString() || e.message;
    log.debug(`docker ${args[0]} failed: ${output}`);
    throw new Error(output);
  }
}

function containerName(slug, env) {
  return `appcrane-${slug}-${env}`;
}

function imageTag(slug, env, commitHash) {
  const raw = commitHash && commitHash !== 'unknown' ? commitHash : `t${Date.now()}`;
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  // Must be env-scoped: Vite/other bundlers bake APP_BASE_PATH into the artifact
  // at build time, so sandbox (/<slug>-sandbox/) and production (/<slug>/) MUST
  // have different images even when built from the same commit.
  return `appcrane-${slug}-${env}:${safe}`;
}

export async function buildImageIfNeeded({ slug, env, contextDir, commitHash, onLog }) {
  const tag = imageTag(slug, env, commitHash);
  if (commitHash && commitHash !== 'unknown') {
    try {
      await dockerExec(['image', 'inspect', tag, '--format', '{{.Id}}'], { timeout: 5000 });
      onLog?.(`Using cached image: ${tag} (skipping rebuild)`);
      return tag;
    } catch (_) {}
  }
  return buildImage({ slug, env, contextDir, commitHash, onLog });
}

export async function getContainerImage(slug, env) {
  const name = containerName(slug, env);
  return dockerExec(['inspect', name, '--format', '{{.Config.Image}}'], { timeout: 5000 });
}

export async function buildImage({ slug, env, contextDir, commitHash, onLog }) {
  const tag = imageTag(slug, env, commitHash);
  const args = ['build', '-t', tag, '--label', APPCRANE_LABEL, '--label', `slug=${slug}`, '--label', `env=${env}`, contextDir];

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'pipe' });
    let stderrBuf = '';

    const emit = (line) => { if (line.trim()) onLog?.(line); };
    child.stdout.on('data', (c) => c.toString().split('\n').forEach(emit));
    child.stderr.on('data', (c) => {
      const s = c.toString();
      stderrBuf += s;
      s.split('\n').forEach(emit);
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('docker build timed out after 10 minutes'));
    }, 600000);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`docker build failed: ${stderrBuf.slice(-400)}`));
      resolve(tag);
    });
  });
}

export async function startApp({ slug, env, image, hostPort, envVars = {}, volumes = [], memoryMb = 512, cpus = 0.5 }) {
  const name = containerName(slug, env);

  await stopApp(slug, env).catch(() => {});

  const args = [
    'run', '-d',
    '--name', name,
    '--label', APPCRANE_LABEL,
    '--label', `slug=${slug}`,
    '--label', `env=${env}`,
    '--restart=on-failure:5',
    `--memory=${memoryMb}m`,
    `--cpus=${cpus}`,
    '-p', `127.0.0.1:${hostPort}:${CONTAINER_PORT}`,
    '--log-opt', 'max-size=10m',
    '--log-opt', 'max-file=3',
  ];

  for (const vol of volumes) {
    args.push('-v', `${vol.host}:${vol.container}`);
  }

  const runtimeEnv = {
    ...envVars,
    PORT: String(CONTAINER_PORT),
    NODE_ENV: env === 'production' ? 'production' : 'development',
    DATA_DIR: '/data',  // platform guarantee — every app container has /data mounted
  };
  for (const [k, v] of Object.entries(runtimeEnv)) {
    args.push('-e', `${k}=${v}`);
  }

  args.push(image);
  const id = await dockerExec(args);
  log.info(`docker started: ${name} (${id.slice(0, 12)}) from ${image}`);
  return id;
}

export async function stopApp(slug, env) {
  const name = containerName(slug, env);
  try { await dockerExec(['stop', name], { timeout: 15000 }); } catch (e) {}
  try { await dockerExec(['rm', '-f', name]); } catch (e) {}
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

export async function pruneOldImages(slug, env, keep = 2) {
  try {
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
  } catch (e) {}
}

export async function dockerAvailable() {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}
