import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory, Director, makePlan } from '../../src/agency/director.ts';
import { discoverGoals, type Discovery } from '../../src/agency/opportunities.ts';
import type { Method, Observation, Opportunity, Outcome } from '../../src/agency/types.ts';

const identity = { agent: 'coincrafter', world: 'test-world', revision: 'test-v1' };
const discovery = (input: Partial<Discovery> = {}): Discovery => ({ needs: [], recipes: [], loot: [], frontiers: [], unlocks: [], leads: [], ...input });
const view = (facts: Observation['facts'] = {}, patch: Partial<Observation> = {}): Observation => ({
  ...identity, at: 1000, context: 'skills-1:bronze:ground', facts,
  budget: { spendableGp: 100, maxLossGp: 20, maxDeaths: 1, maxDurationMs: 60_000 }, capabilities: ['gather', 'craft', 'fight', 'walk', 'train'], ...patch,
});
const method = (patch: Partial<Method> = {}): Method => ({ id: 'gather', capability: 'gather', domain: 'gathering', prerequisites: [],
  effects: { wood: 1 }, costGp: 0, lossBoundGp: 0, durationMs: 1000, risk: 'safe', ...patch });
const goal = (patch: Partial<Opportunity> = {}): Opportunity => ({ id: 'wood', domain: 'gathering', target: { fact: 'wood', minimum: 3 },
  reason: 'I need materials for my own next activity.', evidence: ['observation:1'], source: 'need', ...patch });
const event = (patch: Partial<Outcome> = {}): Outcome => ({ commandId: 'command', sequence: 1, status: 'verified', at: 2000,
  facts: { wood: 1 }, spentGp: 0, lostGp: 0, deaths: 0, elapsedMs: 1000, evidence: ['server:item-gained:1'], ...patch });

test('goals come from personal needs, collection gaps, unlocks and discovered frontiers', () => {
  const goals = discoverGoals({ bow: 2, feather: 0 }, discovery({
    recipes: [{ id: 'bow', outputFact: 'bow', evidence: ['recipe-seen'] }],
    loot: [{ itemFact: 'relic', monster: 'boss', evidence: ['drop-observed'] }],
    frontiers: [{ id: 'north', visitedFact: 'visited:north', evidence: ['exit-seen'] }],
  }));
  assert.deepEqual(goals.map(g => g.id), ['loot:relic', 'explore:north']);
});

test('collection goal requires multiple copies, not just any inventory delta', () => {
  const goals = discoverGoals({}, discovery({ recipes: [{ id: 'bow', outputFact: 'bow', evidence: ['recipe-seen'] }] }));
  assert.equal(goals[0]?.target.minimum, 2);
  const d = new Director(createMemory(identity, { crafting: 2 }));
  const craft = method({ id: 'craft', capability: 'craft', domain: 'crafting', effects: { bow: 1 } });
  const first = d.next(view(), goals, [craft]);
  d.begin(view(), first, craft, 'command');
  d.record(event({ facts: { bow: 1 } }));
  assert.equal(d.memory.active?.target.minimum, 2);
  assert.equal(d.memory.reviews.length, 0);
});

test('a crafter can choose combat to collect an uncraftable item, with a recorded reason', () => {
  const d = new Director(createMemory(identity, { crafting: 2 }));
  d.memory.currentDomain = 'crafting';
  const goals = discoverGoals({ bow: 2 }, discovery({ recipes: [{ id: 'bow', outputFact: 'bow', evidence: ['recipe'] }],
    loot: [{ itemFact: 'relic', monster: 'an observed monster', evidence: ['drop-event'] }] }));
  const decision = d.next(view({ bow: 2 }), goals, [method({ id: 'obtain-relic', capability: 'fight', domain: 'combat', effects: { relic: 1 }, risk: 'bounded', lossBoundGp: 5 })]);
  assert.equal(decision.type, 'execute');
  assert.equal(d.memory.currentDomain, 'combat');
  assert.match(d.memory.domainChanges.at(-1)!.reason, /not in my known recipes/);
  assert.deepEqual(d.memory.domainChanges.at(-1)!.evidence, ['drop-event']);
});

test('a boss goal plans defence and supplies first, without treating a role as a fixed class', () => {
  const methods = [method({ id: 'train-defence', capability: 'train', domain: 'combat', effects: { defence: 1 } }),
    method({ id: 'boss', capability: 'fight', domain: 'combat', prerequisites: [{ fact: 'defence', minimum: 3 }, { fact: 'food', minimum: 2 }], effects: { bossDefeated: 1 }, risk: 'bounded', lossBoundGp: 5 }),
    method({ id: 'gather-food', effects: { food: 1 } })];
  const v = view({ defence: 1, food: 0 });
  const plan = makePlan(createMemory(identity), v, goal({ target: { fact: 'bossDefeated', minimum: 1 } }), methods);
  assert.deepEqual(plan?.steps.map(s => s.methodId), ['train-defence', 'train-defence', 'gather-food', 'gather-food', 'boss']);
});

