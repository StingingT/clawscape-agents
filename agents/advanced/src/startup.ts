import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runtimePaths, upstreamRoot, type RuntimePaths } from '../../../src/runtime-paths.ts';

export type StartupIssue={code:string;resource?:string;hint:string;retryable:boolean};
export function describeFailure(error:unknown, stage:string):StartupIssue {
  const e=error as {code?:string;message?:string};
  // Never log raw configuration, subprocess output, auth values or arbitrary exception messages.
  const message=String(e?.message??'');
  if(/(?:cannot find|not found|resolve).*zod/i.test(message))return {code:'MISSING_DEPENDENCY',resource:'zod',hint:'Install the pinned dependencies in agents/advanced.',retryable:false};
  const constant=/^[A-Z][A-Z0-9_]{2,100}$/.test(message)?message:undefined;
  return {code:constant??(['ENOENT','EACCES','EPERM'].includes(e?.code??'')?String(e.code):'ASTRA_STARTUP_FAILED'),
    resource:stage,hint:constant?.includes('RECONCIL')?'Reconcile the exact pending command; do not delete the journal.':'Run the Astra doctor command; check the reported resource and existing local configuration.',retryable:false};
}
function readJson(path:string,label:string,issues:StartupIssue[]):any {
  try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){issues.push({code:existsSync(path)?'INVALID_LOCAL_JSON':'MISSING_LOCAL_FILE',resource:label,hint:`Provide the existing local ${label}; do not create an empty replacement.`,retryable:false});return;}
}
export function inspectRuntime(paths:RuntimePaths):StartupIssue[] {
  const issues:StartupIssue[]=[];
  const config=readJson(paths.config,'config.local.json',issues);
  readJson(paths.profile,'compatibility-profile.json',issues);
  if(config){
    if(config.character!=='astra')issues.push({code:'ASTRA_ONLY',hint:'Use Astra\'s original character configuration.',retryable:false});
    if(typeof config.cli_home!=='string'||!config.cli_home.trim())issues.push({code:'CLI_HOME_REQUIRED',hint:'Set cli_home to the existing authenticated CLI home.',retryable:false});
    else if(!existsSync(resolve(paths.home,config.cli_home,'config.jsonl')))issues.push({code:'CLI_HOME_NOT_FOUND',resource:'cli_home/config.jsonl',hint:'Fix cli_home relative to the selected runtime root. Do not copy credentials into Git.',retryable:false});
  }
  const upstream=upstreamRoot({...process.env,CLAWSCAPE_ASTRA_HOME:paths.home},paths.repoRoot);
  for(const file of ['sdk/pathfinding.ts','sdk/collision-data.json','server/vendor/rsmod-pathfinder/rsmod-pathfinder.js'])
    if(!existsSync(resolve(upstream,file)))issues.push({code:'UPSTREAM_FILE_MISSING',resource:file,hint:'Set CLAWSCAPE_UPSTREAM to the complete matching server checkout.',retryable:false});
  return issues;
}
export function publishStartup(paths:RuntimePaths, value:Record<string,unknown>):void {
  const document={character:'astra',pid:process.pid,time:new Date().toISOString(),runtimeRoot:paths.home,dataDirectory:paths.data,upstream:upstreamRoot({...process.env,CLAWSCAPE_ASTRA_HOME:paths.home},paths.repoRoot),source:paths.source,...value};
  // Fixed supervisor pointer also works when state lives in the original sibling project.
  for(const file of [resolve(paths.repoRoot,'data/supervisor/astra-startup.json'),resolve(paths.data,'startup-status.json')]){
    mkdirSync(dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';
    writeFileSync(tmp,JSON.stringify(document,null,2)+'\n',{mode:0o600});renameSync(tmp,file);
  }
}
/** Small dependency-light entry point: even module-loading failures publish a diagnosable status. */
export async function runAstra(args=process.argv.slice(2), load:()=>Promise<{main:()=>Promise<void>}>=()=>import(new URL('./live-cli.ts',import.meta.url).href)):Promise<void> {
  const paths=runtimePaths(fileURLToPath(new URL('../',import.meta.url)),args);
  const mode=args[0]??'status';
  let stage='runtime-paths';
  try{
    process.env.CLAWSCAPE_ASTRA_HOME=paths.home;
    if(mode==='doctor'){
      console.log(JSON.stringify({character:'astra',runtimeRoot:paths.home,dataDirectory:paths.data,upstream:upstreamRoot({...process.env,CLAWSCAPE_ASTRA_HOME:paths.home},paths.repoRoot),issues:inspectRuntime(paths),gameCommands:0},null,2));
      return;
    }
    publishStartup(paths,{status:'STARTING',stage});
    // Status and pause controls must remain usable even when game files are absent.
    if(['run','pilot','setup','observe','reconcile','recover'].includes(mode)){
      stage='preflight';const issues=inspectRuntime(paths);
      if(issues.length){publishStartup(paths,{status:'BLOCKED_CONFIGURATION',stage,reason:issues[0]!.code,issues,retryable:false});process.exitCode=1;return;}
    }
    stage='module-loading';const entry=await load();
    stage='controller';await entry.main();
    publishStartup(paths,{status:process.exitCode?'STOPPED_WITH_ERROR':'STOPPED',stage});
  }catch(error){const issue=describeFailure(error,stage);publishStartup(paths,{status:'STARTUP_FAILED',stage,reason:issue.code,issues:[issue],retryable:issue.retryable});console.error(JSON.stringify({character:'astra',stage,...issue}));process.exitCode=1;}
}
