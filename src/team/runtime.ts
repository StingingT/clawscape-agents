import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlDir, readJson, writeJson } from './storage.ts';

export const CONTROL_VERSION = 'novelty-feedback-20260919.9.2';
export const RUNTIME_SOURCES = ['scripts/team.ts', 'src/team/manager.ts', 'src/team/herdr.ts', 'src/team/panel-lifecycle.ts', 'src/team/runtime.ts','src/team/protocol.ts','src/team/worker.ts','src/team/approvals.ts','src/team/escalation.ts','src/team/presentation.ts','src/team/models.ts','src/team/local-diagnostics.ts'];
export function installedRuntime(root: string) {
  const hash = createHash('sha256');
  for (const file of RUNTIME_SOURCES) hash.update(file+'\0'+readFileSync(join(root,file),'utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n')+'\0');
  return {version:CONTROL_VERSION,sourceHash:hash.digest('hex')};
}
/** Hash the source an individual worker loads.  This is intentionally broader
 * than an import graph: a panel must never claim a worker has hot-reloaded when
 * any controller/agency/navigation source was edited after its launch. */
export function installedWorkerRuntime(root:string,agent:string) {
  const directories=['src',...(agent==='astra'?['agents/advanced/src']:[])];
  const files:string[]=[];
  const visit=(dir:string)=>{
    if(!existsSync(dir))return;
    if(!statSync(dir).isDirectory())return;
    for(const entry of readdirSync(dir,{withFileTypes:true})) {
      const full=join(dir,entry.name);
      if(entry.isDirectory())visit(full);
      else if(entry.isFile()&&entry.name.endsWith('.ts'))files.push(relative(root,full).replace(/\\/g,'/'));
    }
  };
  for(const directory of directories)visit(join(root,directory));
  const hash=createHash('sha256');
  for(const file of files.sort())hash.update(file+'\0'+readFileSync(join(root,file),'utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n')+'\0');
  return {sourceHash:hash.digest('hex'),files:files.length};
}
// Captured once at module load. Re-reading disk later must not pretend this process hot-reloaded.
const sourceRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const LOADED_RUNTIME = Object.freeze({...installedRuntime(sourceRoot),loadedAt:Date.now()});
export type CloseReason = 'operator-stop-all'|'operator-reload'|'operator-quit'|'operator-exit'|'sigint'|'sigterm'|'input-closed'|'panel-error'|'manager-closed'|'api-close';
export type TraceRecord = {
  at:number; pid:number; session:string; event:string; reason:string;
  version:string; sourceHash:string; stack:string[]; errorCode?:string; agent?:string;
};
export function errorCode(error:unknown):string {
  const e=error as {code?:unknown;name?:unknown};
  return typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code)?e.code
    : typeof e?.name==='string'&&/^[A-Za-z]{1,40}Error$/.test(e.name)?e.name:'UNCLASSIFIED';
}
function sourceFrames(error:unknown):string[] {
  const stack=error instanceof Error?error.stack:undefined;
  // Never store raw error messages, environment variables, local configs or home paths.
  return (stack??'').split('\n').slice(1).flatMap(line=>{
    const match=line.replace(/\\/g,'/').match(/(?:^|\/)((?:src|scripts|tests)\/[\w./-]+:\d+(?::\d+)?)/);
    return match?[match[1]!]:[];
  }).slice(0,10);
}
export class LifecycleTrace {
  readonly file:string; readonly records:TraceRecord[]=[];
  readonly session:string;
  constructor(root:string,session:string) {
    this.session=session;
    if(!/^[0-9a-f-]{36}$/i.test(session))throw new Error('INVALID_TRACE_SESSION');
    this.file=join(controlDir(root),'diagnostics',session+'.json');
  }
  add(event:string,reason:string,error?:unknown,agent?:string):void {
    const record:TraceRecord={at:Date.now(),pid:process.pid,session:this.session,event,reason,
      version:LOADED_RUNTIME.version,sourceHash:LOADED_RUNTIME.sourceHash,
      stack:sourceFrames(error??new Error('lifecycle')), ...(error===undefined?{}:{errorCode:errorCode(error)}),...(agent?{agent}:{})};
    this.records.push(record);if(this.records.length>80)this.records.shift();
    try{writeJson(this.file,{version:1,records:this.records});}
    catch{try{process.stderr.write(JSON.stringify({component:'team-lifecycle',...record})+'\n');}catch{}}
  }
}
export function runtimeDiagnostic(root:string) {
  const s=readJson<any>(join(controlDir(root),'status.json'));
  const installed=installedRuntime(root),runtime=s?.runtime;
  const id=s?.session;
  const history=typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id)
    ?readJson<{records:TraceRecord[]}>(join(controlDir(root),'diagnostics',id+'.json'))?.records.slice(-12):undefined;
  const active=s?.active===true,sourceMatches=!!runtime&&runtime.sourceHash===installed.sourceHash;
  const nextAction=!active
    ?'No active Overseer is recorded. Open team:ui or team:herdr, then start the agents you want to run.'
    :!sourceMatches
      ?'Deployment required: in the existing Overseer pane type reload, then start all. Reload stops workers but preserves their journals.'
      :'The recorded Overseer matches installed source. Use its status/dashboard commands to inspect current agent state.';
  return {installed,running:runtime??null,active,session:id??null,
    heartbeatAt:s?.at??null,sourceMatches:!!runtime&&runtime.sourceHash===installed.sourceHash,
    // Persisted status is evidence of the last heartbeat, not independent process liveness.
    note:'Saved heartbeat, not a Windows process check. No credentials/config contents included.',nextAction,history:history??[]};
}
