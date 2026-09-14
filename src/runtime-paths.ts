import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RuntimePaths = { codeRoot:string; repoRoot:string; home:string; data:string; config:string; profile:string; source:'explicit'|'packaged'|'legacy' };
export function runtimePaths(codeRoot:string, args:string[]=[], env:NodeJS.ProcessEnv=process.env):RuntimePaths {
  const repoRoot=resolve(codeRoot,'../..');
  const option=(key:string)=>{const n=args.indexOf('--'+key);return n<0?undefined:args[n+1];};
  const explicit=option('runtime-root')??env.CLAWSCAPE_ASTRA_HOME;
  const old=resolve(repoRoot,'../clawscape-autonomous-agent');
  const configOption=option('config');
  const home=explicit?resolve(explicit):configOption?dirname(resolve(codeRoot,configOption)):existsSync(resolve(codeRoot,'config.local.json'))?resolve(codeRoot)
    :existsSync(resolve(old,'config.local.json'))?old:resolve(codeRoot);
  return { codeRoot:resolve(codeRoot),repoRoot,home,
    data:resolve(home,option('data-dir')??env.CLAWSCAPE_ASTRA_DATA??'data/astra-live'),
    config:configOption?resolve(codeRoot,configOption):resolve(home,'config.local.json'),
    profile:resolve(home,option('profile-file')??env.CLAWSCAPE_ASTRA_PROFILE??'docs/compatibility-profile.json'),
    source:explicit||configOption?'explicit':home===old?'legacy':'packaged' };
}
/** Explicit configuration wins; never ignore an invalid configured checkout. */
export function upstreamRoot(env:NodeJS.ProcessEnv=process.env, repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')):string {
  if(env.CLAWSCAPE_UPSTREAM)return resolve(env.CLAWSCAPE_UPSTREAM);
  const candidates=[
    ...(env.CLAWSCAPE_ASTRA_HOME?[resolve(env.CLAWSCAPE_ASTRA_HOME,'tmp/clawscape/upstream')]:[]),
    resolve(repoRoot,'tmp/clawscape/upstream'),resolve(repoRoot,'../tmp/clawscape/upstream'),
  ];
  return candidates.find(p=>existsSync(resolve(p,'sdk/pathfinding.ts')))??candidates[0]!;
}
