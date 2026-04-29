import { readFileSync } from 'fs';
import { join } from 'path';

const FORBIDDEN_ENV_PATTERNS = [
  /ENV\s+\w*(SECRET|PASSWORD|PASS|TOKEN|KEY|CRED|AUTH)\w*\s*=/i,
];

/**
 * Validate a user-provided Dockerfile.
 * Returns { valid: true } or { valid: false, errors: [...], warnings: [...] }
 *
 * Rules:
 *  - Must EXPOSE a port (must match expectedPort if provided)
 *  - Must not end with USER root
 *  - Must not hardcode secrets in ENV instructions
 *  - Must not override managed env vars (APP_BASE_PATH, CRANE_URL, DATA_DIR)
 *  - Must not bind-mount or reference /data in VOLUME (AppCrane manages that)
 */
export function validateDockerfile(releaseDir, { expectedPort } = {}) {
  const path = join(releaseDir, 'Dockerfile');
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (_) {
    return { valid: false, errors: ['Dockerfile not found'], warnings: [] };
  }

  const errors = [];
  const warnings = [];
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

  // --- EXPOSE check ---
  const exposePorts = [];
  for (const line of lines) {
    const m = line.match(/^EXPOSE\s+(\d+)/i);
    if (m) exposePorts.push(parseInt(m[1], 10));
  }
  if (!exposePorts.length) {
    errors.push('Dockerfile must include an EXPOSE instruction (e.g. EXPOSE 3000)');
  } else if (expectedPort && !exposePorts.includes(expectedPort)) {
    errors.push(`Dockerfile EXPOSE ${exposePorts.join(',')} does not match expected port ${expectedPort} from crane.yaml`);
  }

  // --- USER root at end ---
  // Find last USER instruction
  const userInstructions = lines.filter(l => /^USER\s+/i.test(l));
  const lastUser = userInstructions[userInstructions.length - 1];
  if (lastUser && /^USER\s+root$/i.test(lastUser)) {
    errors.push('Container must not run as root. Add "USER <non-root-user>" after your setup steps.');
  }

  // --- Hardcoded secrets ---
  for (const line of lines) {
    for (const pattern of FORBIDDEN_ENV_PATTERNS) {
      if (pattern.test(line)) {
        errors.push(`Do not hardcode secrets in Dockerfile ENV: "${line.slice(0, 80)}". Use AppCrane env vars instead.`);
        break;
      }
    }
  }

  // --- Managed env vars override ---
  const MANAGED_VARS = ['APP_BASE_PATH', 'CRANE_URL', 'CRANE_INTERNAL_URL', 'DATA_DIR'];
  for (const line of lines) {
    if (!/^ENV\s+/i.test(line)) continue;
    for (const v of MANAGED_VARS) {
      if (line.includes(v)) {
        warnings.push(`ENV ${v} is managed by AppCrane at runtime — your Dockerfile value will be overridden.`);
      }
    }
  }

  // --- VOLUME /data ---
  for (const line of lines) {
    if (/^VOLUME\b/i.test(line) && line.includes('/data')) {
      warnings.push('VOLUME /data is managed by AppCrane. Your VOLUME instruction may conflict with the mounted data directory.');
    }
  }

  // --- FROM must exist ---
  const hasFrom = lines.some(l => /^FROM\s+/i.test(l));
  if (!hasFrom) {
    errors.push('Dockerfile must start with a FROM instruction.');
  }

  return { valid: errors.length === 0, errors, warnings };
}
