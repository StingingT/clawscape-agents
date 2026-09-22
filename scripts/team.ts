#!/usr/bin/env bun
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { acquireTeamController } from '../src/team/lease.ts';
import { AGENTS, agentName, text, fresh, HEARTBEAT_MS, type WorkerSnapshot, type TeamSession } from '../src/team/protocol.ts';
import { controlDir, readJson, writeJson } from '../src/team/storage.ts';
import { TeamManager, createTeamManager, defaultConfig, readConfig } from '../src/team/manager.ts';
import { openWorkspace, launchHerdrClient, reportHerdr, releaseHerdr, overseerReloadSpec } from '../src/team/herdr.ts';
import { requestSummary, requestDetails, statusText } from '../src/team/presentation.ts';
import { PanelLifecycle } from '../src/team/panel-lifecycle.ts';
import { runtimeDiagnostic, errorCode, type CloseReason } from '../src/team/runtime.ts';
import { capture } from '../src/team/process.ts';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),dir=controlDir(root);
const [command='help',...args]=process.argv.slice(2);
const print=(v:unknown)=>console.log(typeof v==='string'?v:JSON.stringify(v,null,2));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const HELP=`Clawscape local team control (Codex OFF unless explicitly approved)
  bun run team:doctor          Check local prerequisites; no game login/model call
  bun run team:setup           Enable team ownership; existing supervisor must be stopped
  bun run team:ui              Open the local control panel in this terminal
  bun run team:run             Start all agents under a headless local controller
  bun run team:herdr           Open/focus the saved Clawscape workspace (never inject commands)
  bun scripts/team.ts herdr --fresh-workspace  Create fresh panes AFTER Stop All
  bun scripts/team.ts diagnose Read build/session/shutdown diagnostics; no processes launched
  bun scripts/team.ts config local MODEL | off
  bun scripts/team.ts config codex PATH-TO-NATIVE-EXECUTABLE
Panel commands:
  start all|NAME   pause all|NAME   resume all|NAME   restart all|NAME   stop NAME
  stop all        Stop all workers/consultants and EXIT the panel
  reload          Stop all workers and restart this Overseer from current source; then use start all
  details NAME    Show current goal candidates and blockers
  goal NAME N     Prefer listed goal number N; existing safety remains authoritative
  help NAME       Request a single Codex consultation (does not launch it)
  requests [ID]   Summaries, or an exact scope and its approval code
  approve ID HASH Approve ONLY that displayed request; interactive terminal required
  deny ID         Refuse it; other workers continue
  ollama          Show local consultation reports; never calls a model
  status          Print an explicit status response; hold it for reading
  dashboard       Resume automatic dashboard redraw
Closing/detaching Herdr alone is NOT Stop All. Use stop all before leaving to release RAM.`;
function setup(){
  mkdirSync(join(root,'data/supervisor'),{recursive:true});const release=acquireTeamController(join(root,'data/supervisor/supervisor.lock'));
  try{
    if(!existsSync(join(dir,'config.json')))writeJson(join(dir,'config.json'),defaultConfig());
    writeJson(join(dir,'enabled.json'),{version:1,enabled:true,reason:'Operator enabled local team ownership.'});
    print('Setup saved. Existing memories untouched. Codex and local model are OFF. Open team:ui or team:herdr, then start selected agents.');
  }finally{release();}
}
async function doctor(){
  print({runtime:process.versions.bun?'Bun '+process.versions.bun:'Use Bun for the game workers',root,
    localModel:readConfig(root).localModel??'off',codex:'not started; not required for routine operation'});
  try{print('Herdr: '+text(await capture({file:process.platform==='win32'?'herdr.exe':'herdr',args:['--version'],cwd:root})));}
  catch{print('Herdr CLI is not on PATH. team:ui works without Herdr.');}
  for(const [name,file] of [['standard owner CLI','data/online-home/config.jsonl'],['Astra config','agents/advanced/config.local.json']])
    print(name+': '+(existsSync(join(root,file))?'present (contents not read)':'not at default path; existing environment/runtime-root configuration may provide it'));
  print('Stop the old scheduled watchdog before setup. No models, games or paid requests were launched.');
}
async function ui(){
  if(!process.stdin.isTTY)throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  const m=createTeamManager(root),rl=createInterface({input:process.stdin,output:process.stdout});let queue=Promise.resolve();
  let inspecting=false;
  let refresh:ReturnType<typeof setInterval>|undefined;
  let finished!:()=>void;const completion=new Promise<void>(resolve=>{finished=resolve;});
  const lifecycle=new PanelLifecycle(m,()=>{if(refresh)clearInterval(refresh);rl.close();},async()=>{
    try{await releaseHerdr(root,'Overseer');print('Control process ended. Workers stopped; memory and unknown receipts preserved.');}
    finally{finished();}
  });
  const quit=(reason:CloseReason='operator-quit')=>lifecycle.shutdown(reason);
  const requestQuit=(reason:CloseReason)=>{void quit(reason).catch(error=>{console.error('CONTROL_SHUTDOWN_ERROR: '+errorCode(error));process.exitCode=1;});};
  const managerClosing=()=>requestQuit('manager-closed');
  m.lifecycleEvents.once('closing',managerClosing);
  const displayedGoals=new Map<string,string[]>();
  const render=()=>{
    if(!lifecycle.accepting)return;
    m.refreshApprovals();
    const snapshots=m.snapshots();process.stdout.write('\x1b[2J\x1b[H');
    print('CONTROL '+m.runtime.version+' | PID '+m.runtime.pid+' | session '+m.session.id.slice(0,8)+' | build '+m.runtime.sourceHash.slice(0,12));
    print('Manager: '+m.lifecycle().phase+(m.managerRestartRequired()?' (restart required; worker starts withheld)':''));
    if(m.managerRestartRequired())print('DEPLOYMENT REQUIRED: type reload, then start all. Reload stops workers but preserves their journals.');
    print('CLAWSCAPE | Overseer: '+(m.config.localModel?'local '+m.config.localModel+' (on demand)':'token-free monitor')+' | Codex: approval only');
    print('Agent         Process             State                 Active stall       Current goal');
    for(const a of AGENTS){const s=snapshots[a],valid=fresh(s,m.session.id),process=m.processes[a];
      const state=!valid?'awaiting observation':s.pending?'reconciling':s.stalled?'recovering':'active';
      print(a.padEnd(14)+((process?.status??'stopped')+(m.workerRestartRequired(a)?' (restart required)':'')).padEnd(20)
        +state.padEnd(22)+(valid?Math.floor(m.escalationStatus(a).noProgressMs/1000)+' s':'-').padEnd(19)+text(valid?s.currentGoal??'selecting':'-',65));
      if(valid&&s.blocked)print('  Blocker: '+text(s.blocked,180));}
    const requests=m.approvals.rows.filter(r=>r.status==='requested');
    if(requests.length){print('\nAPPROVAL REQUIRED — '+requests.length+' Codex request(s); nothing is launched until you approve.');
      for(const r of requests)print(r.id.slice(0,8)+' '+r.agent+' | '+text(r.why?.summary??'Operator request',100));}
    else print('\nNo paid consultation awaiting approval.');
    for(const a of AGENTS)if(m.session.modes[a]==='running')print(a+': '+text(m.escalationStatus(a).reason,180));
    print(m.localSummary());
    const event=m.events.at(-1);if(event)print('Latest: '+text(event.summary,140));
    print('\nstart/pause/resume/restart all|name · stop name · stop all (exit) · reload · details name · requests [id] · status · dashboard');
    reportHerdr(root,'Overseer',requests.length?'blocked':m.children.size?'working':'idle',requests.length?'Codex approval requested':'Local team controls');
    rl.prompt(true);
  };
  const showRequests=(id?:string)=>{
    inspecting=true;m.refreshApprovals();
    if(id)print(requestDetails(m.approvals.find(id)));else print(requestSummary(m.approvals.rows));
    print('Display held. Type dashboard to resume automatic redraw.');
  };
  const handle=async(line:string)=>{
    if(!lifecycle.accepting)return;
    const [op,target,n]=line.trim().split(/\s+/);if(!op)return;
    if(op==='stop'&&target==='all'||op==='quit'||op==='exit'){await quit(op==='stop'?'operator-stop-all':op==='exit'?'operator-exit':'operator-quit');return;}
    if(op==='reload'){
      // Explicit operator authority only.  Closing first releases team ownership
      // and preserves every worker journal; the new process reads current disk
      // source rather than pretending the old manager hot-reloaded.
      await quit('operator-reload');
      const next=overseerReloadSpec(root);
      spawn(next.file,next.args,{cwd:next.cwd,stdio:'inherit',shell:false,windowsHide:false});
      return;
    }
    if(['start','resume','restart','pause','stop'].includes(op)){
      const names=target==='all'?AGENTS:[agentName(target)];
      for(const a of names){if(!lifecycle.accepting)break;if(op==='restart')await m.restart(a);else if(op==='start'||op==='resume')m.start(a);else if(op==='pause')m.pause(a);else await m.stop(a);if(names.length>1&&(op==='start'||op==='resume'||op==='restart'))await sleep(750);}
      inspecting=false;render();return;
    }
    if(op==='details'){inspecting=true;const s=m.snapshots()[agentName(target)];print(s??'No observation yet.');if(s)displayedGoals.set(s.agent,s.candidates.map(c=>c.id));s?.candidates.forEach((c,i)=>print(`${i+1}. ${c.id} — ${c.reason}`));return;}
    if(op==='goal'){const a=agentName(target),i=Number(n),id=displayedGoals.get(a)?.[i-1];if(!Number.isInteger(i)||i<1||!id)throw new Error('RUN_DETAILS_FIRST_AND_USE_ITS_GOAL_NUMBER');m.assign(a,id);return;}
    if(op==='requests'){showRequests(target);return;}
    if(op==='help'){const s=m.snapshots()[agentName(target)];if(!fresh(s,m.session.id))throw new Error('FRESH_OBSERVATION_REQUIRED');m.requestHelp(s);showRequests();return;}
    if(op==='approve'){await m.approve(target??'',n??'',process.stdin.isTTY===true);return;}
    if(op==='deny'){m.approvals.deny(target??'');print('Request denied. No consultation started.');return;}
    if(op==='ollama'){inspecting=true;print(m.localDiagnosticStatus());return;}
    if(op==='status'){
      inspecting=true;m.refreshApprovals();
      const snapshots=m.snapshots();for(const a of AGENTS)if(!fresh(snapshots[a],m.session.id))delete snapshots[a];
      print(statusText(m.lifecycle().phase,m.processes,snapshots,Object.fromEntries(AGENTS.map(a=>[a,m.escalationStatus(a)])),m.approvals.rows,Date.now(),m.managerRestartRequired()));print(m.localSummary());return;
    }
    if(op==='dashboard'){inspecting=false;render();return;}
    print(HELP);
  };
  // Pause redraw briefly when inspecting long request details, without stopping heartbeat or controls.
  let lastInput=0;refresh=setInterval(()=>{if(lifecycle.accepting){
    try{
      if(!inspecting&&Date.now()-lastInput>15000)render();
      else reportHerdr(root,'Overseer',m.approvals.rows.some(r=>r.status==='requested')?'blocked':m.children.size?'working':'idle','Local team controls');
    }catch(error){m.note('panel-error','Render failed: '+errorCode(error));requestQuit('panel-error');}
  }},3000);
  rl.setPrompt('clawscape> ');
  rl.on('line',line=>{lastInput=Date.now();queue=queue.then(()=>handle(line)).catch(error=>{
    print(text(error.message));if(m.isClosing())requestQuit('manager-closed');
  }).finally(()=>{if(lifecycle.accepting)rl.prompt();});});
  const sigint=()=>requestQuit('sigint'),sigterm=()=>requestQuit('sigterm');
  rl.on('SIGINT',sigint);process.once('SIGTERM',sigterm);
  // A real closed input stream cannot be reattached to this readline instance.
  // Normal Herdr client detach leaves the server-owned pane/process untouched.
  rl.once('close',()=>requestQuit('input-closed'));
  try{render();await completion;}
  finally{if(refresh)clearInterval(refresh);process.removeListener('SIGTERM',sigterm);m.lifecycleEvents.removeListener('closing',managerClosing);await quit('panel-error');}

}
/**
 * Long-running controller for machine-started sessions.  It uses exactly the
 * same TeamManager as the interactive panel; only the terminal UI is absent.
 * This keeps ownership, restart backoff, status exports, and safe shutdown
 * semantics intact when no person is holding a Herdr pane open.
 */
