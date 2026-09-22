import { AGENTS, text, type Agent, type WorkerSnapshot } from './protocol.ts';
import type { Consultation } from './approvals.ts';
import type { EscalationView } from './escalation.ts';
const time=(ms:number)=>Math.floor(Math.max(0,ms)/60_000)+'m '+Math.floor(Math.max(0,ms)/1000%60)+'s';
export function requestSummary(rows:Consultation[]):string {
  const requests=rows.filter(r=>r.status==='requested');
  if(!requests.length)return 'No consultation awaiting approval. Codex is not started by this command.';
  return ['APPROVAL REQUESTS (advice only; nothing launches here)',...requests.map(r=>[
    r.id.slice(0,8)+' | '+r.agent+' | '+(r.why?.origin??'legacy')+' | max '+Math.floor(r.timeoutMs/1000)+'s',
    '  Why: '+text(r.why?.summary??'Legacy request; inspect exact scope before use.',200),
    '  Active time without progress: '+time(r.why?.activeNoProgressMs??0)+' | local trials: '+(r.why?.localTrials??0)+' | feasibility rechecks: '+(r.why?.feasibilityRechecks??0),
    '  Inspect: requests '+r.id.slice(0,8)+' | Refuse: deny '+r.id.slice(0,8)
  ].join('\n')),'Use requests ID to inspect the exact scope and approval code. A time limit is not an exact token/cost cap.'].join('\n');
}
export function requestDetails(r:Consultation){
  return {id:r.id,status:r.status,agent:r.agent,why:r.why??null,question:r.question,snapshot:r.snapshot,
    maxSeconds:r.timeoutMs/1000,invalidReason:r.invalidReason??null,
    warning:'Uses your configured Codex allowance ONLY after approval. No exact token/cost ceiling. No automatic paid retry.',
    ...(r.status==='requested'?{approve:'approve '+r.id.slice(0,8)+' '+r.scopeHash.slice(0,12),deny:'deny '+r.id.slice(0,8)}:{})};
}
export function statusText(phase:string,processes:Partial<Record<Agent,{status:string}>>,snapshots:Partial<Record<Agent,WorkerSnapshot>>,
  decisions:Partial<Record<Agent,EscalationView>>,rows:Consultation[],now=Date.now(),reloadRequired=false):string {
  return ['TEAM STATUS '+new Date(now).toISOString(),'Manager: '+phase,
    ...(reloadRequired?['DEPLOYMENT REQUIRED: this Overseer is running an older build. Type reload, then start all. Reload stops workers but preserves their journals.']:[]),
    ...AGENTS.map(a=>{
      const s=snapshots[a],d=decisions[a];
      const state=!s?'awaiting observation':s.pending?'reconciling':s.stalled?'recovering':'active';
      return a+' | '+(processes[a]?.status??'stopped')+' | '+state+' | active stall '+time(d?.noProgressMs??0)
        +'\n  Goal: '+text(s?.currentGoal??'-',140)+(s?.blocked?'\n  Blocker: '+text(s.blocked,220):'')
        +'\n  Decision: '+text(d?.reason??'No current-run evidence.',220);
    }),requestSummary(rows),'Historical time since last verified progress is separate from active stall time.','Display held for reading. Type dashboard to resume automatic redraw.'].join('\n');
}
