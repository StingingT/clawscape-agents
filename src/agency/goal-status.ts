/** Read-only runtime summaries. A saved snapshot is not a live process check or evidence of progress. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { progressHealth } from './progress.ts';
import type { Memory } from './types.ts';
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const age=(at:unknown,now:number)=>finite(at)?Math.round((now-at)/1000):null;
const short=(v:unknown,max=1200)=>typeof v==='string'?v.slice(0,max):undefined;
export function summarizeGoalRuntime(doc:any,agent:string,now:number):Record<string,any> {
  if(doc?.version!==2||doc.memory?.agent!==agent||!Array.isArray(doc.memory?.reviews))
    throw new Error('RUNTIME_SNAPSHOT_IDENTITY_OR_VERSION_MISMATCH');
  const memory=doc.memory as Memory,active=memory.active,observation=doc.lastObservation;
  const observationAgeSeconds=age(observation?.at,now),updatedAgeSeconds=age(doc.updatedAt,now);
  const stale=observationAgeSeconds===null||observationAgeSeconds>60||observationAgeSeconds < -5;
  const receipt=doc.safetyReceipt??doc.receipt,pending=memory.pending;
  const status=stale?'stale-or-missing-observation':observation?.connected===false?'reported-disconnected':
    receipt||pending?'reported-pending-reconciliation':doc.blocked?'reported-blocked':active?'reported-active-goal':'reported-no-active-goal';
  const health=memory.progress?progressHealth(memory,now):undefined;
  return {
    available:true,status,isLiveProcessCheck:false,identity:{agent:memory.agent,world:memory.world,revision:memory.revision},updatedAt:doc.updatedAt??null,updatedAgeSeconds,
    observation:observation?{at:observation.at,tick:observation.tick,connected:observation.connected,position:observation.position}:null,
    observationAgeSeconds,stale,
    activeGoal:active?{id:active.id,key:active.key,domain:active.domain,target:active.target,reason:short(active.reason),evidence:active.evidence.slice(0,8),
      startedAt:active.startedAt,ageSeconds:age(active.startedAt,now),attempts:active.attempts,noProgress:active.noProgress,
      requestedSupport:active.requestedSupport,investigation:active.investigation?{id:active.investigation.id,target:active.investigation.target,reason:short(active.investigation.reason)}:null,
      nextPlannedMethod:active.plan?.steps[0]?.methodId??null,supportGoals:(active.supportGoals??[]).slice(-20),
      remainingBudget:{spendableGp:Math.max(0,active.budget.spendableGp-active.spentGp),maxLossGp:Math.max(0,active.budget.maxLossGp-active.lostGp),
        maxDurationMs:Math.max(0,active.budget.maxDurationMs-(now-active.startedAt))}}:null,
    pendingAction:receipt||pending?{commandId:receipt?.commandId??pending?.commandId,type:receipt?.action?.type??null,
      scope:receipt?.scope??'director',status:pending?.status??'receipt-only',methodId:receipt?.methodId??pending?.method?.id,
      startedAt:receipt?.startedAt,ageSeconds:age(receipt?.startedAt,now)}:null,
    blockedReason:short(doc.blocked)??null,
    progress:health?{stalled:health.stalled,lastProductiveAt:health.lastProductiveAt,lastVerifiedActionAt:health.lastVerifiedActionAt,
      note:'A verified action is not necessarily productive progress.'}:null,
    lastOutcome:doc.lastOutcome?{at:doc.lastOutcome.at,type:doc.lastOutcome.type,status:doc.lastOutcome.status,reason:short(doc.lastOutcome.reason),
      evidence:(doc.lastOutcome.evidence??[]).slice(0,8)}:null,
    lastReview:memory.reviews.length?{at:memory.reviews.at(-1)!.at,goalId:memory.reviews.at(-1)!.goal.id,result:memory.reviews.at(-1)!.result,
      reason:short(memory.reviews.at(-1)!.reason)}:null,
    archivedIntentions:(memory.intentPolicy?.archived??[]).slice(-128),
    note:'Saved own-state snapshot. nextPlannedMethod is not proof of dispatch; timestamps differ from the forecast report.'
  };
}
export function readGoalRuntime(file:string,agent:string,now:number):Record<string,any> {
  if(!existsSync(file))return {available:false,path:file,reason:'Runtime snapshot is absent; no live status inferred.'};
  try {
    // Never read a large log or recursively package live state as part of a report.
    if(statSync(file).size>16*1024*1024)return {available:false,path:file,reason:'Runtime snapshot exceeds the 16 MiB report read limit.'};
    return {...summarizeGoalRuntime(JSON.parse(readFileSync(file,'utf8')),agent,now),path:file};
  } catch(error){return {available:false,path:file,error:String(error)};}
}
