import { existsSync, readFileSync } from 'node:fs';
import { saveGoalJson } from './persistence';

export type GoalPhase = 'set'|'plan'|'prepare'|'execute'|'review'|'learn'|'completed'|'blocked'|'suspended';
export type GoalStatus = 'unknown'|'missing'|'ready'|'blocked';
export type GoalPrerequisite = { id:string; description:string; status:GoalStatus; evidence?:string };
export type GoalOutcome = { at:number; status:'success'|'partial'|'failure'|'interrupted'; evidence:string[]; reason?:string };
export type GoalLearning = { at:number; lesson:string; behavior:string; confidence:'confirmed'|'suspected'|'unresolved'; uses:number };
export type ConcreteTask = { id:string; target:string; method:string; dependencies:string[]; resourceBudget:Record<string,number>; stopConditions:string[]; status:'ready'|'active'|'suspended'|'completed'|'blocked'; startedAt:number; attempts:number; lastOutcome?:GoalOutcome };
export type PersistentGoal = {
  id:string; title:string; role:string; build:string; kind?:string; why:string; phase:GoalPhase;
  steps:string[]; currentStep:number; prerequisites:GoalPrerequisite[];
  success:string[]; partial:string[]; failure:string[];
  limits:{ deadlineMs?:number; maxRisk?:number; maxResource?:Record<string,number> };
  startedAt:number; updatedAt:number; lastProgressAt:number; nextReviewAt?:number;
  blocker?:{ reason:string; attempts:number; retryAt?:number };
  planVersion:number; outcomes:GoalOutcome[]; learnings:GoalLearning[];
  task?:ConcreteTask;
};
export type GoalLifecycle = { active?:PersistentGoal; history:PersistentGoal[]; preferredMethods:Record<string,string>; updatedAt:number };
export type GoalDefinition = Omit<PersistentGoal,'phase'|'startedAt'|'updatedAt'|'lastProgressAt'|'planVersion'|'outcomes'|'learnings'|'currentStep'|'blocker'> & { currentStep?:number };

export function emptyLifecycle():GoalLifecycle { return { history:[], preferredMethods:{}, updatedAt:Date.now() }; }
export function loadLifecycle(file:string):GoalLifecycle {
  if (!existsSync(file)) return emptyLifecycle();
  try { const v=JSON.parse(readFileSync(file,'utf8')); return { ...emptyLifecycle(), ...v, history:Array.isArray(v.history)?v.history:[] }; } catch { return emptyLifecycle(); }
}
export function saveLifecycle(file:string, value:GoalLifecycle):void { value.updatedAt=Date.now(); saveGoalJson(file,value); }

export function setGoal(l:GoalLifecycle, d:GoalDefinition, now=Date.now()):PersistentGoal {
  if (l.active?.id===d.id) return l.active;
  if (l.active) l.history.push(l.active);
  const goal:PersistentGoal={...d, currentStep:d.currentStep??0, phase:'set', startedAt:now, updatedAt:now, lastProgressAt:now, planVersion:1, outcomes:[], learnings:[]};
  l.active=goal; return goal;
}
export function advance(l:GoalLifecycle, phase:GoalPhase, now=Date.now()):PersistentGoal|undefined {
  if (!l.active) return; l.active.phase=phase; l.active.updatedAt=now; return l.active;
}
export function markPrerequisite(l:GoalLifecycle,id:string,status:GoalStatus,evidence?:string,now=Date.now()):void {
  const p=l.active?.prerequisites.find(x=>x.id===id); if (!p) return; p.status=status; if(evidence)p.evidence=evidence; if(l.active)l.active.updatedAt=now;
}
export function recordOutcome(l:GoalLifecycle,outcome:GoalOutcome,now=Date.now()):void {
  if(!l.active)return; l.active.outcomes.push(outcome); l.active.phase='review'; l.active.updatedAt=now;
  if(outcome.status==='success'||outcome.status==='partial') {
    l.active.lastProgressAt=now;
    // A blocker explains the last failed attempt, not the whole lifetime of
    // the goal. Once a later action produces verified progress, clear it so
    // dashboards and restart decisions do not report stale recovery causes.
    delete l.active.blocker;
  }
  if(l.active.task){ l.active.task.lastOutcome=outcome; l.active.task.status=outcome.status==='failure'?'blocked':outcome.status==='interrupted'?'suspended':outcome.status==='success'?'completed':'active'; }
}
export function learn(l:GoalLifecycle,lesson:string,behavior:string,confidence:GoalLearning['confidence']='confirmed',now=Date.now()):void {
  if(!l.active)return; const existing=l.active.learnings.find(x=>x.lesson===lesson&&x.behavior===behavior);
  if(existing){existing.uses++;existing.at=now;} else l.active.learnings.push({at:now,lesson,behavior,confidence,uses:1});
  l.preferredMethods[l.active.id]=behavior; l.active.phase='learn'; l.active.updatedAt=now;
}
export function blockOrRetry(l:GoalLifecycle,reason:string,now=Date.now(),retryMs=60_000):void {
  if(!l.active)return; const attempts=(l.active.blocker?.attempts??0)+1; l.active.blocker={reason,attempts,retryAt:now+retryMs}; l.active.phase=attempts>=3?'blocked':'prepare'; l.active.updatedAt=now;
}
export function ensureTask(l:GoalLifecycle, task:Omit<ConcreteTask,'startedAt'|'attempts'|'status'>, now=Date.now()):ConcreteTask|undefined {
  if(!l.active)return;
  if(l.active.task?.id===task.id && !['completed','blocked'].includes(l.active.task.status)) return l.active.task;
  l.active.task={...task,status:'ready',startedAt:now,attempts:0}; l.active.updatedAt=now; return l.active.task;
}
export function startTask(l:GoalLifecycle,now=Date.now()):void { if(l.active?.task){l.active.task.status='active';l.active.task.attempts++;l.active.updatedAt=now;} }
export function resumable(l:GoalLifecycle,now=Date.now()):PersistentGoal|undefined {
  const g=l.active; if(!g)return; if(g.phase==='blocked'&&g.blocker?.retryAt&&now<g.blocker.retryAt)return; return g;
}
