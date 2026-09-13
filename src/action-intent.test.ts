import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginActionIntent, finishActionIntent, loadActionIntent } from './action-intent';

test('action intent survives restart while pending and records verified outcome', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'clawscape-intent-')), 'intent.json');
  const pending = beginActionIntent(file, { commandId: 'cmd-1', actionId: 'buy-pickaxe', type: 'shopBuy', fields: { slot: 3 }, startedAt: new Date().toISOString(), expectedEffect: 'pickaxe count increases' });
  expect(loadActionIntent(file)?.status).toBe('pending');
  finishActionIntent(file, pending, 'verified', ['inventory:item-1269:+1', 'coins:-200']);
  expect(loadActionIntent(file)?.status).toBe('verified');
});

test('unknown outcome is persisted instead of silently replayed', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'clawscape-intent-')), 'intent.json');
  const pending = beginActionIntent(file, { commandId: 'cmd-2', actionId: 'bank-transfer', type: 'bankWithdraw', fields: { slot: 1 }, startedAt: new Date().toISOString() });
  finishActionIntent(file, pending, 'outcome-unknown', [], 'timeout before reconciliation');
  expect(loadActionIntent(file)?.status).toBe('outcome-unknown');
});
