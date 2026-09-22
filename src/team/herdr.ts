import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { capture } from './process.ts';
import { acquireTeamController } from './lease.ts';
import { AGENTS, text, HEARTBEAT_MS } from './protocol.ts';
import { controlDir, readJson, writeJson } from './storage.ts';
import { LOADED_RUNTIME } from './runtime.ts';
const run=(args:string[],cwd:string)=>capture({file:process.platform==='win32'?'herdr.exe':'herdr',args,cwd},'',8000,500_000);
export function panelCommand(bun:string,script:string,args:string[],windows=process.platform==='win32'):string {
  const quote=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
  if(windows){
    const ps='& '+[bun,script,...args].map(quote).join(' ');
    return 'powershell.exe -NoLogo -NoProfile -EncodedCommand '+Buffer.from(ps,'utf16le').toString('base64');
  }
  const sh=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
  return [bun,script,...args].map(sh).join(' ');
}
/** The explicit `reload` panel command starts a new local Overseer only after
 * the old one has released ownership.  Keep the command data-only so it is
 * easy to test and cannot inherit a shell. */
export function overseerReloadSpec(root:string,executable=process.execPath) {
  return {file:executable,args:[join(root,'scripts/team.ts'),'ui'],cwd:root};
}
type Workspace={id:string;root:string;complete:boolean;createdAt?:number;pane?:string;sourceHash?:string};
export function currentPanel(status:any,now=Date.now()):boolean {
  return !!status&&status.active===true&&Number.isFinite(status.at)&&status.at<=now&&now-status.at<HEARTBEAT_MS
    &&status.runtime?.sourceHash===LOADED_RUNTIME.sourceHash&&status.runtime?.version===LOADED_RUNTIME.version
    &&['ready','monitor-fault'].includes(status.runtime?.phase);
}
/** Never inject startup commands into a saved pane with an unknown foreground process.
 * Reusing a workspace is not restarting the manager. Fresh creation is explicit. */
export async function openWorkspace(root:string,execute:typeof run=run,options:{fresh?:boolean}={}):Promise<string> {
  const file=join(controlDir(root),'herdr-workspace.json'),old=readJson<Workspace>(file);
  if(old&&!options.fresh){
    if(old.root!==root||old.complete!==true)throw new Error('INCOMPLETE_OR_DIFFERENT_HERDR_WORKSPACE: inspect it before an explicit --fresh-workspace.');
    try{await execute(['workspace','get',old.id],root);}catch{throw new Error('SAVED_HERDR_WORKSPACE_UNAVAILABLE: stop old control processes, then use --fresh-workspace.');}
    const status=readJson<any>(join(controlDir(root),'status.json'));
    // Focusing is read-only with respect to the pane's foreground program.  It
    // is therefore safe even when the saved controller is stale, and gives the
    // operator a way back to its own `stop all` control after closing the
    // Herdr client.  We still never send input or call this a restart.
    await execute(['workspace','focus',old.id],root);return old.id;
  }
  // Probe the same ownership lock; never kill or delete a live owner's lock.
  // The new pane acquires ownership independently. A concurrent launch fails closed.
  const release=acquireTeamController(join(root,'data/supervisor/supervisor.lock'));release();
  if(old)writeJson(join(controlDir(root),'workspace-history',Date.now()+'.json'),old);
  const created=JSON.parse(await execute(['workspace','create','--cwd',root,'--label','Clawscape '+LOADED_RUNTIME.version,'--focus'],root));
  const id=created.result?.workspace?.workspace_id,pane=created.result?.root_pane?.pane_id;
  if(typeof id!=='string'||typeof pane!=='string')throw new Error('UNSUPPORTED_HERDR_WORKSPACE_RESPONSE');
  writeJson(file,{id,root,pane,sourceHash:LOADED_RUNTIME.sourceHash,createdAt:Date.now(),complete:false});
  await execute(['pane','rename',pane,'Overseer / controls'],root);
  await execute(['pane','run',pane,panelCommand(process.execPath,join(root,'scripts/team.ts'),['ui'])],root);
  for(const agent of AGENTS){
    const tab=JSON.parse(await execute(['tab','create','--workspace',id,'--cwd',root,'--label',agent,'--no-focus'],root));
    const p=tab.result?.root_pane?.pane_id;if(typeof p!=='string')throw new Error('UNSUPPORTED_HERDR_TAB_RESPONSE');
    await execute(['pane','run',p,panelCommand(process.execPath,join(root,'scripts/team.ts'),['view',agent])],root);
  }
  writeJson(file,{id,root,pane,sourceHash:LOADED_RUNTIME.sourceHash,createdAt:Date.now(),complete:true});return id;
}
/** Attach without inventing a session name from a workspace id. Do not nest TUIs. */
export async function launchHerdrClient(root:string,spawnClient:typeof spawn=spawn):Promise<void> {
  if(process.env.HERDR_ENV==='1')return;
  const file=process.platform==='win32'?'herdr.exe':'herdr';
  await new Promise<void>((resolve,reject)=>{
    const child=spawnClient(file,[],{cwd:root,stdio:'inherit',windowsHide:false});
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(code===0)resolve();else reject(new Error('HERDR_CLIENT_EXIT_'+String(code??signal)));
    });
  });
}
let lastReport='',lastAt=0;
export function reportHerdr(root:string,label:string,state:'working'|'idle'|'blocked'|'unknown',message:string):void {
  const pane=process.env.HERDR_PANE_ID;if(!pane)return;
  const key=label+state+message;if(key===lastReport&&Date.now()-lastAt<30_000)return;
  lastReport=key;lastAt=Date.now();
  void run(['pane','report-agent',pane,'--source','clawscape-team','--agent',label,'--state',state,
    '--message',text(message,180),'--seq',String(Date.now())],root).catch(()=>{});
}
export async function releaseHerdr(root:string,label:string):Promise<void> {
  const pane=process.env.HERDR_PANE_ID;if(pane)try{await run(['pane','release-agent',pane,'--source','clawscape-team','--agent',label,'--seq',String(Date.now())],root);}catch{}
}
