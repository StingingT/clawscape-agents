import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveUpstream } from './upstream-path.ts';

export type StartupContext = {
  root: string; data: string; codeRoot: string; startedAt: number;
  publish: (status: string, reason: string, extra?: Record<string, unknown>) => void;
};
const json = (path: string) => JSON.parse(readFileSync(path,'utf8'));
const durable = (root: string) => ['journal.sqlite','agency-v2.json','agency-memory.json'].some(name => existsSync(join(root,'data/astra-live',name)));

/** Use ONE runtime home for config, authentication-relative paths, journals and status.
 * Do not manufacture a fresh identity by copying only part of the old runtime. */
export function runtimeHome(codeRoot: string, argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const index = argv.indexOf('--runtime-root');
  if (index >= 0 && (!argv[index+1] || argv[index+1]!.startsWith('--'))) throw new Error('RUNTIME_ROOT_ARGUMENT_REQUIRED');
  const explicit = index >= 0 ? argv[index+1] : env.CLAWSCAPE_ASTRA_HOME;
  if (explicit) return resolve(explicit);
  const legacy = resolve(codeRoot,'../../../clawscape-autonomous-agent');
  const here = existsSync(join(codeRoot,'config.local.json'));
  const old = existsSync(join(legacy,'config.local.json'));
  if (old && (here || durable(codeRoot))) throw new Error('AMBIGUOUS_ASTRA_RUNTIME_HOME');
  if (old) return legacy;
  return codeRoot;
}
export function startupFailure(error: unknown): { reason: string; retryable: boolean } {
  const e = error as { message?: string; code?: string };
  const message = String(e?.message ?? '');
  const match = /^([A-Z][A-Z_0-9]+)(?::|$)/.exec(message);
  let reason = match?.[1];
  if (!reason) {
    if (e?.code === 'ENOENT') reason = 'REQUIRED_RUNTIME_FILE_MISSING';
    else if (e?.code === 'ERR_MODULE_NOT_FOUND' || /cannot find (module|package)|module not found/i.test(message)) reason = 'RUNTIME_DEPENDENCY_MISSING';
    else if (/database.*locked|busy/i.test(message)) reason = 'JOURNAL_BUSY';
    else if (error instanceof SyntaxError) reason = 'INVALID_RUNTIME_JSON';
    else reason = 'ASTRA_STARTUP_OR_RUNTIME_FAILED';
  }
  return { reason, retryable: !/MISSING|INVALID|CORRUPT|LEGACY|RECONCIL|AMBIGUOUS|MISMATCH|REQUIRED|DISABLED|MANUAL|UNSAFE|INCONSISTENT/.test(reason) };
}

/** This wrapper loads only Node built-ins, so even an import/dependency failure gets a status. */
export async function runWithStartupStatus(codeRoot: string, argv: string[], run: (context: StartupContext) => Promise<void>): Promise<void> {
  const startedAt = Date.now(), runId = randomUUID();
  const launcher = join(codeRoot,'data/astra-launcher-status.json');
  let root = codeRoot;
  const publish = (status: string, reason: string, extra: Record<string, unknown> = {}) => {
    const value = { character:'astra', time:new Date().toISOString(), pid:process.pid, runId, startedAt, mode:argv[0] ?? 'status',
      status, reason, live:false, runtimeRoot:root, ...extra };
    for (const file of [launcher, join(root,'data/astra-live/status.json')]) {
      if(existsSync(file)) {
        try { const prior=json(file);if(prior.pid && prior.pid!==process.pid && ['STARTING','RUNNING','RECONCILING'].includes(prior.status)){process.kill(prior.pid,0);continue;} } catch { /* missing/dead owner or old status format */ }
      }
      mkdirSync(resolve(file,'..'),{recursive:true});
      const tmp = file + '.' + runId + '.tmp';
      writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,file);
    }
  };
  try {
    root = runtimeHome(codeRoot,argv);
    // Status/administrative queries must not replace a running controller's telemetry.
    if (!['status','pause','stop','takeover','hard-disable','resume'].includes(argv[0] ?? 'status')) publish('STARTING','Loading Astra runtime');
    await run({root,data:join(root,'data/astra-live'),codeRoot,startedAt,publish});
  } catch (error) {
    const failure = startupFailure(error);
    publish('STARTUP_FAILED',failure.reason,{retryable:failure.retryable});
    // Never print config values, tokens, raw transport errors or an arbitrary stack trace.
    console.error(JSON.stringify({character:'astra',status:'STARTUP_FAILED',...failure,statusFile:join(root,'data/astra-live/status.json')}));
    process.exitCode = failure.retryable ? 1 : 2;
  }
}

export function readRequiredJson(file: string, missing: string, invalid: string): any {
  if (!existsSync(file)) throw new Error(missing);
  try { return json(file); } catch { throw new Error(invalid); }
}
export function checkedUpstream(root: string, gameRoot: string, explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  // Startup and standalone workers validate the same selected checkout. Never
  // silently substitute a different map if an explicit or configured path is bad.
  return resolveUpstream({ runtimeRoot: root, gameRoot,
    env: (explicit ?? env.CLAWSCAPE_UPSTREAM) === undefined ? {} : { CLAWSCAPE_UPSTREAM: explicit ?? env.CLAWSCAPE_UPSTREAM } }).upstream;
}
