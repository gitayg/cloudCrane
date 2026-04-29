import { execFileSync, spawnSync } from 'child_process';
import log from '../utils/logger.js';

const CONTAINER_PORT = 3000;
const APPCRANE_LABEL = 'appcrane=true';

function dockerExec(args, opts = {}) {
  try {
    return execFileSync('docker', args, {
      timeout: 60000,
      stdio: 'pipe',
      ...opts,
    }).toString().trim();
  } catch (e) {
    const output = e.stdout?.toString() || e.stderr?.toString() || e.message;
    log.debug(`docker ${args[0]} failed: ${output}`);
    throw new Error(output);
  }
}

function containerName(slug, env) {
  return `appcrane-${slug}-${env}`;
}

function imageTag(slug, commitHash) {
  const tag = commitHash && commitHash !== 'unknown' ? commitHash : `t${Date.now()}`;
  return `appcrane-${slug}:${tag}`;
}

export function buildImage({ slug, contextDir, commitHash, onLog }) {
  const tag = imageTag(slug, commitHash);
  const args = ['build', '-t', tag, '--label', APPCRANE_LABEL, '--label', `slug=${slug}`, contextDir];
  const result = spawnSync('docker', args, { stdio: 'pipe', timeout: 600000 });
  const stdout = result.stdout?.toString() || '';
  const stderr = result.stderr?.toString() || '';
  if (onLog) {
    for (const line of (stdout + stderr).split('\n')) {
      if (line.trim()) onLog(line);
    }
  }
  if (result.status !== 0) {
    throw new Error(`docker build failed: ${stderr.slice(-400) || stdout.slice(-400)}`);
  }
  return tag;
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
  };
  for (const [k, v] of Object.entries(runtimeEnv)) {
    args.push('-e', `${k}=${v}`);
  }

  args.push(image);
  const id = dockerExec(args);
  log.info(`docker started: ${name} (${id.slice(0, 12)}) from ${image}`);
  return id;
}

export async function stopApp(slug, env) {
  const name = containerName(slug, env);
  try { dockerExec(['stop', name], { timeout: 15000 }); } catch (e) {}
  try { dockerExec(['rm', '-f', name]); } catch (e) {}
  log.debug(`docker stopped: ${name}`);
}

export async function restartApp(slug, env) {
  const name = containerName(slug, env);
  try {
    dockerExec(['restart', name], { timeout: 20000 });
    log.info(`docker restarted: ${name}`);
  } catch (e) {
    log.warn(`docker restart ${name} failed: ${e.message}`);
    throw e;
  }
}

export async function getProcessMetrics(slug, env) {
  const name = containerName(slug, env);
  try {
    const inspectOut = dockerExec(['inspect', name, '--format', '{{.State.Status}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.RestartCount}}']);
    const [status, pid, startedAt, restarts] = inspectOut.split('|');
    if (status !== 'running') return { status, cpu: 0, memory: 0, pid: Number(pid) || 0, uptime: 0, restarts: Number(restarts) || 0 };
    const statsOut = dockerExec(['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', name]);
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

export async function getAppLogs(slug, env, lines = 100) {
  const name = containerName(slug, env);
  try {
    const output = dockerExec(['logs', '--tail', String(lines), name]);
    return output.split('\n');
  } catch (e) {
    return [];
  }
}

export async function listAll() {
  try {
    const format = '{{.Names}}|{{.Label "slug"}}|{{.Label "env"}}|{{.Status}}|{{.ID}}';
    const output = dockerExec(['ps', '-a', '--filter', `label=${APPCRANE_LABEL}`, '--format', format]);
    if (!output) return [];
    return output.split('\n').map(line => {
      const [name, slug, env, status, id] = line.split('|');
      return { name, slug, env, status, id };
    });
  } catch (e) {
    return [];
  }
}

export function pruneOldImages(slug, keep = 2) {
  try {
    const out = dockerExec(['images', '--filter', `label=slug=${slug}`, '--format', '{{.ID}} {{.CreatedAt}}']);
    if (!out) return;
    const rows = out.split('\n').map(l => {
      const sp = l.indexOf(' ');
      return { id: l.slice(0, sp), created: l.slice(sp + 1) };
    });
    rows.sort((a, b) => b.created.localeCompare(a.created));
    for (const row of rows.slice(keep)) {
      try { dockerExec(['rmi', '-f', row.id]); } catch (e) {}
    }
  } catch (e) {}
}

export function dockerAvailable() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch (e) {
    return false;
  }
}
