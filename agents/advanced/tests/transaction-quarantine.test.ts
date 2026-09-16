import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { LiveAgency, isSelection } from '../../../src/agency/live-adapter.ts';
import { LivePolicy } from '../src/live-policy.ts';
import { agencyState, agencyCandidate, arbiterVerification } from '../src/agency-bridge.ts';
import { reconcileAstraJournals } from '../src/restart-journals.ts';
import { finalizeQuarantinedAction, HISTORICAL_QUARANTINE } from '../src/transaction-quarantine.ts';
import type { Observation, ActionCommand, ActionResult } from '../src/contracts.ts';

function observation(tick: number, life = 1): Observation {
  return { schema_version: '1.0', character: 'unassigned-player', world: 'test-world', world_epoch: 'epoch', session_id: 'session', profile_id: 'test',
    seq: tick, tick, observed_at: Date.now(), fresh_at: Date.now(), provenance: 'cli-player-observation', connected: true,
    position: { x: 10, z: 10, plane: 0 }, hp: 30, max_hp: 30, life_id: life, respawns: life - 1,
    skills: [], capacity: 28, inventory: [], equipment: [], bank: { open: true, items: [{ slot: 7, id: 315, name: 'Test supply', count: 5, protected: false, options: [] }] },
    shop_open: false, dialog: { open: false, waiting: false, text: '', options: [] }, feedback: [], danger: { active: false, damage_margin: 2 },
    unavailable: [], entities: [], activity: { animation: -1, target_index: -1, target_type: 'none', last_damage_tick: -1, modal_open: false,
      modal_id: -1, style: 0, styles: [], design_open: false, events: [] } };
}
function fixture(run: (f: { store: Store; agency: LiveAgency; dir: string; before: Observation; first: Observation; second: Observation; command: ActionCommand; lease: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-integration-')), store = new Store(join(dir, 'journal.sqlite'));
  let now = Date.now() - 180000;
  const before = observation(1);
  before.observed_at = before.fresh_at = now;
  const agency = new LiveAgency(join(dir, 'agency-v2.json'), { agent: before.character, world: before.world, revision: before.profile_id },
    { supported: ['production', 'exploration', 'discovery'], now: () => now });
  try {
    const selected = agency.plan(agencyState(before));
    if (!isSelection(selected)) throw new Error('fixture needs an actual planner selection');
    const lease = store.acquireRecovery('recovery-test', Date.now());
    const command: ActionCommand = { schema_version: '1.0', action_id: 'old-transfer', character: before.character, world: before.world,
      world_epoch: before.world_epoch, session_id: before.session_id, profile_id: before.profile_id, lease, plan_id: selected.task.id,
      based_on_snapshot: before.seq, expires_at: now + 10000, intent: { operation: 'withdraw', slot: 7, item_id: 315, amount: 1 } };
    const result: ActionResult = { schema_version: '1.0', action_id: command.action_id, status: 'RUNNING', reason: 'OUTCOME_UNKNOWN', at: now, evidence: [] };
    agency.begin(selected, agencyCandidate(before, { goal: selected.task.id, reason: 'owned prerequisite', intent: command.intent }), agencyState(before), command.action_id);
    agency.record(command.action_id, agencyState(before), { status: 'unknown', reason: 'transport timeout', evidence: [] });
    store.createAction(command, result);
    store.append('action_checkpoints', command.action_id, { action_id: command.action_id, before });
    now = Date.now();
    const first = observation(10, 2), second = observation(11, 2);
    first.bank = second.bank = { open: false, items: null };
    run({ store, agency, dir, before, first, second, command, lease });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('the same startup pass quarantines an unattributable old transfer in both journals without success', () => fixture(f => {
  const learning = f.agency.director.memory.learningRevision ?? 0;
  const r = reconcileAstraJournals(f.store, f.dir, f.first, f.second, f.agency);
  expect(r.ready).toBe(true); expect(r.unresolved).toHaveLength(0);
  expect(f.agency.pending()).toBeUndefined(); expect(f.store.pending()).toHaveLength(0);
  expect(f.store.action(f.command.action_id)!.result.reason).toBe(HISTORICAL_QUARANTINE);
  expect(f.agency.director.memory.learningRevision ?? 0).toBe(learning);
  expect(f.agency.quarantinedTransaction(f.command.action_id)!.originalReceipt).toBeDefined();
  const audit = f.store.records<any>('transaction_quarantine');
  expect(audit).toHaveLength(1); expect(audit[0].original.command).toEqual(f.command);
  expect(audit[0].original.result.status).toBe('RUNNING');
  expect(arbiterVerification(f.command.action_id, f.store.action(f.command.action_id)!.result).status).toBe('unknown');
  f.store.promoteRecovery(f.lease, Date.now());
}));

test('a crash after shared quarantine but before the SQLite write resumes only that exact administrative decision', () => fixture(f => {
  expect(f.agency.quarantinePendingTransaction(agencyState(f.second), 'life changed; losses and intent must be reconciled')).toBeDefined();
  expect(f.store.pending()).toHaveLength(1);
  const restarted = new LiveAgency(join(f.dir, 'agency-v2.json'), { agent: f.before.character, world: f.before.world, revision: 'test' }, { supported: ['exploration'] });
  expect(reconcileAstraJournals(f.store, f.dir, f.first, f.second, restarted).ready).toBe(true);
  const n = f.store.records('actions').length;
  reconcileAstraJournals(f.store, f.dir, f.first, f.second, restarted);
  expect(f.store.records('actions')).toHaveLength(n);
  expect(f.store.records('transaction_quarantine')).toHaveLength(1);
}));

test('quarantining one transfer does not erase another unresolved executor action', () => fixture(f => {
  const old = f.store.action(f.command.action_id)!.result;
  f.store.result({ ...old, status: 'FAILED', reason: 'OUTCOME_UNKNOWN' });
  const other = { ...f.command, action_id: 'unrelated-transfer' };
  f.store.createAction(other, { ...old, action_id: other.action_id });
  f.store.append('action_checkpoints', other.action_id, { action_id: other.action_id, before: f.before });
  const r = reconcileAstraJournals(f.store, f.dir, f.first, f.second, f.agency);
  expect(r.ready).toBe(false);
  expect(r.unresolved.some(e => e.commandId === other.action_id)).toBe(true);
  expect(f.store.action(other.action_id)!.result.status).toBe('RUNNING');
}));

test('mismatched executor intent cannot inherit a shared quarantine decision', () => fixture(f => {
  f.agency.quarantinePendingTransaction(agencyState(f.second), 'life changed');
  f.store.db.query('UPDATE actions SET command=? WHERE id=?').run(JSON.stringify({ ...f.command, intent: { ...f.command.intent, amount: 4 } }), f.command.action_id);
  expect(() => finalizeQuarantinedAction(f.store, f.agency, f.command.action_id)).toThrow('QUARANTINE_EXECUTOR_INTENT_MISMATCH');
  expect(f.store.action(f.command.action_id)!.result.status).toBe('RUNNING');
}));

test('policy clears only matching bank uncertainty with command-scoped administrative evidence and no reward', () => fixture(f => {
  const policy = new LivePolicy();
  const summary = () => (policy.summary() as { state: { uncertain: unknown; counters: unknown } }).state;
  const decision = { goal: f.command.plan_id, reason: 'bank preparation', intent: f.command.intent };
  const after = observation(2);
  policy.recordOutcome(f.before, after, decision, 'RUNNING');
  expect(summary().uncertain).not.toBeNull();
  const counters = structuredClone(summary().counters);
  const result: ActionResult = { schema_version: '1.0', action_id: f.command.action_id, status: 'CANCELLED', reason: HISTORICAL_QUARANTINE,
    at: Date.now(), evidence: [`historical-command-quarantined:${f.command.action_id}`] };
  expect(policy.retireReconciledOutcome(f.before, f.command.intent, { ...result, evidence: ['unmatched'] })).toBe(false);
  expect(policy.retireReconciledOutcome(f.before, { operation: 'withdraw', slot: 7, item_id: 315, amount: 4 }, result)).toBe(false);
  expect(policy.retireReconciledOutcome(f.before, f.command.intent, result)).toBe(true);
  expect(summary().uncertain).toBeNull(); expect(summary().counters).toEqual(counters);
}));
