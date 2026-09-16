import { join } from 'node:path';
import { settleAstraTransient } from './transient-recovery.ts';
import type { Observation, ActionResult } from './contracts.ts';
import { evidence } from './arbiter.ts';
import type { Store } from './store.ts';
import type { LiveAgency } from '../../../src/agency/live-adapter.ts';
import { agencyState, agencyCandidate, arbiterVerification, observedVerification } from './agency-bridge.ts';
import { finalizeQuarantinedAction } from './transaction-quarantine.ts';
import { atomicRecoveryJson, durableRecoveryEvidence, recoverLegacyJournals } from '../../../src/agency/journal-recovery.ts';

export type RestartReport = { version:1; at:number; ready:boolean; resolved:string[]; unresolved:Array<{commandId:string;operation:string;reason:string;settling?:boolean}> };
export function unsettledResult(r:ActionResult):boolean {
  return !((r.status==='SUCCEEDED'&&r.evidence.length>0)||r.status==='REJECTED'||r.status==='EXPIRED'
    ||r.status==='CANCELLED'&&!/MAY_STILL|OUTCOME_UNKNOWN|PREEMPTED/.test(r.reason));
}

/** No dispatch function is accepted. This reads snapshots and updates only local, matched journals.
 * Caller owns a non-executing recovery lease. Neither a timeout nor a new local session means failure. */
export function reconcileAstraJournals(store:Store,directory:string,first:Observation,second:Observation,agency?:LiveAgency):RestartReport {
  const control=store.control();
  if(control.mode!=='RECONCILING'||control.expires<=Date.now())throw new Error('RECOVERY_LEASE_REQUIRED');
  if(first.character!==second.character||first.world!==second.world||first.profile_id!==second.profile_id
    ||!second.connected||second.fresh_at===null||second.fresh_at>Date.now()||Date.now()-second.fresh_at>10_000||second.seq<=first.seq)
    throw new Error('FRESH_OWN_RECOVERY_OBSERVATIONS_REQUIRED');
  const report:RestartReport={version:1,at:Date.now(),ready:true,resolved:[],unresolved:[]};
  const checkpoints=store.records<{action_id:string;before:Observation}>('action_checkpoints');
  for(const entry of store.allActions()) {
    const {command,result}=entry;
    if(command.character!==second.character||command.world!==second.world||command.profile_id!==second.profile_id
      ||result.action_id!==command.action_id)throw new Error('EXECUTOR_JOURNAL_IDENTITY_MISMATCH');
    if(agency?.quarantinedTransaction(command.action_id)) {
      const retired=finalizeQuarantinedAction(store,agency,command.action_id);
      if(retired){report.resolved.push(command.action_id);continue;}
    }
    if(!unsettledResult(result))continue;
    let resolved:ActionResult|undefined;let settling=false;let why='No attributable terminal outcome; no replay is permitted.';
    if(result.status==='QUEUED')resolved={...result,status:'CANCELLED',reason:'RESTART_BEFORE_DISPATCH',at:Date.now(),evidence:['journal reservation never entered dispatch']};
    else {
      const before=checkpoints.find(c=>c.action_id===command.action_id)?.before;
      let proof:string[]=[];
      if(before && before.session_id===second.session_id)proof=evidence(command.intent,before,second);
      // session_id in this adapter is a local client UUID, NOT a server session generation.
      // Only exact stable durable fields can be recovered across that UUID change.
      if(before&&!proof.length) {
        try {
          const action=agencyCandidate(before,{goal:command.plan_id,reason:'recover exact recorded command',intent:command.intent});
          proof=durableRecoveryEvidence(agencyState(before),agencyState(first),action,agencyState(second));
        } catch { /* Missing original entity/slot is uncertainty, never a guessed mapping. */ }
      }
      if(proof.length)resolved={...result,status:'SUCCEEDED',reason:'RECONCILED_DURABLE_EFFECT',evidence:proof,at:Date.now()};
      else if(before&&['move','close_interface','style','dialogue','interact','pickup','use_on_item','use_on_object'].includes(command.intent.operation)) {
        const transient=settleAstraTransient(store,command,result,before,second);
        why=transient.reason;settling=transient.settling;
        // The shared helper writes its cancellation and immutable audit atomically.
        if(transient.result){report.resolved.push(command.action_id);continue;}
      }
    }
    if(resolved){store.result(resolved);report.resolved.push(command.action_id);}
    else report.unresolved.push({commandId:command.action_id,operation:command.intent.operation,reason:why,settling});
  }
  if(agency) for(const scope of ['safety','task'] as const) {
    const receipt=agency.pending(scope);if(!receipt)continue;
    const row=store.action(receipt.commandId);
    let proof=row?arbiterVerification(receipt.commandId,row.result):{status:'unknown' as const,evidence:[],reason:'No executor receipt matched.'};
    if(!row && receipt.action.type!=='wait' && !checkpoints.some(c=>c.action_id===receipt.commandId)) {
      // agency-v2 writes a receipt BEFORE Store reserves dispatch; validated runtime discovery
      // refuses a missing SQLite journal, so absence here proves that dispatch was never reserved.
      proof={status:'rejected',evidence:['No reservation in the existing exact executor journal; no dispatch.']};
    }
    if(receipt.action.type==='wait')proof={status:'verified',evidence:['observation-only wait retired; no gameplay effect inferred']};
    if(proof.status==='unknown') {
      const durable=durableRecoveryEvidence(receipt.before,agencyState(first),receipt.action,agencyState(second));
      if(durable.length)proof={status:'verified',evidence:durable};
    }
    agency.record(receipt.commandId,agencyState(second),proof);
    if(agency.pending(scope)&&scope==='task'&&proof.status==='unknown'&&row) {
      const current=agencyState(second);
      const observed=observedVerification(receipt.before,current,receipt.action);
      const q=agency.quarantinePendingTransaction(current,observed.reason??'');
      if(q&&finalizeQuarantinedAction(store,agency,q.commandId)) {
        report.unresolved=report.unresolved.filter(r=>r.commandId!==q.commandId);
        report.resolved.push(q.commandId);continue;
      }
    }
    if(agency.pending(scope)) {
      const pending=agency.pending(scope)!;
      report.unresolved.push({commandId:receipt.commandId,operation:receipt.action.type,
        reason:pending.investigation?.reason??proof.reason??'Pending accounting or safety outcome.',
        settling:!!pending.historicalWindow});
    }
  }
  const legacy=recoverLegacyJournals(directory,{agent:second.character,world:second.world},{
    state:agencyState(first),stable:agencyState(second),executorSettled:report.unresolved.length===0,
    executorHasHistory:store.allActions().length>0,legacyWorld:second.profile_id,apply:true,
  });
  for(const entry of legacy.entries.filter(e=>e.disposition==='unresolved'))
    report.unresolved.push({commandId:entry.commandId??entry.file,operation:'legacy-journal',reason:entry.reason});
  report.ready=legacy.ready&&report.unresolved.length===0;
  atomicRecoveryJson(join(directory,'startup-recovery.json'),report);
  store.append('restart_reconciliation',String(report.at),report);
  return report;
}
