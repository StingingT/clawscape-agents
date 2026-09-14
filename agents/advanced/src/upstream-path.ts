import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_UPSTREAM_FILES = [
  'sdk/pathfinding.ts',
  'sdk/collision-data.json',
  'server/vendor/rsmod-pathfinder/rsmod-pathfinder.js',
] as const;
export type UpstreamOptions = { runtimeRoot?: string; gameRoot?: string; configFile?: string; env?: Record<string, string | undefined> };
export type UpstreamLocation = { upstream: string; source: 'CLAWSCAPE_UPSTREAM' | 'game_root'; configFile?: string };
export class UpstreamPathError extends Error {
  readonly code: string;
  readonly missingFiles: string[];
  constructor(code: string, missingFiles: string[] = []) {
    super(code); this.name = 'UpstreamPathError'; this.code = code; this.missingFiles = missingFiles;
  }
}
const isFile = (file: string) => { try { return statSync(file).isFile(); } catch { return false; } };
const checkedPath = (value: unknown, failure: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /^(?:https?|file):/i.test(value))
    throw new UpstreamPathError(failure);
  return value;
};

/** Resolve the LOCAL server checkout, never fetch or execute anything from a URL.
 * No cwd-dependent guess or fallback to a different map when an explicit path is wrong. */
export function resolveUpstream(options: UpstreamOptions = {}): UpstreamLocation {
  const runtimeRoot = resolve(options.runtimeRoot ?? fileURLToPath(new URL('../', import.meta.url)));
  const env = options.env ?? process.env;
  let location: UpstreamLocation;
  if (env.CLAWSCAPE_UPSTREAM !== undefined) {
    const value = checkedPath(env.CLAWSCAPE_UPSTREAM, 'UPSTREAM_OVERRIDE_INVALID');
    location = { upstream: resolve(runtimeRoot, value), source: 'CLAWSCAPE_UPSTREAM' };
  } else if (options.gameRoot !== undefined) {
    const value = checkedPath(options.gameRoot, 'ASTRA_GAME_ROOT_INVALID');
    location = { upstream: resolve(runtimeRoot, value), source: 'game_root' };
  } else {
    const configFile = resolve(runtimeRoot, options.configFile
      ?? env.CLAWSCAPE_ASTRA_CONFIG ?? 'config.local.json');
    if (!existsSync(configFile)) throw new UpstreamPathError('ASTRA_CONFIG_FILE_MISSING');
    let config: unknown;
    try { config = JSON.parse(readFileSync(configFile, 'utf8')); }
    catch { throw new UpstreamPathError('ASTRA_CONFIG_FILE_INVALID'); }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new UpstreamPathError('ASTRA_CONFIG_FILE_INVALID');
    const gameRoot = checkedPath((config as Record<string, unknown>).game_root, 'ASTRA_GAME_ROOT_INVALID');
    location = { upstream: resolve(runtimeRoot, gameRoot), source: 'game_root', configFile };
  }
  const missing = REQUIRED_UPSTREAM_FILES.filter(file => !isFile(join(location.upstream, file)));
  if (missing.length) throw new UpstreamPathError('UPSTREAM_COLLISION_FILES_MISSING', [...missing]);
  return location;
}

/** Redact arbitrary filesystem exceptions and configuration contents. */
export function safePathFailure(error: unknown): { code: string; missingFiles?: string[] } {
  return error instanceof UpstreamPathError
    ? { code: error.code, ...(error.missingFiles.length ? { missingFiles: error.missingFiles } : {}) }
    : { code: 'UPSTREAM_PATH_CHECK_FAILED' };
}