test('planning accounts for recipe inputs consumed on every repetition', () => {
  const methods = [method(), method({ id: 'craft', capability: 'craft', effects: { bow: 1 }, consumes: { wood: 2 } })];
  const plan = makePlan(createMemory(identity), view({ wood: 0 }), goal({ target: { fact: 'bow', minimum: 2 } }), methods);
  assert.equal(plan?.steps.filter(s => s.methodId === 'gather').length, 4);
  assert.equal(plan?.steps.filter(s => s.methodId === 'craft').length, 2);
});

test('dependency cycles and unbounded batches do not loop', () => {
  const m = createMemory(identity), v = view();
  const cyclic = [method({ id: 'a', prerequisites: [{ fact: 'b', minimum: 1 }], effects: { a: 1 } }),
    method({ id: 'b', prerequisites: [{ fact: 'a', minimum: 1 }], effects: { b: 1 } })];
  assert.equal(makePlan(m, v, goal({ target: { fact: 'a', minimum: 1 } }), cyclic), undefined);
  assert.equal(makePlan(m, v, goal({ target: { fact: 'wood', minimum: 100_000 } }), [method()]), undefined);
});

test('complete plan must fit the supply-preserving budget', () => {
  const expensive = method({ costGp: 40 });
  assert.equal(makePlan(createMemory(identity), view(), goal(), [expensive]), undefined);
});

test('PvP and unbounded unknown-risk experiments are prohibited regardless of reward', () => {
  for (const risk of ['pvp', 'unknown'] as const) {
    const d = new Director(createMemory(identity));
    assert.equal(d.next(view(), [goal()], [method({ risk })]).type, 'blocked');
  }
});

test('missing executable capabilities produce a blocker, not an invented command', () => {
  const d = new Director(createMemory(identity));
  const result = d.next(view(), [goal()], [method({ capability: 'unsupported-quest-api' })]);
  assert.equal(result.type, 'blocked');
  if (result.type === 'blocked') assert.deepEqual(result.missingCapabilities, ['unsupported-quest-api']);
});

test('productive repetition preserves the selected goal despite a new opportunity', () => {
  const d = new Director(createMemory(identity));
  let v = view();
  const g = goal();
  for (let n = 1; n <= 3; n++) {
    const decision = d.next(v, [g, goal({ id: 'unrelated', domain: 'combat', source: 'frontier', target: { fact: 'xp', minimum: 1 } })], [method()]);
    assert.equal(decision.type, 'execute');
    assert.equal(d.memory.active?.id, g.id);
    d.begin(v, decision, method(), 'c' + n);
    d.record(event({ commandId: 'c' + n, sequence: n, at: 1000 + n * 1000, facts: { wood: n } }));
    v = view({ wood: n }, { at: 1000 + n * 1000 });
  }
  assert.equal(d.memory.reviews.length, 1);
  assert.equal(d.memory.reviews[0]!.result, 'success');
  assert.equal(d.memory.active, undefined);
});

test('failed methods change future selection and learning survives a restart', () => {
  let d = new Director(createMemory(identity));
  const cheap = method({ id: 'cheap' }), alternative = method({ id: 'alternative', costGp: 1 });
  const first = d.next(view(), [goal()], [cheap, alternative]);
  assert.equal(first.type === 'execute' && first.step.methodId, 'cheap');
  d.begin(view(), first, cheap, 'command');
  d.record(event({ status: 'rejected', facts: {} }));
  d = new Director(JSON.parse(JSON.stringify(d.memory)));
  const next = d.next(view({}, { at: 3000 }), [goal()], [cheap, alternative]);
  assert.equal(next.type === 'execute' && next.step.methodId, 'alternative');
});

test('unknown outcome blocks replay after restart and does not poison method learning', () => {
  let d = new Director(createMemory(identity));
  const decision = d.next(view(), [goal()], [method()]);
  d.begin(view(), decision, method(), 'command');
  d.record(event({ status: 'unknown', evidence: [] }));
  d = new Director(JSON.parse(JSON.stringify(d.memory)));
  assert.equal(d.next(view(), [goal()], [method()]).type, 'reconcile');
  assert.equal(Object.keys(d.memory.methods).length, 0);
  assert.throws(() => d.begin(view(), decision, method(), 'new-command'), /RECONCILE/);
  d.record(event());
  assert.equal(d.memory.pending, undefined);
});

test('a claimed verification without evidence remains unknown', () => {
  const d = new Director(createMemory(identity));
  d.begin(view(), d.next(view(), [goal()], [method()]), method(), 'command');
  d.record(event({ evidence: [] }));
  assert.equal(d.memory.pending?.status, 'unknown');
  assert.equal(d.memory.sequence, 0);
});

