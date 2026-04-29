import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SUPPORTED_NODE = new Set(['18', '20', '22']);
const DEFAULT_NODE = '20';

function pickNodeVersion(manifest) {
  const v = String(manifest?.node_version || manifest?.engines?.node || '').replace(/[^\d]/g, '').slice(0, 2);
  return SUPPORTED_NODE.has(v) ? v : DEFAULT_NODE;
}

function detectEntry(manifest, releaseDir) {
  if (manifest?.be?.entry) return manifest.be.entry;
  if (manifest?.start?.backend) return manifest.start.backend;
  const pkgPath = join(releaseDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.start) return 'npm start';
      if (pkg.main) return `node ${pkg.main}`;
    } catch (_) {}
  }
  return 'node server.js';
}

function detectBuild(manifest, releaseDir) {
  const fromManifest = manifest?.fe?.build || manifest?.build?.frontend;
  if (fromManifest) return fromManifest;
  const pkgPath = join(releaseDir, 'package.json');
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

/**
 * Generate a Dockerfile into releaseDir, overwriting any user-provided one.
 * Uses Node {version} Alpine, runs as non-root `node` user (UID 1000),
 * runs build step at image build time if manifest declares one.
 */
export function ensureDockerfile({ releaseDir, manifest, appBasePath, craneUrl, craneInternalUrl }) {
  const existing = join(releaseDir, 'Dockerfile');
  const node = pickNodeVersion(manifest);
  const entry = detectEntry(manifest, releaseDir);
  const buildCmd = detectBuild(manifest, releaseDir);
  const cmd = entryToCmd(entry);

  const lines = [
    `FROM node:${node}-alpine`,
    '',
    'RUN apk add --no-cache tini',
    '',
    'WORKDIR /app',
    '',
    'COPY package*.json ./',
    '',
    'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi',
    '',
    'COPY . .',
    '',
  ];

  if (buildCmd) {
    lines.push(
      `ENV APP_BASE_PATH="${appBasePath}"`,
      `ENV PUBLIC_URL="${appBasePath}"`,
      `ENV VITE_BASE_PATH="${appBasePath}"`,
      `ENV CRANE_URL="${craneUrl}"`,
      `ENV CRANE_INTERNAL_URL="${craneInternalUrl}"`,
      'ENV NODE_ENV=production',
      'ENV CI=true',
      `RUN ${buildCmd}`,
      '',
    );
  }

  lines.push(
    'RUN chown -R node:node /app',
    'USER node',
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
