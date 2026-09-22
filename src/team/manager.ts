import { mkdirSync, openSync, closeSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { LifecycleTrace, LOADED_RUNTIME, installedRuntime, installedWorkerRuntime, errorCode, type CloseReason } from './runtime.ts';
import type { ChildProcess } from 'node:child_process';
import { acquireTeamController } from './lease.ts';
import { AGENTS, agentName, fresh, initialModes, text, type Agent, type Mode, type TeamSession, type WorkerSnapshot } from './protocol.ts';
import { controlDir, readJson, writeJson } from './storage.ts';
import { launch, terminate } from './process.ts';
import { EscalationTracker, problemKey, safeForAdvice, type EscalationView } from './escalation.ts';
import { ApprovalBook, type Consultation } from './approvals.ts';
import { consult, localAdvice, unloadLocal, type Advice } from './models.ts';
import { FeasibilityEvidence, LocalRoundTracker, localDiagnosis, localBoundary, localResultCurrent,
  sameCandidate, localFailureCode, LOCAL_RECHECK_MS, type LocalGate, type LocalReport } from './local-diagnostics.ts';
import { DiagnosticLearning } from './diagnostic-learning.ts';
export type TeamConfig={version:1;localModel:string|null;codexBinary:string};
export const defaultConfig=():TeamConfig=>({version:1,localModel:null,codexBinary:process.platform==='win32'?'codex.exe':'codex'});
export function readConfig(root:string):TeamConfig {
  const c=readJson<TeamConfig>(join(controlDir(root),'config.json'))??defaultConfig();
  if(c.version!==1||!(c.localModel===null||typeof c.localModel==='string'&&c.localModel.length<=100)
    ||typeof c.codexBinary!=='string'||!c.codexBinary||c.codexBinary.length>1000)throw new Error('INVALID_TEAM_CONFIG');return c;
}
export function job(root:string,a:Agent):{cwd:string;args:string[]} {
  if(a==='astra')return {cwd:join(root,'agents/advanced'),args:['src/live-entry.ts','run','--seconds','900']};
  // These are the existing profile launch settings, not newly assigned gameplay goals.
  return {cwd:root,args:['run','src/agent.ts','--character',a,'--profile',a==='clawscout'?'online':a,
    '--role',a==='coincrafter'?'economy':a==='featherer'?'resource':'brawler','--build',a==='stinger'?'ranged-magic':'broad','--forever']};
}
export type ProcessState={status:string;pid?:number;started?:string;log?:string;errorLog?:string;reason?:string;retryAt?:number;sourceHash?:string;sourceFiles?:number;restartRequired?:boolean};
export class TeamManager {
  readonly lifecycleEvents=new EventEmitter();
  readonly runtime={...LOADED_RUNTIME,pid:process.pid,pane:process.env.HERDR_PANE_ID??null};
  readonly startedAt=Date.now();
  private trace!:LifecycleTrace; private closed=false; private shutdownReason?:CloseReason;
  private monitorFault?:string;
  lifecycle(){return {...this.runtime,startedAt:this.startedAt,phase:this.closed?'closed':this.closing?'stopping':this.monitorFault?'monitor-fault':'ready',closeReason:this.shutdownReason??null,monitorFault:this.monitorFault??null};}
  isClosing(){return this.closing;}
  readonly root:string;readonly dir:string;readonly session:TeamSession;readonly approvals:ApprovalBook;readonly config:TeamConfig;
  readonly processes:Partial<Record<Agent,ProcessState>>={};
  readonly children=new Map<Agent,ChildProcess>();
  readonly events:Array<{at:number;kind:string;agent?:Agent;summary:string}>=[];
  private release:()=>void;private timer:ReturnType<typeof setInterval>;private closing=false;private closeTask?:Promise<void>;private localStop?:Promise<void>;private tickFailures=0;
  private local?:{agent:Agent;snapshot:WorkerSnapshot;abort:AbortController;done:Promise<void>};private consultant?:{abort:AbortController;done:Promise<void>;id:string};
  private lastLocal=0;
  private readonly localRounds=new LocalRoundTracker();
  private readonly localEvidence=new FeasibilityEvidence();
  private readonly diagnosticLearning:DiagnosticLearning;
  readonly localReports:LocalReport[]=[];
  private readonly localStates:Partial<Record<Agent,string>>={};
  readonly escalation=new EscalationTracker();
  private lastRequest=new Map<Agent,{key:string;at:number}>();
  constructor(root:string) {
    this.root=resolve(root);this.dir=controlDir(root);this.diagnosticLearning=new DiagnosticLearning(this.root);mkdirSync(join(root,'data/supervisor'),{recursive:true});
    // Share ownership with the legacy supervisor; an already running watchdog must be stopped first.
    this.release=acquireTeamController(join(root,'data/supervisor/supervisor.lock'));
    try {
      this.config=readConfig(root);
      writeJson(join(this.dir,'enabled.json'),{version:1,enabled:true,reason:'Explicit local team control; legacy watchdog remains suppressed after stop.'});
      this.session={version:1,id:randomUUID(),pid:process.pid,at:Date.now(),active:true,modes:initialModes(),objectives:{}};
      this.trace=new LifecycleTrace(this.root,this.session.id);
      this.trace.add('manager-created','new-process-lifecycle');
      this.approvals=new ApprovalBook(join(this.dir,'approvals.json'));
      this.save();this.timer=setInterval(()=>this.monitorOnce(),1000);
    } catch(e){this.release();throw e;}
  }
  private monitorOnce() {
    if(this.closing)return;
    try{this.tick();this.tickFailures=0;}
    catch(error){
      this.monitorFault=errorCode(error);this.tickFailures++;
      if(this.tickFailures===1||this.tickFailures%60===0){
        this.trace.add('monitor-error','heartbeat-failed',error);
        this.note('monitor-error','Monitor fault '+this.monitorFault+'; new starts withheld until a successful heartbeat.');
      }
      // Do not manufacture a Stop All. Failed heartbeats still expire worker authority.
    }
  }
  snapshots():Partial<Record<Agent,WorkerSnapshot>> {
    const result:Partial<Record<Agent,WorkerSnapshot>>={};
    for(const a of AGENTS)try{const s=readJson<WorkerSnapshot>(join(this.dir,'workers',a+'.json'));if(s?.agent===a)result[a]=s;}catch{}
    return result;
  }
  workerRestartRequired(agent:Agent):boolean {
    const process=this.processes[agent];
    return process?.status==='running'&&typeof process.sourceHash==='string'
      && installedWorkerRuntime(this.root,agent).sourceHash!==process.sourceHash;
  }
  /** A manager never hot-reloads.  Starting a new worker from an older manager
   * mixes control-plane versions, so require an explicit controlled restart. */
  managerRestartRequired():boolean {
    const current=this.currentManagerSourceHash();
    return current!==undefined&&current!==this.runtime.sourceHash;
  }
  private currentManagerSourceHash():string|undefined {
    // Focused tests and recovery tooling can use a deliberately partial root.
    // A real installation has every manifest source; only then is a comparison
    // meaningful.  Never invent a restart requirement from missing evidence.
    try{return installedRuntime(this.root).sourceHash;}catch{return undefined;}
  }
  note(kind:string,summary:string,agent?:Agent){this.events.push({at:Date.now(),kind,agent,summary:text(summary)});if(this.events.length>100)this.events.shift();}
  save() {
    this.session.at=Date.now();writeJson(join(this.dir,'session.json'),this.session);
    const processes=Object.fromEntries(Object.entries(this.processes).map(([agent,process])=>{
      if(!process)return [agent,process];
      const current=process.sourceHash?installedWorkerRuntime(this.root,agent):undefined;
      return [agent,{...process,restartRequired:process.status==='running'&&!!current&&current.sourceHash!==process.sourceHash,
        ...(current?{currentSourceHash:current.sourceHash}: {})}];
    }));
    const currentManagerSourceHash=this.currentManagerSourceHash();
    const runtime={...this.lifecycle(),restartRequired:currentManagerSourceHash!==undefined&&currentManagerSourceHash!==this.runtime.sourceHash,
      ...(currentManagerSourceHash?{currentSourceHash:currentManagerSourceHash}:{})};
    writeJson(join(this.dir,'status.json'),{version:1,at:Date.now(),session:this.session.id,active:this.session.active,
      runtime,localModel:this.config.localModel,codex:this.consultant?'running':'off',modes:this.session.modes,processes,
      localConsultations:{states:this.localStates,reportFile:'data/team-control/ollama-latest.json'},
      escalation:Object.fromEntries(AGENTS.map(a=>[a,this.escalation.view(a)])),
      approvals:this.approvals?.rows.slice(-20).map(({snapshot,question,...r})=>r),events:this.events.slice(-20)});
    writeJson(join(this.root,'data/supervisor/status.json'),{time:new Date().toISOString(),pid:process.pid,owner:'herdr-team',agents:processes});
  }
  private tick() {
    if(this.closing)return;
    this.approvals.expire();
    this.save();
    if(this.monitorFault){this.trace.add('monitor-recovered','heartbeat-succeeded');this.monitorFault=undefined;}
    for(const a of AGENTS){const p=this.processes[a];if(p?.retryAt&&Date.now()>=p.retryAt&&this.session.modes[a]==='running'&&!this.children.has(a))this.start(a);}
    // Sustained current-run evidence, not historic wall-clock age, controls escalation.
    this.refreshApprovals();
    const snapshots=this.snapshots();
    for(const a of AGENTS){
      const s=snapshots[a];
      if(fresh(s,this.session.id)&&this.session.modes[a]==='running')this.localEvidence.observe(s);
      const decision=this.escalation.observe(a,s,this.session.modes[a],this.session.id);
      if(!fresh(s,this.session.id)||this.session.modes[a]!=='running'||!safeForAdvice(s))continue;
      if(decision.phase==='local-replan'&&decision.nextGoal){
        const candidate=s.candidates.find(c=>c.id===decision.nextGoal);
        if(candidate){
          const id=this.assign(a,candidate.id,'Bounded local replanning before paid escalation.',true);
          this.escalation.markTrial(a,candidate,id);
        }
        continue;
      }
      if(!decision.eligible)continue;
      const key=decision.problemKey??s.context;
      if(this.local||this.consultant)continue;
      if(this.config.localModel){
        const evidenceKey=this.localEvidence.evidenceKey(s);
        const gate=this.localRounds.gate(s,evidenceKey);
        if(gate==='call'){
          if(Date.now()-this.lastLocal<LOCAL_RECHECK_MS)continue;
          this.startLocalConsultation(a,s,evidenceKey);break;
        }
        this.localStates[a]=this.localGateMessage(gate);
        if(gate!=='fallback')continue;
      }
      const last=this.lastRequest.get(a);
      if(last?.key===key&&Date.now()-last.at<300_000)continue;
      this.lastRequest.set(a,{key,at:Date.now()});
      this.requestHelp(s,'automatic');continue;
    }
  }
  escalationStatus(a:Agent):EscalationView{return this.escalation.view(a);}
  consultationSnapshot(agent:Agent,s:WorkerSnapshot):WorkerSnapshot{
    if(agent!==s.agent)throw new Error('LOCAL_AGENT_MISMATCH');
    this.diagnosticLearning.resolveOnProgress(agent,s.progressAt);
    const snap=this.localEvidence.snapshot(s);
    return {...snap,candidates:snap.candidates.filter(c=>!this.diagnosticLearning.suppresses(agent,c))};
  }
  localSummary():string {
    const rows=AGENTS.filter(a=>this.session.modes[a]==='running').map(a=>a+': '+(this.localStates[a]??'Waiting for bounded local exhaustion.'));
    return 'OLLAMA '+(this.config.localModel??'off')+' | '+(rows.join(' | ')||'No running workers.');
  }
  localDiagnosticStatus(){
    return {version:1,session:this.session.id,model:this.config.localModel,states:{...this.localStates},
      reports:this.localReports.slice(-24),note:'Model hypotheses are not verified facts. No diagnostic text is executed. Codex still requires explicit approval.'};
  }
  private persistLocalReports(){
    const record=this.localDiagnosticStatus();
    writeJson(join(this.dir,'ollama',this.session.id+'.json'),record);
    writeJson(join(this.dir,'ollama-latest.json'),record);
  }
  private localGateMessage(gate:LocalGate):string {
    return gate==='waiting-new-evidence'?'Diagnostic saved; waiting for changed evidence. Existing planner rechecks continue.'
      :gate==='manual-only'?'Local attempts ended without a usable response. Inspect ollama-latest.json; no automatic Codex request.'
      :gate==='fallback'?'Local attempts completed and fresh rechecks still show a blockage; Codex remains approval-only.'
      :'Waiting for a newer observation and at least 60 seconds of normal rechecks after the last local response.';
  }
  private startLocalConsultation(a:Agent,s:WorkerSnapshot,evidenceKey:string){
    if(!this.config.localModel||this.closing||this.local||this.consultant)return;
    const captured=this.consultationSnapshot(a,s),mode=captured.candidates.length?'goal-selection':'capability-gap';
    const attempt=(this.localRounds.view(s)?.attempts??0)+1;
    const report:LocalReport={id:randomUUID(),agent:a,session:this.session.id,model:this.config.localModel,mode,attempt,
      startedAt:Date.now(),outcome:'running',evidence:this.localEvidence.frame(s),
      choices:captured.candidates.map(c=>({id:c.id,family:c.plan?.family})),preferenceIssued:false};
    this.localReports.push(report);
    if(this.localReports.length>24)this.localReports.shift();
    // Persist the intent before any inference. A write failure does not consume a local call.
    try{this.persistLocalReports();}catch(error){this.localReports.pop();throw error;}
    this.localRounds.start(s,evidenceKey);this.lastLocal=Date.now();
    this.localStates[a]=mode+' consultation '+attempt+'/3 running.';
    this.note('ollama-start','Ollama '+this.config.localModel+' '+mode+' consultation '+attempt+'/3 started; '
      +captured.candidates.length+' registered choices, not proof of executability.',a);
    const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),45_000);
    let validResponse=false,requireNewEvidence=false;
    // Deferred so ownership exists even if a test transport returns immediately.
    const done=Promise.resolve().then(async()=>{
      if(mode==='capability-gap'){
        const diagnosis=await localDiagnosis(this.config.localModel!,report.evidence,abort.signal);
        report.diagnosis=diagnosis;
        const current=this.snapshots()[a];
        if(this.closing||abort.signal.aborted||!localResultCurrent(captured,current,this.session.modes[a],this.session.id)){
          report.outcome='stale';this.note('ollama-stale','Diagnostic saved for inspection but not adopted: worker/progress/safety boundary changed.',a);return;
        }
        validResponse=true;requireNewEvidence=true;report.outcome='diagnosis';
        report.recheck='Continue existing worker/planner rechecks; consult again only after changed evidence. '
          +(diagnosis.recheck==='needs-implementation'?'Requested capability is not implemented by this advice.':'No commands or observations are created from model text.');
        this.note('ollama-diagnosis','Ollama hypothesis: '+diagnosis.summary,a);
        const learned=this.diagnosticLearning.learn(a,diagnosis,report.evidence.facts,captured.progressAt,captured.context);
        for(const gap of learned)if(gap.confirmations>=2)this.note('diagnostic-learned','Confirmed executor gap: '+gap.target+'; suppressing matching dead-end candidates for bounded replanning.',a);
        // Diagnostic enum/text is descriptive only, never passed to assign() or the game executor.
      }else{
        const advice=await localAdvice(this.config.localModel!,captured,abort.signal);report.advice=advice;
        const current=this.snapshots()[a];
        if(this.closing||abort.signal.aborted||!localResultCurrent(captured,current,this.session.modes[a],this.session.id)){
          report.outcome='stale';this.note('ollama-stale','Local goal advice discarded: worker/progress/safety boundary changed.',a);return;
        }
        validResponse=true;
        if(advice.goalId){
          const prior=captured.candidates.find(c=>c.id===advice.goalId);
          const candidate=this.consultationSnapshot(a,current).candidates.find(c=>c.id===advice.goalId);
          if(!prior||!candidate||!sameCandidate(prior,candidate)){
            report.outcome='rejected';requireNewEvidence=true;
            this.note('ollama-stale-goal','Ollama goal is no longer the same allowed registered candidate. No preference issued.',a);return;
          }
          report.preferenceIssued=this.applyAdvice(current,advice);
          report.outcome=report.preferenceIssued?'preference-issued':'rejected';
          this.note(report.preferenceIssued?'ollama-goal':'ollama-not-applied',report.preferenceIssued
            ?'Local preference issued for worker revalidation; this is NOT verified game progress.'
            :'Local advice rejected by existing fresh-plan checks.',a);
        }else{report.outcome='no-goal';requireNewEvidence=true;this.note('ollama-no-goal',advice.reason,a);}
      }
    }).catch(error=>{
      report.outcome=abort.signal.aborted?'aborted':'error';
      report.error=abort.signal.aborted?'LOCAL_CANCELLED_OR_TIMED_OUT':localFailureCode(error);
      this.note('ollama-unavailable','Ollama '+report.error+'; no paid model was started.',a);
    }).finally(()=>{
      clearTimeout(timeout);report.finishedAt=Date.now();
      this.localRounds.finish(s,attempt,validResponse,requireNewEvidence);
      this.localStates[a]='Consultation '+attempt+'/3 '+report.outcome+'. '+(report.recheck??'Awaiting fresh local rechecks.');
      if(this.local?.abort===abort)this.local=undefined;
      try{this.persistLocalReports();this.save();}catch(error){this.note('ollama-report-error','Could not persist local report: '+localFailureCode(error),a);}
    });
    this.local={agent:a,snapshot:captured,abort,done};
  }

  refreshApprovals(){
    const snapshots=this.snapshots();
    // Keep ApprovalBook's exact-snapshot invalidation unchanged. If an automatic
    // request is cancelled only by ordinary exact-scope churn while the same
    // capability problem remains fresh/safe, remove only the manager cooldown.
    // The next normal eligible monitor pass must create a NEW immutable request.
    const before=new Map(this.approvals.rows.filter(r=>r.status==='requested'&&r.why?.origin==='automatic')
      .map(r=>[r.agent,{id:r.id,key:r.why!.problemKey}]));
    this.approvals.reconcile(snapshots,this.session.modes,this.session.id);
    for(const [agent,old] of before){
      const row=this.approvals.rows.find(r=>r.id===old.id),s=snapshots[agent];
      if(row?.status==='cancelled'&&row.invalidReason==='Observation, goal, recovery state, progress or control session changed.'
        &&fresh(s,this.session.id)&&this.session.modes[agent]==='running'&&!s.pending
        &&(!s.planning||s.planning.clearance==='ready')&&problemKey(s)===old.key){
        const last=this.lastRequest.get(agent);
        if(last?.key===old.key)this.lastRequest.delete(agent);
      }
    }
    const local=this.local;
    if(local&&!localResultCurrent(local.snapshot,snapshots[local.agent],this.session.modes[local.agent],this.session.id))local.abort.abort();
    const running=this.consultant;
    if(running){const r=this.approvals.find(running.id),s=snapshots[r.agent];
      if(this.session.modes[r.agent]!=='running'||!fresh(s,this.session.id)||s.pending||s.context!==r.snapshot.context
        ||s.fingerprint!==r.snapshot.fingerprint)running.abort.abort();}
  }
  start(a:Agent) {
    agentName(a);this.trace.add('start-attempt',this.closing?'manager-already-closing':'operator-or-retry',undefined,a);
    if(this.closing){this.trace.add('start-denied','manager-already-closing',undefined,a);throw new Error('TEAM_STOPPING');}
    if(this.monitorFault)throw new Error('TEAM_MONITOR_FAULT: '+this.monitorFault);
    if(this.managerRestartRequired())throw new Error('OVERSEER_RESTART_REQUIRED: controller source changed; use Stop All, then relaunch Herdr before starting workers.');
    if(this.children.has(a)){this.session.modes[a]='running';this.processes[a]!.status='running';this.save();return;}
    if(existsSync(join(this.root,'data/supervisor',a+'.paused')))throw new Error('EXISTING_MANUAL_PAUSE: inspect before resuming '+a);
    this.escalation.reset(a);this.localRounds.reset(a);this.localEvidence.reset(a);delete this.localStates[a];
    const j=job(this.root,a),started=Date.now(),prefix=join(this.root,'data/supervisor',a+'-'+started),build=installedWorkerRuntime(this.root,a);
    const out=openSync(prefix+'.log','a',0o600),err=openSync(prefix+'.err','a',0o600);
    this.session.modes[a]='running';this.save();
    try {
      const child=launch({file:process.execPath,...j,env:{...process.env,CLAWSCAPE_TEAM_ROOT:this.root,
        CLAWSCAPE_TEAM_SESSION:this.session.id,CLAWSCAPE_TEAM_AGENT:a,CLAWSCAPE_EXECUTOR_REVISION:build.sourceHash}},out,err);
      child.stdin?.end();this.children.set(a,child);
      this.processes[a]={status:'running',pid:child.pid,started:new Date(started).toISOString(),log:prefix+'.log',errorLog:prefix+'.err',sourceHash:build.sourceHash,sourceFiles:build.files};
      child.once('error',()=>{this.note('launch-failed','Worker executable could not be started.',a);});
      child.once('close',code=>{
        if(this.children.get(a)!==child)return;this.children.delete(a);
        const requested=this.session.modes[a];
        if(!this.closing&&requested==='running'&&code===0){
          this.processes[a]={...this.processes[a],status:'retry-backoff',retryAt:Date.now()+60_000};
        }else{
          this.session.modes[a]='stopped';this.processes[a]={...this.processes[a],status:requested==='stopped'?'stopped':'needs-attention',reason:'exit '+code};
        }
        try{this.save();}catch(error){this.monitorFault=errorCode(error);this.trace.add('worker-exit-persist-error','worker-closed',error,a);}
      });
      this.note('start','Started the existing profile with exclusive team ownership.',a);this.save();
    } finally {closeSync(out);closeSync(err);}
  }
  pause(a:Agent){
    agentName(a);if(this.session.modes[a]!=='stopped'){this.session.modes[a]='paused';this.processes[a]={...this.processes[a],status:'paused'};delete this.processes[a]!.retryAt;}
    this.escalation.pause(a);
    if(this.local?.agent===a)this.local.abort.abort();
    if(this.consultant&&this.approvals.find(this.consultant.id).agent===a)this.consultant.abort.abort();
    let failure:unknown;
    try{this.approvals.cancelFor(a,'Character paused; old advice scope is not reusable.');}catch(error){failure=error;}
    this.save();if(failure)throw failure;
  }
  async stop(a:Agent){
    agentName(a);this.session.modes[a]='stopped';delete this.session.objectives[a];
    this.escalation.reset(a);
    if(this.local?.agent===a)this.local.abort.abort();
    let failure:unknown;
    try{this.approvals.cancelFor(a,'Character stopped; old advice scope is not reusable.');}catch(error){failure=error;}
    try{this.save();}catch(error){failure=error;this.trace.add('stop-persist-error','stop-request',error,a);}
    if(this.consultant&&this.approvals.find(this.consultant.id).agent===a)this.consultant.abort.abort();
    const child=this.children.get(a);
    if(child){
      if(!failure&&child.exitCode===null&&child.signalCode===null){
        let timer:ReturnType<typeof setTimeout>|undefined;
        await new Promise<void>(resolve=>{
          const done=()=>{if(timer)clearTimeout(timer);child.removeListener('close',done);resolve();};
          timer=setTimeout(done,3000);child.once('close',done);
        });
      }
      await terminate(child);this.children.delete(a);
    }
    this.processes[a]={status:'stopped'};this.note('stop','Stopped local processes; historical action outcomes remain journaled.',a);
    try{this.save();}catch(error){failure??=error;this.trace.add('stop-persist-error','stop-result',error,a);}
    if(!AGENTS.some(x=>this.session.modes[x]==='running'))await this.stopLocal();
    if(failure)throw failure;
  }
  /** Explicit operator restart. Stop preserves journals; a new worker first
   * reconciles them, so this never replays an in-flight action. */
  async restart(a:Agent){
    agentName(a);
    if(this.managerRestartRequired())throw new Error('OVERSEER_RESTART_REQUIRED: controller source changed; relaunch Herdr before restarting workers.');
    await this.stop(a);
    if(this.closing)throw new Error('TEAM_STOPPING');
    this.start(a);
  }
  assign(a:Agent,goalId:string,reason='Operator-selected temporary objective',automatic=false) {
    const s=this.snapshots()[a];if(this.session.modes[a]!=='running'||!fresh(s,this.session.id)||!s.candidates.some(c=>c.id===goalId))throw new Error('FRESH_LISTED_GOAL_REQUIRED');
    if(this.closing)throw new Error('TEAM_STOPPING');
    if(s.pending||s.planning&&s.planning.clearance!=='ready')throw new Error('RECOVERY_OR_SAFETY_GUARD_ACTIVE');
    if(automatic&&(!safeForAdvice(s)||!s.candidates.find(c=>c.id===goalId)?.plan?.registered))throw new Error('REGISTERED_PLAN_REQUIRED');
    this.approvals.cancelFor(a,'A new objective was selected; review a fresh scope instead.');
    this.session.objectives[a]={id:randomUUID(),agent:a,goalId,reason:text(reason),context:s.context,
      issuedAt:Date.now(),expiresAt:Date.now()+5*60_000,replace:s.stalled};
    this.note('objective',reason,a);this.save();return this.session.objectives[a]!.id;
  }
  applyAdvice(original:WorkerSnapshot,advice:Advice){
    const current=this.snapshots()[original.agent];
    this.note('result',advice.reason,original.agent);
    if(!this.closing&&advice.goalId&&this.session.modes[original.agent]==='running'&&fresh(current,this.session.id)&&!current.pending
      &&(!current.planning||current.planning.clearance==='ready')&&current.currentGoal===original.currentGoal
      &&current.context===original.context&&current.fingerprint===original.fingerprint)
      try{this.assign(original.agent,advice.goalId,advice.reason,true);return true;}
      catch{this.note('advice-not-applied','Advice did not match a currently registered, safe plan. No goal was changed.',original.agent);}
    return false;
  }
  requestHelp(s:WorkerSnapshot,origin:'automatic'|'operator'='operator'):Consultation|undefined {
    const current=this.snapshots()[s.agent];
    const valid=!this.closing&&this.session.modes[s.agent]==='running'&&fresh(current,this.session.id)
      &&current.fingerprint===s.fingerprint&&current.context===s.context&&current.currentGoal===s.currentGoal
      &&!current.pending&&(!current.planning||current.planning.clearance==='ready');
    if(!valid){if(origin==='operator')throw new Error('STATE_CHANGED_OR_RECOVERY_PENDING');return;}
    if(origin==='automatic'&&!this.escalationStatus(s.agent).eligible)return;
    try {
      const r=this.approvals.request(current,Date.now(),this.escalation.why(current,origin));
      if(r.status!=='requested')this.note('consultation-cooldown','This problem already has a terminal request; no replacement is created during cooldown.',s.agent);
      return r;
    }catch(error){
      this.note('help-request',error instanceof Error?error.message:'CONSULTATION_UNAVAILABLE',s.agent);
      if(origin==='operator')throw error;
    }
  }
  async approve(id:string,hash:string,humanTTY:boolean):Promise<void> {
    if(!humanTTY)throw new Error('INTERACTIVE_HUMAN_APPROVAL_REQUIRED');
    if(this.consultant||this.local||this.closing)throw new Error('CONSULTANT_BUSY_OR_STOPPING');
    this.refreshApprovals();
    const preview=this.approvals.find(id),s=this.snapshots()[preview.agent];
    if(this.session.modes[preview.agent]!=='running'||!fresh(s,this.session.id)||s.context!==preview.snapshot.context
      ||s.pending||s.currentGoal!==preview.snapshot.currentGoal||s.planning&&s.planning.clearance!=='ready'
      ||s.fingerprint!==preview.snapshot.fingerprint)throw new Error('STATE_CHANGED_REQUEST_FRESH_CONSULTATION');
    const request=this.approvals.consume(id,hash);const abort=new AbortController();
    const done=consult(this.config.codexBinary,request,abort.signal).then(advice=>{
      this.approvals.finish(id,'completed',advice.reason);if(!this.closing)this.applyAdvice(request.snapshot,advice);
    }).catch(()=>this.approvals.finish(id,abort.signal.aborted?'interrupted':'failed','Consultation stopped/unavailable. No automatic retry or direct game action.'))
      .finally(()=>{this.consultant=undefined;this.save();});
    this.consultant={abort,done,id};this.save();
  }
  stopLocal():Promise<void>{
    if(this.localStop)return this.localStop;
    this.localStop=(async()=>{const running=this.local;if(running){running.abort.abort();await running.done;}
      if(this.config.localModel)await unloadLocal(this.config.localModel);})().finally(()=>{this.localStop=undefined;});
    return this.localStop;
  }
  close(reason:CloseReason='api-close'):Promise<void>{
    if(this.closeTask)return this.closeTask;
    this.closing=true;this.shutdownReason=reason;clearInterval(this.timer);this.session.active=false;
    for(const a of AGENTS)this.session.modes[a]='stopped';
    this.trace.add('close-begin',reason);
    const consultant=this.consultant;consultant?.abort.abort();
    // Assign before lifecycle listeners can re-enter close(). A persistence error
    // must not skip child cleanup or release ownership while others still stop.
    this.closeTask=Promise.resolve().then(async()=>{
      let failure:unknown;
      try{this.save();}catch(error){failure=error;this.trace.add('close-persist-error',reason,error);}
      const results=await Promise.allSettled([...AGENTS.map(a=>this.stop(a)),this.stopLocal(),consultant?.done]);
      for(const result of results)if(result.status==='rejected')failure??=result.reason;
      this.closed=true;
      try{this.save();}catch(error){failure??=error;}
      finally{this.release();}
      this.trace.add(failure?'close-complete-with-errors':'close-complete',reason,failure);
      if(failure)throw failure;
    });
    this.lifecycleEvents.emit('closing',reason);
    return this.closeTask;
  }
}

/** A new Overseer/control process receives a new irreversible shutdown boundary. */
export function createTeamManager(root:string){return new TeamManager(root);}
