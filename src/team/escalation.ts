import { digest, fresh, text, type Agent, type Candidate, type Mode, type WorkerSnapshot } from './protocol.ts';

/** All times are measured while a worker supplies new, usable observations.
 * Historic progress timestamps are displayed, never used as elapsed run time. */
export const ESCALATION = Object.freeze({graceMs:120_000, trialMs:120_000, sustainedMs:600_000,
  minTrials:3, recheckMs:120_000, maxGapMs:10_000, requestCooldownMs:300_000});
export type Trial = {goalId:string;family:string;objectiveId:string;startedActiveMs:number;
  accepted:boolean;selected:boolean;status:'waiting'|'accepted'|'unproductive'|'rejected'|'not-accepted';reason?:string};
export type EscalationView = {phase:string;reason:string;activeMs:number;noProgressMs:number;decisionNoProgressMs:number;
  trials:number;rechecks:number;problemKey?:string;nextGoal?:string;eligible:boolean};
export type ConsultationWhy = {origin:'automatic'|'operator';problemKey:string;summary:string;
  activeNoProgressMs:number;localTrials:number;feasibilityRechecks:number;evidence:string[]};
type State = {session:string;run:string;context:string;lastAt:number;lastSeen:number;eligibleLast:boolean;
  activeMs:number;baselineMs:number;progressAt:number|null;stallAt:number;stallSeen:number;stallMs:number;stallProgressAt:number|null;trial?:Trial;trials:Trial[];
  nextTrialAt:number;nextRecheckAt:number;rechecks:number;view:EscalationView};
export function safeForAdvice(s:WorkerSnapshot):boolean {
  return !s.pending && s.planning?.version===1 && s.planning.clearance==='ready';
}
function validPlan(c:Candidate):boolean {
  const p=c.plan;
  return !!p && p.registered===true && typeof p.family==='string'&&p.family.length<=500
    && typeof p.firstMethodId==='string'&&p.firstMethodId.length<=500
    && typeof p.capability==='string' && [p.steps,p.durationMs,p.costGp,p.lossBoundGp].every(Number.isFinite)
    && p.steps>0&&p.durationMs>0&&p.costGp>=0&&p.lossBoundGp>=0;
}
export function problemKey(s:WorkerSnapshot):string {
  // A different tile, item-slot, timestamp or fingerprint is NOT a new problem.
  const kind=s.planning?.unavailable.length?'capability-gap':s.candidates.some(validPlan)?'local-trials-without-result':'no-registered-plan';
  return digest([s.agent,s.context,kind,[...(s.planning?.unavailable??[])].sort()]);
}
const blank = (reason='Worker has not supplied a current observation.'):EscalationView =>
  ({phase:'waiting',reason,activeMs:0,noProgressMs:0,decisionNoProgressMs:0,trials:0,rechecks:0,eligible:false});
/** This coordinator issues temporary preferences only; it never executes game
 * actions, clears a receipt, or declares a trial to be a failed game action. */
