import { randomUUID } from 'node:crypto';
import { observeQuietStep, type QuietWindow } from '../../../src/agency/step-retry.ts';
import { agencyCandidate, agencyState } from './agency-bridge.ts';
import type { ActionCommand, ActionResult, Observation } from './contracts.ts';
import type { Store } from './store.ts';

const windows=new WeakMap<Store,Map<string,{observer:string;lease:string;window?:QuietWindow}>>();
/** Settlement is local bookkeeping, never a command dispatch or a historical success.
 * One helper serves startup and the live arbiter, avoiding a restart-only fix. */
export function settleAstraTransient(store:Store,command:ActionCommand,result:ActionResult,
  before:Observation,after:Observation,now=Date.now()):{result?:ActionResult;settling:boolean;reason:string} {
  const no=(reason:string)=>({settling:false,reason});
  const control=store.control();
  if(!['RECONCILING','RUNNING'].includes(control.mode)||control.disabled||control.expires<=now)
    return no('A live sole-controller lease is required for transient reconciliation.');
  if(control.mode==='RUNNING'&&control.lease!==command.lease)return no('Command belongs to another controller lease.');
  if(!['move','close_interface','style','dialogue'].includes(command.intent.operation))return no('Operation requires attributable terminal evidence.');
  if(command.action_id!==result.action_id||command.character!==after.character||command.world!==after.world
    ||command.profile_id!==after.profile_id||after.seq<=before.seq||after.fresh_at===null
    ||after.fresh_at>now||now-after.fresh_at>10_000)return no('Fresh matching own observations required.');
  const states=windows.get(store)??new Map();windows.set(store,states);
  const old=states.get(command.action_id);
  const saved=old?.lease===control.lease?old:{observer:randomUUID(),lease:control.lease};
  const dialogue=command.intent.operation==='dialogue';
  // Historical dialogue clicks are never declared successful from elapsed time. If the
  // original dialog was observed open and the current character remains in a stable,
  // closed-interface state for a full quiet window, retire only the obsolete click
  // context. Any future dialogue must be reopened and revalidated from a fresh snapshot.
  if(dialogue && before.dialog.open!==true)return no('Original dialogue context was not observed open; terminal evidence is still required.');
  const action=dialogue
    ? {type:'closeModal',fields:{}}
    : agencyCandidate(before,{goal:command.plan_id,reason:'Observe existing transient intent',intent:command.intent});
  const quiet=observeQuietStep(action,agencyState(before),agencyState(after),now,saved.observer,saved.window);
  saved.window=quiet.window;states.set(command.action_id,saved);
  if(!quiet.settled)return {settling:!!quiet.window,reason:quiet.reason};
  const reason=dialogue
    ? 'Historical dialogue context expired after a continuous fresh closed-interface quiet window; original effect remains unknown and no replay is authorized.'
    : quiet.reason;
  const settled:ActionResult={...result,status:'CANCELLED',reason:dialogue?'RECONCILED_DIALOGUE_CONTEXT_EXPIRED':'RECONCILED_TRANSIENT_INTERRUPTED',at:now,evidence:[reason]};
  store.db.transaction(()=>{
    const current=store.control(),entry=store.action(command.action_id);
    if(current.lease!==control.lease||current.mode!==control.mode||current.disabled||current.expires<=now
      ||entry?.result.status!==result.status||entry.result.at!==result.at)throw new Error('RECOVERY_STATE_CHANGED');
    store.append('transient_reconciliation',command.action_id,{original:entry,at:now,reason});
    store.result(settled);
  }).immediate();
  states.delete(command.action_id);
  return {result:settled,settling:false,reason};
}
