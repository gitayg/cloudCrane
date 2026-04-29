import { resolve, sep } from 'path';

/**
 * Resolve a path and assert it stays within base.
 * Throws if the resolved path escapes the base directory.
 */
export function resolveSafe(base, ...parts) {
  const resolvedBase = resolve(base);
  const resolved = resolve(base, ...parts);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
    throw new Error(`Path traversal attempt detected: ${resolved}`);
  }
  return resolved;
}
