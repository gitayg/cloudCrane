import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SUPPORTED_NODE = new Set(['18', '20', '22']);
const DEFAULT_NODE = '20';

function pickNodeVersion(manifest) {
  const v = String(manifest?.node_version || manifest?.engines?.node || '').replace(/[^\d]/g, '').slice(0, 2);
  return SUPPORTED_NODE.has(v) ? v : DEFAULT_NODE;
}

function safeRel(p) {
  // Strip leading slashes / drive letters; reject path traversal.
  const cleaned = String(p || '').replace(/^[/\\]+/, '').trim();
  if (cleaned.includes('..')) throw new Error(`deployhub.json workdir/dist contains "..": ${p}`);
  return cleaned;
}

function detectEntry(manifest, releaseDir, beWorkdir) {
  if (manifest?.be?.entry) return manifest.be.entry;
  if (manifest?.start?.backend) return manifest.start.backend;
  const pkgPath = beWorkdir
    ? join(releaseDir, beWorkdir, 'package.json')
    : join(releaseDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.start) return 'npm start';
      if (pkg.main) return `node ${pkg.main}`;
    } catch (_) {}
  }
  return 'node server.js';
}

function detectBuild(manifest, releaseDir, feWorkdir) {
  const fromManifest = manifest?.fe?.build || manifest?.build?.frontend;
  if (fromManifest) return fromManifest;
  const pkgPath = feWorkdir
    ? join(releaseDir, feWorkdir, 'package.json')
    : join(releaseDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.build) return 'npm run build';
    } catch (_) {}
  }
  return null;
}

function entryToCmd(entry) {
  const trimmed = entry.trim();
  if (/[;&|<>]/.test(trimmed)) {
    return `["sh", "-c", ${JSON.stringify(trimmed)}]`;
  }
  return JSON.stringify(trimmed.split(/\s+/));
}

function defaultInstall() {
  // npm ci if a lockfile exists, else npm install. Stay --omit=dev.
  return `if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi`;
}

/**
 * Generate a Dockerfile into releaseDir, overwriting any user-provided one.
 * Uses Node {version} Alpine, runs as non-root `node` user (UID 1000),
 * runs build step at image build time if manifest declares one.
 *
 * Monorepo support (Option 2):
 *   manifest.be = { workdir, install, entry }
 *   manifest.fe = { workdir, install, build, dist }
 * If be.workdir is set, npm install runs there and the container CWD is /app/<workdir>.
 * If fe.workdir is set, npm install + build run there independently.
 * Apps without these fields use the existing flat-layout build (unchanged).
 */
export function ensureDockerfile({ releaseDir, manifest, appBasePath, craneUrl, craneInternalUrl }) {
  const existing = join(releaseDir, 'Dockerfile'); // nosemgrep: path-join-resolve-traversal — releaseDir is an internal computed path

  // If the app ships its own Dockerfile, use it as-is.
  if (existsSync(existing)) {
    return { path: existing, userProvided: true };
  }

  const node = pickNodeVersion(manifest);

  const beWorkdir = manifest?.be?.workdir ? safeRel(manifest.be.workdir) : null;
  const feWorkdir = manifest?.fe?.workdir ? safeRel(manifest.fe.workdir) : null;
  const beInstall = manifest?.be?.install || defaultInstall();
  const feInstall = manifest?.fe?.install || defaultInstall();

  const entry = detectEntry(manifest, releaseDir, beWorkdir);
  const buildCmd = detectBuild(manifest, releaseDir, feWorkdir);
  const cmd = entryToCmd(entry);

  const lines = [
    `FROM node:${node}-alpine`,
    '',
    'RUN apk add --no-cache tini',
    '',
    'WORKDIR /app',
    '',
  ];

  if (beWorkdir || feWorkdir) {
    // Monorepo path — install per workdir for cache efficiency, then COPY everything.
    if (beWorkdir) {
      lines.push(
        `# Backend deps (${beWorkdir})`,
        `COPY ${beWorkdir}/package*.json ./${beWorkdir}/`,
        `RUN cd ${beWorkdir} && ${beInstall}`,
        '',
      );
    } else {
      // Root has its own package.json (e.g. workspaces); install at root
      lines.push(
        'COPY package*.json ./',
        `RUN ${defaultInstall()}`,
        '',
      );
    }
    if (feWorkdir && feWorkdir !== beWorkdir) {
      lines.push(
        `# Frontend deps (${feWorkdir}) — devDeps included for build`,
        `COPY ${feWorkdir}/package*.json ./${feWorkdir}/`,
        `RUN cd ${feWorkdir} && ${feInstall.replace(/--omit=dev/g, '').trim()}`,
        '',
      );
    }
    lines.push('COPY . .', '');
  } else {
    // Flat-layout (unchanged from previous releases)
    lines.push(
      'COPY package*.json ./',
      `RUN ${defaultInstall()}`,
      '',
      'COPY . .',
      '',
    );
  }

  if (buildCmd) {
    const buildDir = feWorkdir || '.';
    lines.push(
      `ENV APP_BASE_PATH="${appBasePath}"`,
      `ENV PUBLIC_URL="${appBasePath}"`,
      `ENV VITE_BASE_PATH="${appBasePath}"`,
      `ENV CRANE_URL="${craneUrl}"`,
      `ENV CRANE_INTERNAL_URL="${craneInternalUrl}"`,
      'ENV NODE_ENV=production',
      'ENV CI=true',
      buildDir === '.' ? `RUN ${buildCmd}` : `RUN cd ${buildDir} && ${buildCmd}`,
      '',
    );
  }

  const runWorkdir = beWorkdir ? `/app/${beWorkdir}` : '/app';

  lines.push(
    'RUN chown -R node:node /app',
    'USER node',
    '',
    `WORKDIR ${runWorkdir}`,
    '',
    'EXPOSE 3000',
    '',
    'ENTRYPOINT ["/sbin/tini", "--"]',
    `CMD ${cmd}`,
    '',
  );

  writeFileSync(existing, lines.join('\n'));
  return { path: existing };
}