export class EscalationTracker {
  private states=new Map<Agent,State>();
  reset(a:Agent){this.states.delete(a);}
  pause(a:Agent){const st=this.states.get(a);if(st){st.eligibleLast=false;st.lastAt=0;st.lastSeen=0;st.stallAt=0;st.stallSeen=0;st.stallMs=0;
    st.view={...st.view,phase:'paused',reason:'Paused time does not count toward escalation.',noProgressMs:0,eligible:false,nextGoal:undefined};}}
  view(a:Agent):EscalationView{return {...(this.states.get(a)?.view??blank())};}
  observe(a:Agent,s:WorkerSnapshot|undefined,mode:Mode,session:string,now=Date.now()):EscalationView {
    let st=this.states.get(a);
    if(mode!=='running'||!fresh(s,session,now)||s.agent!==a){
      if(st){st.eligibleLast=false;st.stallAt=0;st.stallSeen=0;st.stallMs=0;st.view={...st.view,phase:mode==='running'?'waiting':mode,
        reason:mode==='running'?'Waiting for a fresh connected worker observation.':'Stopped/paused time is excluded.',noProgressMs:0,eligible:false,nextGoal:undefined};}
      return this.view(a);
    }
    const run=s.workerRun??'legacy';
    if(!st||st.session!==session||st.run!==run||st.context!==s.context){
      st={session,run,context:s.context,lastAt:0,lastSeen:now,eligibleLast:false,activeMs:0,baselineMs:0,
        progressAt:s.progressAt,stallAt:0,stallSeen:now,stallMs:0,stallProgressAt:s.progressAt,trials:[],nextTrialAt:ESCALATION.graceMs,nextRecheckAt:ESCALATION.graceMs,
        rechecks:0,view:blank()};this.states.set(a,st);
    }
    const eligible=safeForAdvice(s),newObservation=s.at>st.lastAt,newStallObservation=s.at>st.stallAt;
    if(s.at<st.lastAt||s.at<st.stallAt){this.reset(a);return this.observe(a,s,mode,session,now);}
    // Diagnostic active-stall time is deliberately separate from advice-eligible time.
    // A worker that keeps publishing fresh stalled observations while reconciling an
    // unknown action is still visibly stalled, but recovery never earns escalation credit.
    if(newStallObservation){
      const delta=s.at-st.stallAt;
      if(s.stalled&&eligible===st.eligibleLast&&st.stallAt>0&&delta<=ESCALATION.maxGapMs&&now-st.stallSeen<=ESCALATION.maxGapMs)st.stallMs+=delta;
      st.stallAt=s.at;st.stallSeen=now;
    }
    if(newObservation){
      const delta=s.at-st.lastAt;
      if(eligible&&st.eligibleLast&&st.lastAt>0&&delta<=ESCALATION.maxGapMs&&now-st.lastSeen<=ESCALATION.maxGapMs)st.activeMs+=delta;
      st.lastAt=s.at;st.lastSeen=now;st.eligibleLast=eligible;
    } else if(!eligible||now-st.lastSeen>ESCALATION.maxGapMs)st.eligibleLast=false;
    const verifiedProgress=s.progressAt!==null&&s.progressAt<=now&&(st.progressAt===null||s.progressAt>st.progressAt);
    if(verifiedProgress){
      st.baselineMs=st.activeMs;st.progressAt=s.progressAt;st.stallMs=0;st.stallProgressAt=s.progressAt;st.trials=[];st.trial=undefined;st.rechecks=0;
      st.nextTrialAt=st.activeMs+ESCALATION.graceMs;st.nextRecheckAt=st.activeMs+ESCALATION.recheckMs;
    }
    if(!s.stalled)st.stallMs=0;
    const decisionNoProgressMs=st.activeMs-st.baselineMs,noProgressMs=st.stallMs;
    const count=()=>new Set(st.trials.filter(t=>t.status==='unproductive').map(t=>t.family)).size;
    const output=(phase:string,reason:string,nextGoal?:string,allow=false):EscalationView=>{
      st!.view={phase,reason,activeMs:st!.activeMs,noProgressMs,decisionNoProgressMs,trials:count(),rechecks:st!.rechecks,
        problemKey:problemKey(s),nextGoal,eligible:allow};return this.view(a);};
    if(!eligible)return output(s.pending||s.planning?.clearance==='recovery'?'recovering':'guarded',
      s.pending?'Existing action is still reconciling. No goal replacement or automatic consultation.':
      s.planning?.version!==1?'Updated planning metadata is required for automatic help.':'Safety/uncertainty guard remains authoritative.');
    if(!s.stalled)return output('progressing','Worker is not reporting a sustained stall; keep its current objective.');
    if(decisionNoProgressMs<ESCALATION.graceMs)return output('observing','Collecting two minutes of fresh active observations before intervention.');
    if(st.trial){
      const trial=st.trial,r=s.objectiveReceipt;
      if(s.currentGoal===trial.goalId)trial.selected=true;
      if(r?.id===trial.objectiveId){
        if(r.status==='accepted'){trial.accepted=true;trial.status='accepted';}
        if(r.status==='rejected'){trial.status='rejected';trial.reason=text(r.reason);}
      }
      if(trial.status==='rejected'||st.activeMs-trial.startedActiveMs>=ESCALATION.trialMs){
        if(trial.status!=='rejected'){
          trial.status=trial.accepted&&trial.selected?'unproductive':'not-accepted';
          trial.reason=trial.accepted&&trial.selected?'Worker acknowledged and selected this plan; no verified progress during the bounded active trial.':
            'Preference was not both acknowledged and observed as the selected plan. Not counted as a local trial.';
        }
        st.trials.push({...trial});st.trials=st.trials.slice(-12);st.trial=undefined;
        st.nextTrialAt=st.activeMs;
      }else return output('local-trial','Observing one bounded local preference; it is not a verified game result.',trial.goalId);
    }
    const tried=new Set(st.trials.map(t=>t.family));
    const choices=s.candidates.filter(c=>validPlan(c)&&c.id!==s.currentGoal&&c.plan!.family!==s.planning?.currentFamily&&!tried.has(c.plan!.family));
    // Preserve source order (worker planner knowledge), with no named character,
    // fixed training goal, coordinate or hardcoded fallback activity.
    const choice=choices[0];
    if(choice&&st.activeMs>=st.nextTrialAt)return output('local-replan','Try a different registered, currently plannable approach before paid help.',choice.id);
    if(newObservation&&st.activeMs>=st.nextRecheckAt){st.rechecks++;st.nextRecheckAt=st.activeMs+ESCALATION.recheckMs;}
    if(decisionNoProgressMs<ESCALATION.sustainedMs)return output('observing','Local alternatives/rechecks continue; ten active minutes are required for automatic help.');
    const alternatives=s.candidates.filter(c=>validPlan(c)&&c.id!==s.currentGoal&&c.plan!.family!==s.planning?.currentFamily);
    const noPlans=alternatives.length===0;
    const completed=new Set(st.trials.filter(t=>t.status==='unproductive').map(t=>t.family));
    const exhaustedAvailable=alternatives.length>0&&alternatives.every(c=>completed.has(c.plan!.family));
    if(count()<ESCALATION.minTrials&&!((noPlans||exhaustedAvailable)&&st.rechecks>=3))return output('insufficient-evidence',
      'Automatic help needs selected local trials, or repeated evidence that independent registered alternatives are unavailable/exhausted. Manual help remains optional.');
    return output('help-eligible',noPlans?'Repeated fresh feasibility checks found no independent registered alternative; ask for advice about the missing capability.':
      'Different bounded local trials produced no verified progress. Advice may identify a missing capability.',undefined,true);
  }
  markTrial(a:Agent,candidate:Candidate,objectiveId:string){
    const st=this.states.get(a);if(!st||!validPlan(candidate))throw new Error('TRIAL_REQUIRES_FRESH_PLAN');
    st.trial={goalId:candidate.id,family:candidate.plan!.family,objectiveId,startedActiveMs:st.activeMs,accepted:false,selected:false,status:'waiting'};
    st.view={...st.view,phase:'local-trial',reason:'Temporary preference sent; waiting for worker acknowledgement.',eligible:false,nextGoal:candidate.id};
  }
  why(s:WorkerSnapshot,origin:'automatic'|'operator'):ConsultationWhy {
    const st=this.states.get(s.agent),v=this.view(s.agent);
    return {origin,problemKey:problemKey(s),summary:origin==='operator'?'Explicit operator request for advice.':v.reason,
      activeNoProgressMs:v.decisionNoProgressMs,localTrials:v.trials,feasibilityRechecks:v.rechecks,
      evidence:(st?.trials??[]).filter(t=>t.status==='unproductive')
        .map(t=>text(t.family+': '+t.reason,350)).slice(-6)};
  }
}