test('duplicate terminal events cannot double-count rewards, spending or deaths', () => {
  const d = new Director(createMemory(identity));
  d.begin(view(), d.next(view(), [goal()], [method()]), method(), 'command');
  d.record(event({ spentGp: 4 })); d.record(event({ spentGp: 4 }));
  assert.equal(d.memory.active?.spentGp, 4);
  assert.equal(Object.values(d.memory.methods)[0]!.attempts, 1);
});

test('irrelevant movement/item changes do not establish method success', () => {
  const d = new Director(createMemory(identity));
  d.begin(view(), d.next(view(), [goal()], [method()]), method(), 'command');
  d.record(event({ facts: { positionX: 1, randomItem: 1 } }));
  assert.equal(Object.values(d.memory.methods)[0]!.productive, 0);
  assert.equal(d.memory.reviews.length, 0);
});

test('fresh dispatch revalidates resources, prerequisites and PvP prohibition', () => {
  const d = new Director(createMemory(identity));
  const action = method({ costGp: 5, prerequisites: [{ fact: 'tool', minimum: 1 }] });
  const planned = d.next(view({ tool: 1 }), [goal()], [action]);
  assert.throws(() => d.begin(view({ tool: 0 }), planned, action, 'command'), /INVALID_OR_STALE/);
  assert.throws(() => d.begin(view({ tool: 1 }), planned, { ...action, risk: 'pvp' }, 'command'), /INVALID_OR_STALE/);
});

test('time budget terminates a stalled goal instead of an infinite repeated attempt', () => {
  const d = new Director(createMemory(identity));
  d.next(view(), [goal()], [method()]);
  const result = d.next(view({}, { at: 100_000 }), [goal()], [method()]);
  assert.equal(result.type, 'blocked');
  assert.equal(d.memory.reviews.length, 1);
});

test('agent, world and revision boundaries prevent cross-character memory reuse', () => {
  const d = new Director(createMemory(identity));
  for (const patch of [{ agent: 'stinger' }, { world: 'other' }, { revision: 'v2' }])
    assert.throws(() => d.next(view({}, patch), [goal()], [method()]), /MISMATCH/);
});

test('invalid costs and observations are rejected', () => {
  const d = new Director(createMemory(identity));
  assert.throws(() => d.next(view({ wood: NaN }), [goal()], [method()]), /INVALID_OBSERVATION/);
  assert.equal(d.next(view(), [goal()], [method({ costGp: -1 })]).type, 'blocked');
});

test('after completing one self-generated goal the next opportunity is selected automatically', () => {
  const d = new Director(createMemory(identity));
  const first = goal({ target: { fact: 'wood', minimum: 1 } });
  const next = goal({ id: 'frontier', domain: 'exploration', source: 'frontier', target: { fact: 'visited', minimum: 1 } });
  const walk = method({ id: 'survey', capability: 'walk', domain: 'exploration', effects: { visited: 1 } });
  const decision = d.next(view(), [first, next], [method(), walk]);
  d.begin(view(), decision, method(), 'command'); d.record(event());
  const result = d.next(view({ wood: 1 }, { at: 3000 }), [first, next], [method(), walk]);
  assert.equal(result.type === 'execute' && result.goal.id, 'frontier');
});

test('relevant capability context changes permit a new measured trial rather than a permanent blacklist', () => {
  const d = new Director(createMemory(identity));
  d.begin(view(), d.next(view(), [goal()], [method()]), method(), 'command');
  d.record(event({ status: 'rejected', facts: {} }));
  const result = d.next(view({}, { at: 3000, context: 'skills-20:iron:ground' }), [goal()], [method()]);
  assert.equal(result.type, 'execute');
});

test('a prerequisite consumed while preparing another cannot produce an invalid executable plan', () => {
  const methods = [method({ id: 'get-a', effects: { a: 1 } }),
    method({ id: 'make-b', effects: { b: 1 }, consumes: { a: 1 } }),
    method({ id: 'finish', effects: { goal: 1 }, prerequisites: [{ fact: 'a', minimum: 1 }, { fact: 'b', minimum: 1 }] })];
  const plan = makePlan(createMemory(identity), view(), goal({ target: { fact: 'goal', minimum: 1 } }), methods);
  assert.equal(plan, undefined);
});

test('a fresh dispatch cannot overrun the remaining task duration budget', () => {
  const d = new Director(createMemory(identity));
  const action = method({ durationMs: 1000 });
  const decision = d.next(view(), [goal()], [action]);
  assert.throws(() => d.begin(view({}, { at: 60_500 }), decision, action, 'command'), /BUDGET_EXCEEDED/);
});