async function run(){
  const manager=createTeamManager(root);
  let closing=false;
  const close=async(reason:CloseReason)=>{
    if(closing)return;
    closing=true;
    try{await manager.close(reason);}
    catch(error){console.error('TEAM_SHUTDOWN_ERROR: '+errorCode(error));process.exitCode=1;}
  };
  process.once('SIGINT',()=>void close('sigint'));
  process.once('SIGTERM',()=>void close('sigterm'));
  for(const agent of AGENTS)manager.start(agent);
  print('Headless team controller started. Use status:export or team:ui to inspect it.');
  await new Promise<void>(resolve=>{
    const heartbeat=setInterval(()=>{
      if(closing){clearInterval(heartbeat);resolve();}
    },1000);
  });
}
async function view(name:string){
  const a=agentName(name);let owner:string|undefined;let started=Date.now();
  try{while(true){
    const session=readJson<TeamSession>(join(dir,'session.json'));
    if(session){owner??=session.id;if(session.id!==owner||!session.active||Date.now()-session.at>HEARTBEAT_MS)break;}
    else if(Date.now()-started>30_000)break;
    const status=readJson<any>(join(dir,'status.json')),s=readJson<WorkerSnapshot>(join(dir,'workers',a+'.json'));
    process.stdout.write('\x1b[2J\x1b[H');print(a.toUpperCase()+' — character view (no separate LLM)');
    print({process:status?.processes?.[a]??{status:'stopped'},observation:session&&fresh(s,session.id)?s:'No fresh worker snapshot',
      controls:'Use the Overseer tab to start, pause, stop, or approve a consultation.'});
    const state=session?.modes[a]==='running'?(s?.stalled?'blocked':'working'):'idle';reportHerdr(root,a,state,s?.blocked??session?.modes[a]??'waiting');
    await sleep(3000);
  }}finally{await releaseHerdr(root,a);}
  print('Team stopped. This observer has exited.');
}
async function main(){
  if(command==='setup')setup();else if(command==='doctor')await doctor();else if(command==='ui')await ui();else if(command==='run')await run();
  else if(command==='herdr'){
    if(args.some(a=>a!=='--fresh-workspace')||args.length>1)throw new Error('Usage: bun scripts/team.ts herdr [--fresh-workspace]');
    const workspace=await openWorkspace(root,undefined,{fresh:args.includes('--fresh-workspace')});
    const diagnostic=runtimeDiagnostic(root);
    print('Workspace: '+workspace);
    if(diagnostic.active===true&&diagnostic.sourceMatches===false)
      print('Saved Overseer uses older code. It was focused only: type stop all there, then run bun scripts/team.ts herdr --fresh-workspace.');
    await launchHerdrClient(root);
  }
  else if(command==='status'){
    const state=readJson<any>(join(dir,'status.json'));
    print(state?{note:'Saved heartbeat, not an independent process check.',at:state.at,runtime:state.runtime,processes:state.processes,escalation:state.escalation,approvals:state.approvals}: 'No saved team status.');
  }
  else if(command==='ollama')print(readJson(join(dir,'ollama-latest.json'))??'No local consultation report has been recorded yet.');
  else if(command==='diagnose')print(runtimeDiagnostic(root));
  else if(command==='view')await view(args[0]??'');
  else if(command==='config'){
    mkdirSync(join(root,'data/supervisor'),{recursive:true});const release=acquireTeamController(join(root,'data/supervisor/supervisor.lock'));
    try{const c=readConfig(root);if(args[0]==='local')c.localModel=args[1]==='off'?null:args[1]??null;
      else if(args[0]==='codex'&&args[1])c.codexBinary=args[1];else throw new Error('CONFIG_KEY_REQUIRED');
      writeJson(join(dir,'config.json'),c);print('Configuration saved; no model started.');}finally{release();}
  }else print(HELP);
}
main().catch(e=>{
  const message=text(e instanceof Error?e.message:'TEAM_SETUP_FAILED');
  // A lock refusal is intentionally fail-closed, but it should not force an
  // operator to inspect JSON just to learn that the current Overseer needs a
  // controlled reload.  Never stop or replace that owner from this process.
  if(message==='A controller already owns these profiles. Stop the existing watchdog/control panel first.') {
    try {
      const diagnostic=runtimeDiagnostic(root);
      const hint=diagnostic.active&&diagnostic.sourceMatches===false
        ? ' Existing Overseer source is stale: use reload in its Herdr pane, then start all.'
        : ' Use the existing Herdr Overseer pane to start, stop, or reload the team.';
      console.error(message+hint);
    } catch { console.error(message); }
  } else console.error(message);
  process.exitCode=1;
});
