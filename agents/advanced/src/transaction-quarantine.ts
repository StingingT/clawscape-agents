import type { ActionResult, Observation } from './contracts.ts';
import type { Store } from './store.ts';
import type { LiveAgency } from '../../../src/agency/live-adapter.ts';
import { historicalActionIdentity } from '../../../src/agency/historical-context.ts';
import { agencyCandidate, agencyState } from './agency-bridge.ts';

export const HISTORICAL_QUARANTINE = 'HISTORICALLY_UNRESOLVED_QUARANTINED';

/** Complete only the exact shared-journal administrative decision. No dispatch,
 * claimed success, inferred failure, or reward. Safe to resume after a crash
 * between the shared JSON write and this SQLite transaction. */
export function finalizeQuarantinedAction(store: Store, agency: LiveAgency, commandId: string): ActionResult | undefined {
  const q = agency.quarantinedTransaction(commandId), row = store.action(commandId);
  if (!q || !row) return;
  const original = q.originalReceipt as { commandId?: string; before?: { _advanced?: Observation } } | undefined;
  const before = original?.before?._advanced;
  if (!before || original?.commandId !== commandId || row.command.action_id !== commandId || row.result.action_id !== commandId
    || row.command.character !== before.character || row.command.world !== before.world
    || row.command.profile_id !== before.profile_id || row.command.world_epoch !== before.world_epoch
    || row.command.session_id !== before.session_id || row.command.based_on_snapshot !== before.seq
    || !['withdraw','deposit','move','interact'].includes(row.command.intent.operation)) throw new Error('QUARANTINE_EXECUTOR_IDENTITY_MISMATCH');
  const action = agencyCandidate(before, { goal: row.command.plan_id, reason: 'Match original journal only', intent: row.command.intent });
  if (historicalActionIdentity(action, agencyState(before))?.semanticKey !== q.semanticKey
    || !q.evidence.includes(`historical-command-quarantined:${commandId}`)) throw new Error('QUARANTINE_EXECUTOR_INTENT_MISMATCH');
  if (row.result.status === 'CANCELLED' && row.result.reason === HISTORICAL_QUARANTINE) return row.result;
  if (row.result.status === 'SUCCEEDED' || row.result.status === 'REJECTED' || row.result.status === 'EXPIRED'
    || row.result.status === 'QUEUED') throw new Error('QUARANTINE_REQUIRES_UNKNOWN_DISPATCH');
  const result: ActionResult = { ...row.result, status: 'CANCELLED', reason: HISTORICAL_QUARANTINE, at: Date.now(), evidence: q.evidence };
  const control=store.control();
  if(!['RECONCILING','RUNNING'].includes(control.mode)||control.disabled||control.expires<=Date.now())
    throw new Error('RECOVERY_LEASE_REQUIRED');
  store.db.transaction(() => {
    const current=store.control(),entry=store.action(commandId);
    if(current.lease!==control.lease||current.mode!==control.mode||current.disabled||current.expires<=Date.now()
      ||JSON.stringify(entry)!==JSON.stringify(row))throw new Error('RECOVERY_STATE_CHANGED');
    store.append('transaction_quarantine', commandId, { quarantine: q, original: row });
    store.result(result);
  }).immediate();
  return result;
}
