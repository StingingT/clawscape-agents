import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../../src/agency/director.ts';
import { buildCatalogue, defaultPolicy, emptyKnowledge } from '../../src/agency/world-model.ts';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';

const identity = { agent: 'unassigned-player', world: 'test', revision: 'test' };
const state = (x = 10, tick = 1): any => ({
  character: identity.agent, world: 'test', worldEpoch: 'epoch', sessionId: 'session', inGame: true, tick,
  player: { hp: 30, maxHp: 30, lifeId: 1, worldX: x, worldZ: 10, level: 0, animId: -1, combat: { inCombat: false } },
  inventory: [], equipment: [], skills: [], nearbyLocs: [],
});
const probes = (c: ReturnType<typeof buildCatalogue>) => c.opportunities.filter(o => o.id.startsWith('survey:local-probe:'));

test('persisted unused probes cannot activate immediately after productive work, including after serialization', () => {
  const knowledge = emptyKnowledge(), memory = createMemory(identity);
  assert.ok(probes(buildCatalogue(identity, state(), knowledge, defaultPolicy, ['exploration'], memory, 1000)).length);
  memory.progress = { since: 1000, lastProductiveAt: 2000, noProgressActions: 0, recentStates: [] };
  for (const [k, m] of [[knowledge, memory], [JSON.parse(JSON.stringify(knowledge)), JSON.parse(JSON.stringify(memory))]]) {
    const c = buildCatalogue(identity, state(10, 3), k, defaultPolicy, ['exploration'], m, 2100);
    assert.equal(probes(c).length, 0, 'the gate applies to saved proposals, not just their creation');
    assert.ok(Object.keys(k.routes).some(id => id.startsWith('local-probe:')), 'knowledge is not erased');
  }
});

test('saved probes become available again after a genuine productive-progress stall', () => {
  const knowledge = emptyKnowledge(), memory = createMemory(identity);
  buildCatalogue(identity, state(), knowledge, defaultPolicy, ['exploration'], memory, 1000);
  memory.progress = { since: 1000, lastProductiveAt: 2000, noProgressActions: 0, recentStates: [] };
  assert.ok(probes(buildCatalogue(identity, state(10, 4), knowledge, defaultPolicy, ['exploration'], memory, 302001)).length);
});

test('real survey-prefixed reviews consume the bounded discovery budget, including failed attempts', () => {
  const knowledge = emptyKnowledge(), memory = createMemory(identity);
  buildCatalogue(identity, state(), knowledge, defaultPolicy, ['exploration'], memory, 1000);
  memory.reviews = [
    { goal: { id: 'survey:local-probe:13:10:0' }, at: 1500, result: 'success' },
    { goal: { id: 'survey:local-probe:7:10:0' }, at: 1600, result: 'partial' },
  ] as any;
  assert.equal(probes(buildCatalogue(identity, state(), knowledge, defaultPolicy, ['exploration'], memory, 1700)).length, 0);
  assert.ok(probes(buildCatalogue(identity, state(), knowledge, defaultPolicy, ['exploration'], memory, 602000)).length);
});

test('a verified partial probe remains executable until arrival instead of cancelling itself on progress', t => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-continuity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let now = 1000;
  const file = join(dir, 'agency.json'), options = { supported: ['exploration'] as any, now: () => now };
  const agency = new LiveAgency(file, identity, options), before = state(), choice = agency.plan(before);
  assert.ok(isSelection(choice));
  assert.ok(choice.task.route?.id.startsWith('local-probe:'));
  const route = choice.task.route!;
  const action = { id: 'probe-leg', type: 'walkTo', fields: { x: route.x, z: route.z, level: route.level } };
  agency.begin(choice, action, before, 'one-leg');
  const after = state(10, 2);
  after.player.worldX += Math.sign(route.x - 10);
  after.player.worldZ += Math.sign(route.z - 10);
  now = 2000;
  agency.record('one-leg', after, { status: 'verified', evidence: ['verified movement toward the selected probe'] });
  assert.equal(agency.pending(), undefined);
  assert.equal(agency.director.memory.reviews.length, 0);
  const restarted = new LiveAgency(file, identity, options), resumed = restarted.plan(after);
  assert.ok(isSelection(resumed));
  assert.equal(resumed.task.route?.id, route.id, 'partial progress does not gate out the committed probe');
});

test('danger and a missing connection suppress already saved bootstrap probes', () => {
  const knowledge = emptyKnowledge(), memory = createMemory(identity);
  buildCatalogue(identity, state(), knowledge, defaultPolicy, ['exploration'], memory, 1000);
  for (const current of [{ ...state(), inGame: false }, { ...state(), danger: { active: true } }]) {
    assert.equal(probes(buildCatalogue(identity, current, knowledge, defaultPolicy, ['exploration'], memory, 2000)).length, 0);
  }
});
