import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUpstream, safePathFailure, REQUIRED_UPSTREAM_FILES } from '../agents/advanced/src/upstream-path.ts';
import { runtimeHome } from '../agents/advanced/src/startup.ts';

// Read-only: no game adapter, database, startup-status publisher or network client.
const codeRoot = resolve(fileURLToPath(new URL('../agents/advanced/', import.meta.url)));
const args = process.argv.slice(2);
let exit = 0;
const report: Record<string, unknown> = { character: 'astra', check: 'local-path-preflight', gameConnectionAttempted: false };
try {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--config', '--runtime-root'].includes(key) || options.has(key) || !value?.trim() || value.startsWith('--'))
      throw new Error('INVALID_ARGUMENTS');
    options.set(key, value);
  }
  // Same runtime-home selection as live-entry.ts; do not invent a fresh empty home.
  const root = runtimeHome(codeRoot, args);
  report.runtimeRoot = root;
  const selectedConfig = resolve(root, options.get('--config') ?? 'config.local.json');
  // Even with a map override, the live controller still requires its configuration.
  let config: unknown;
  try { config = JSON.parse(readFileSync(selectedConfig, 'utf8')); }
  catch { report.config = { existsAndParses: false }; throw new Error('CONFIG_NOT_READABLE'); }
  const isObject = !!config && typeof config === 'object' && !Array.isArray(config);
  report.config = { existsAndParses: isObject, schemaValidated: false };
  if (!isObject) throw new Error('CONFIG_NOT_READABLE');
  let profile: unknown;
  try { profile = JSON.parse(readFileSync(resolve(root, 'docs/compatibility-profile.json'), 'utf8')); }
  catch { report.compatibilityProfile = { existsAndParses: false }; throw new Error('PROFILE_NOT_READABLE'); }
  report.compatibilityProfile = { existsAndParses: !!profile && typeof profile === 'object' && !Array.isArray(profile), schemaValidated: false };
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('PROFILE_NOT_READABLE');
  const location = resolveUpstream({ runtimeRoot: root, configFile: selectedConfig });
  report.upstream = location.upstream;
  report.pathSource = location.source;
  report.files = REQUIRED_UPSTREAM_FILES.map(file => ({ file, exists: statSync(resolve(location.upstream, file)).isFile() }));
  report.pathChecksPassed = true;
  report.note = 'Local path checks passed. This does not validate credentials, journal recovery, server compatibility, or a live login.';
} catch (error) {
  exit = 2;
  report.pathChecksPassed = false;
  const message = error instanceof Error ? error.message : '';
  report.failure = ['CONFIG_NOT_READABLE','PROFILE_NOT_READABLE','INVALID_ARGUMENTS','AMBIGUOUS_ASTRA_RUNTIME_HOME','RUNTIME_ROOT_ARGUMENT_REQUIRED'].includes(message)
    ? { code: message } : safePathFailure(error);
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = exit;
