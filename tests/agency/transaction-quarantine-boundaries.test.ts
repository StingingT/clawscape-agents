import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';
import { quarantineEligible, releaseFromFreshAccounting, transactionIdentity, type QuarantinedTransaction } from '../../src/agency/transaction-quarantine.ts';

const identity = { agent: 'unassigned', world: 'test', revision: 'test' };
const state = (tick: number): any => ({ character: 'unassigned', world: 'test', worldEpoch: 'epoch', profileId: 'profile', sessionId: 'session', inGame: true, tick,
  player: { worldX: 10, worldZ: 10, level: 0, lifeId: 1, hp: 30, maxHp: 30, animId: -1, combat: { inCombat: false } },
  inventory: [], equipment: [], skills: [], nearbyLocs: [], bank: { isOpen: true, items: [{ id: 41, name: 'Reusable supply', slot: 7, count: 5 }] } });
const action = { id: 'owned-prerequisite', type: 'bankWithdraw', fields: { slot: 7, amount: 1 } };
const entry = (): QuarantinedTransaction => ({ at: 121000, commandId: 'old', type: 'bankWithdraw', ...transactionIdentity(action, state(1))!, reason: 'original bank source unavailable',
  evidence: ['historical-command-quarantined:old'], active: true, observation: { tick: 10, sessionId: 'session', character: 'unassigned', world: 'test', worldEpoch: 'epoch', profileId: 'profile' } });

test('a matching reason string cannot replace observed historical attribution loss', () => {
  assert.equal(quarantineEligible(action, state(1), state(10), 1000, 122000, 'original bank source unavailable'), false);
  const current = state(10); current.bank.isOpen = false;
  assert.equal(quarantineEligible(action, state(1), current, 1000, 122000, 'original bank source unavailable'), true);
  current.danger = { active: true };
  assert.equal(quarantineEligible(action, state(1), current, 1000, 122000, 'original bank source unavailable'), false);
});

test('fresh accounting rejects the quarantine snapshot itself, another world, partial data and invalid balances', () => {
  for (const current of [state(10), { ...state(11), world: 'another' }, { ...state(11), worldEpoch: 'another' },
    { ...state(11), bank: { isOpen: true, complete: false, items: [] } },
    { ...state(11), bank: { isOpen: true, items: [{ id: 41, slot: 7, count: -1 }] } },
    { ...state(11), bank: { isOpen: true, items: [{ id: 41, slot: 7, count: 1 }, { id: 42, slot: 7, count: 1 }] } }]) {
    assert.equal(releaseFromFreshAccounting(entry(), current, 122000).active, true);
  }
  const q = releaseFromFreshAccounting(entry(), state(11), 122000);
  assert.equal(q.active, false); assert.equal(q.reason, 'original bank source unavailable');
});

test('shared quarantine retains its original receipt and exact command ban after fresh accounting and restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = join(dir, 'agency.json'); let now = 1000;
  const options = { supported: ['production', 'exploration'] as any, now: () => now };
  const a = new LiveAgency(file, identity, options), before = state(1), selected = a.plan(before);
  assert.ok(isSelection(selected)); a.begin(selected, action, before, 'old');
  // JSON journals omit optional undefined properties; compare the exact durable representation.
  const original = JSON.stringify(a.pending());
  a.record('old', before, { status: 'unknown', evidence: [], reason: 'unconfirmed' });
  const current = state(10); current.bank.isOpen = false; now = 122000;
  assert.ok(a.quarantinePendingTransaction(current, 'original bank source unavailable'));
  assert.equal(JSON.stringify(a.quarantinedTransaction('old')!.originalReceipt), original);
  const fresh = state(11); a.catalogue(fresh); a.plan(fresh);
  const reloaded = new LiveAgency(file, identity, options);
  assert.equal(reloaded.quarantinedTransaction('old')!.active, false);
  assert.equal(JSON.stringify(reloaded.quarantinedTransaction('old')!.originalReceipt), original);
  assert.throws(() => reloaded.begin(selected, action, fresh, 'old'), /QUARANTINED_COMMAND_ID_CANNOT_BE_REUSED/);
  assert.equal(reloaded.pending(), undefined);
  assert.equal('originalReceipt' in reloaded.summary().transactionQuarantine[0]!, false, 'status output stays bounded');
});
