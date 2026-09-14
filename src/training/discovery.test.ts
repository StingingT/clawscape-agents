import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrainingDiscovery, trainingReadiness } from './discovery';
import type { Catalog, Monster } from './catalog';
const chicken: Monster = { id: 41, symbol: 'chicken', name: 'Chicken', combatLevel: 1, hp: 3, minSkill: 1, respawnTicks: 50, source: 'fixture' };
const cow: Monster = { ...chicken, id: 81, symbol: 'cow', name: 'Cow', combatLevel: 2, hp: 8 };
const barbarian: Monster = { ...chicken, id: 12, symbol: 'barbarian', name: 'Barbarian', combatLevel: 7, hp: 14, minSkill: 20 };
const catalog: Catalog = { namespace: 'test-world', monsters: [chicken, cow, barbarian], evidence: [], sites: [
  { id: 'chickens', name: 'Chickens', monster: chicken, points: [{ x: 100, z: 100, level: 0 }], source: 'fixture', guideIds: ['ranged'] },
  { id: 'cows', name: 'Cows', monster: cow, points: [{ x: 110, z: 100, level: 0 }], source: 'fixture', guideIds: ['melee'] },
  { id: 'barbarians', name: 'Barbarians', monster: barbarian, points: [{ x: 200, z: 100, level: 0 }], source: 'fixture', guideIds: ['ranged'] },
] };
const state = (): any => ({ tick: 100, player: { worldX: 100, worldZ: 100, level: 0, lifeId: 1, hp: 30, maxHp: 30, combatLevel: 20, combat: { inCombat: false, lastDamageTick: -1 } }, skills: [{ name: 'Strength', level: 25, experience: 1000 }, { name: 'Ranged', level: 25, experience: 1000 }], inventory: [{ name: 'Shrimps', count: 8, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }], equipment: [], combatStyle: { weaponName: 'Iron scimitar' }, nearbyNpcs: [], nearbyLocs: [] });
const npc = (m = chicken): any => ({ id: m.id, index: 7, name: m.name, combatLevel: m.combatLevel, x: 101, z: 100, distance: 1, reachable: true, inCombat: false, hp: null, optionsWithIndex: [{ text: 'Attack', opIndex: 2 }] });
const route = async (from: any, to: any) => ({ status: 'ready', cost: Math.abs(from.x - to.x) });
function fixture(fn: (d: TrainingDiscovery, file: string, clock: { now: number }) => any, options: { ranged?: boolean; economy?: boolean; catalog?: Catalog } = {}) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claw-training-test-')), file = join(dir, 'training.json'), clock = { now: 1_000_000 };
    try { await fn(new TrainingDiscovery(file, 'stinger', options.catalog ?? catalog, options.ranged, options.economy, () => clock.now), file, clock); }
    finally { rmSync(dir, { recursive: true }); }
  };
}
test('record observations without persisting ephemeral NPC indices; duplicate ticks do not inflate evidence', fixture((d, file) => {
  const s = state(); s.nearbyNpcs = [npc(), { ...npc(), id: 9999, name: 'Unreviewed monster' }]; d.observe(s); d.observe(s);
  expect(Object.values(d.memory.observations).every(n => !('index' in n))).toBe(true);
  expect(d.memory.sites.chickens.sightings).toBe(1);
  expect(Object.keys(d.memory.observations)).toHaveLength(2);
  expect(new TrainingDiscovery(file, 'stinger', catalog).memory.sites.chickens.lastSeen).toBeDefined();
}));
test('map namespace changes retain history but reset confidence', fixture((d, file) => {
  const s = state(); s.nearbyNpcs = [npc()]; d.observe(s);
  const newWorld = new TrainingDiscovery(file, 'stinger', { ...catalog, namespace: 'changed-map' }); newWorld.save();
  expect(newWorld.memory.sites.chickens.sightings).toBe(0);
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).worlds)).toHaveLength(2);
  expect(() => new TrainingDiscovery(file, 'coincrafter', catalog)).toThrow('identity');
}));
test('recent hit safety delay does not poison site discovery with a global cooldown', fixture(async d => {
  const s=state();s.player.combat.lastDamageTick=s.tick;
  expect((await d.next(s,route))[0].id).toBe('training-await-combat-clear');expect(d.memory.retryAt).toBeUndefined();
  s.tick+=11;s.nearbyNpcs=[npc()];
  expect(['interactNpc','walkTo']).toContain((await d.next(s,route))[0].type);
}));

test('CoinCrafter gains discovery knowledge but no compulsory combat or exploration', fixture(async d => {
  const s = state(); s.nearbyNpcs = [npc()]; let probes = 0;
  expect(await d.next(s, async () => { probes++; return { status: 'ready' }; })).toEqual([]);
  expect(probes).toBe(0); expect(d.memory.sites.chickens.sightings).toBe(1);
}, { economy: true }));
test('level, equipment, health and compatible ammo gate trials without a fixed food quota', () => {
  const s = state(); expect(trainingReadiness(s, barbarian, false)).toBeUndefined();
  s.skills[0].level = 1; expect(trainingReadiness(s, barbarian, false)).toBe('skill-prerequisite'); s.skills[0].level = 25;
  s.combatStyle.weaponName = 'Unarmed'; expect(trainingReadiness(s, cow, false)).toBe('melee-weapon-required');
  s.combatStyle.weaponName = 'Shortbow'; s.equipment = [{ name: 'Steel arrow', count: 50 }]; expect(trainingReadiness(s, chicken, true)).toBe('compatible-quiver-required');
  s.equipment = [{ name: 'Iron arrow', count: 10 }]; expect(trainingReadiness(s, chicken, true)).toBe('ammo-trip-reserve');
  s.equipment[0].count = 50; expect(trainingReadiness(s, barbarian, true)).toBeUndefined();
  s.player.hp = 10; expect(trainingReadiness(s, chicken, true)).toBe('health-or-food'); s.player.hp = 30;
  s.inventory = []; expect(trainingReadiness(s, chicken, true)).toBeUndefined();
});
test('select a reachable viable alternative when the highest prior route is partial', fixture(async d => {
  const a = (await d.next(state(), async (f, t) => t.x === 200 ? { status: 'blocked', reason: 'partial-path' } : route(f, t)))[0];
  expect(a.fields?.trainingSite).toBe('cows'); expect(a.fields?.x).toBe(110);
  expect(d.memory.sites.barbarians.cooldownUntil).toBeGreaterThan(0);
}));
test('same plane and exact source type/level required; name alone cannot authorize a fight', fixture(async d => {
  const s = state(); s.skills[0].level = 1; s.nearbyNpcs = [{ ...npc(), id: 999, combatLevel: 80 }];
  const a = (await d.next(s, route))[0]; expect(a.type).not.toBe('interactNpc');
  s.player.level = 1; expect((await d.next(s, route))[0].type).toBe('wait');
}));
test('observed source-compatible monster creates a persistent new site at the standing tile', fixture(d => {
  const s = state(); s.player.worldX = 500; s.nearbyNpcs = [{ ...npc(), x: 501 }]; d.observe(s);
  const found = Object.values(d.memory.sites).find(site => site.source === 'observed')!;
  expect(found.points[0]).toEqual({ x: 500, z: 100, level: 0 }); expect(found.evidence).toContain('state:1:100');
}));
test('commitment persists across restart and resists nearby alternatives', fixture(async (d, file, clock) => {
  const s = state(); s.skills[0].level = 1; d.memory.sites.cows.cooldownUntil = clock.now + 60_000;
  s.nearbyNpcs = [npc()]; expect((await d.next(s, route))[0].fields?.trainingSite).toBe('chickens');
  clock.now += 70_000; s.tick++; s.nearbyNpcs.push({ ...npc(cow), index: 8, x: 110, distance: 2 });
  const restarted = new TrainingDiscovery(file, 'stinger', catalog, false, false, () => clock.now);
  expect((await restarted.next(s, route))[0].fields?.trainingSite).toBe('chickens');
}));
test('bounded empty observations cool a site and survive restart', fixture(async (d, file, clock) => {
  const s = state(); s.skills[0].level = 1;
  d.memory.sites.cows.cooldownUntil = clock.now + 500_000;
  for (let i = 0; i < 3; i++) { s.tick += 50; await d.next(s, route); }
  expect(d.memory.sites.chickens.cooldownUntil).toBe(clock.now + 300_000);
  expect(new TrainingDiscovery(file, 'stinger', catalog).memory.sites.chickens.cooldownUntil).toBe(clock.now + 300_000);
}));
test('only two unobserved discovery trips per ten-minute window', fixture(async (d, _file, clock) => {
  const s = state();
  for (let i = 0; i < 2; i++) { const a = (await d.next(s, route))[0]; d.block(a.fields?.trainingSite, 'empty'); s.tick++; }
  expect(d.memory.exploration.trips).toBe(2);
  expect((await d.next(s, route))[0].type).toBe('wait');
  clock.now += 601_000; s.tick++; await d.next(s, route); expect(d.memory.exploration.trips).toBe(1);
}));
test('experienced agent can leave starter area for a reviewed higher-tier site', fixture(async d => {
  const s = state();
  s.skills[0].level = 25;
  s.inventory = [{ name: 'Shrimps', count: 8, slot: 0, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }];
  s.equipment = [{ name: 'Iron scimitar', count: 1, slot: 3 }];
  d.memory.exploration.trips = 2;
  const action = (await d.next(s, route))[0];
  expect(action.fields?.trainingSite).toBe('barbarians');
}));
test('ranged Stinger can replace a stale commitment without a mandatory highest-tier target', fixture(async (d, _file, _clock) => {
  const goblin: Monster = { ...barbarian, id: 101, name: 'Goblin', combatLevel: 5, minSkill: 5 };
  const guard: Monster = { ...barbarian, id: 9, name: 'Guard', combatLevel: 21, minSkill: 25 };
  const spider: Monster = { ...barbarian, id: 60, name: 'Giant spider', combatLevel: 27, minSkill: 35 };
  const progressionCatalog: Catalog = {
    ...catalog,
    monsters: [...catalog.monsters, goblin, guard, spider],
    sites: [
      ...catalog.sites,
      { id: 'armed-goblins', name: 'Armed goblins', monster: goblin, points: [{ x: 120, z: 100, level: 0 }], source: 'fixture', guideIds: ['ranged'] },
      { id: 'guards', name: 'Guards', monster: guard, points: [{ x: 220, z: 100, level: 0 }], source: 'fixture', guideIds: ['ranged'] },
      { id: 'giant-spiders', name: 'Giant spiders', monster: spider, points: [{ x: 300, z: 100, level: 0 }], source: 'fixture', guideIds: ['ranged'] },
    ],
  };
  const ranged = new TrainingDiscovery(_file, 'stinger', progressionCatalog, true, false, () => _clock.now);
  const s = state(); s.skills[1].level = 46; s.combatStyle.weaponName = 'Shortbow'; s.equipment = [{ name: 'Iron arrow', count: 15 }];
  expect(trainingReadiness(s, spider, true)).toBeUndefined();
  ranged.memory.commitment = { siteId: 'armed-goblins', since: 1, encounters: 20 };
  const action = (await ranged.next(s, route))[0];
  expect(ranged.memory.commitment?.siteId).toBe('barbarians');
  expect(action.fields?.trainingSite).toBe('barbarians');
}));
test('high-Strength melee can trial the next tier before an intermediate weapon buy', () => {
  const s = state();
  s.skills[0].level = 92;
  s.combatStyle.weaponName = 'Bronze scimitar';
  expect(trainingReadiness(s, barbarian, false)).toBeUndefined();
});
test('strong comparable measured performance can outweigh an untested higher-tier prior', fixture(async d => {
  const s = state();
  s.inventory = [{ name: 'Shrimps', count: 8, slot: 0, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }];
  s.equipment = [{ name: 'Iron scimitar', count: 1, slot: 3 }];
  d.memory.sites.cows.stats['melee:Iron scimitar:def0:skill2'] = { encounters: 20, kills: 20, productive: 20, xp: 10000, ticks: 100, damage: 0, food: 0, ammo: 0, escapes: 0, deaths: 0 };
  const action = (await d.next(s, route))[0];
  expect(action.fields?.trainingSite).toBe('cows');
}));
test('loading collision map does not spend exploration budget or poison a site', fixture(async d => {
  expect((await d.next(state(), async () => ({ status: 'loading-map' })))[0].id).toContain('loading-map');
  expect(d.memory.exploration.trips).toBe(0); expect(Object.values(d.memory.sites).every(s => s.failures === 0)).toBe(true);
}));
test('fresh dispatch rejects depleted quiver and reused NPC index', fixture(d => {
  const s = state(); s.combatStyle.weaponName = 'Shortbow'; s.equipment = [{ name: 'Iron arrow', count: 50 }]; s.nearbyNpcs = [npc()];
  const a = { id: 'training-attack-chickens', type: 'interactNpc', fields: { trainingSite: 'chickens', npcIndex: 7, optionIndex: 2 }, waitTicks: 6 };
  expect(d.validateAction(s, a)).toBe(true); s.nearbyNpcs[0].id = 999; expect(d.validateAction(s, a)).toBe(false);
  s.nearbyNpcs[0].id = 41; s.equipment = []; expect(d.validateAction(s, a)).toBe(false);
}, { ranged: true }));
test('encounters aggregate XP, damage and supplies across actions, disappearance is not a kill', fixture(d => {
  const s = state(); s.nearbyNpcs = [npc()];
  const a = { id: 'training-attack-chickens', type: 'interactNpc', fields: { trainingSite: 'chickens', npcIndex: 7 }, waitTicks: 6 };
  d.beforeAction(s, a); const next = structuredClone(s); next.tick += 6; next.skills[0].experience += 12; next.player.hp -= 2; next.nearbyNpcs = [];
  d.afterAction(s, next, a);
  const stats = Object.values(d.memory.sites.chickens.stats)[0];
  expect(stats).toMatchObject({ encounters: 1, productive: 1, xp: 12, ticks: 6, damage: 2, kills: 0 }); expect(d.memory.pending).toBeUndefined();
}));
test('confirmed NPC zero HP is distinct from death and retreat penalties', fixture((d, _file, clock) => {
  const s = state(); s.nearbyNpcs = [npc()];
  const a = { id: 'training-attack-chickens', type: 'interactNpc', fields: { trainingSite: 'chickens', npcIndex: 7 }, waitTicks: 6 };
  d.beforeAction(s, a); const next = structuredClone(s); next.tick += 6; next.nearbyNpcs[0].hp = 0; next.skills[0].experience += 12;
  d.afterAction(s, next, a); expect(Object.values(d.memory.sites.chickens.stats)[0].kills).toBe(1);
  d.beforeAction(s, a); d.afterAction(s, { ...next, player: { ...next.player, lifeId: 2 } }, { id: 'escape', type: 'retreat', waitTicks: 2 });
  expect(Object.values(d.memory.sites.chickens.stats)[0].deaths).toBe(1);
  expect(d.memory.sites.chickens.cooldownUntil).toBe(clock.now + 1_800_000);
}));
test('completed encounter evidence changes the preferred site rather than a hardcoded tier bonus', fixture(async d => {
  const s = state(); s.nearbyNpcs = [npc()];
  const a = { id: 'training-attack-chickens', type: 'interactNpc', fields: { trainingSite: 'chickens', npcIndex: 7 }, waitTicks: 6 };
  for (let i = 0; i < 3; i++) { d.beforeAction(s, a); const next = structuredClone(s); next.tick += 6; next.skills[0].experience += 60; next.nearbyNpcs = []; d.afterAction(s, next, a); s.tick += 10; }
  expect((await d.next(s, route))[0].fields?.trainingSite).toBe('chickens');
}));
test('higher-tier readiness clears a stale starter commitment', fixture(async d => {
  const s = state();
  s.skills[0].level = 92;
  s.combatStyle.weaponName = 'Bronze scimitar';
  s.inventory = [{ name: 'Shrimps', count: 8, slot: 0, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }];
  d.memory.commitment = { siteId: 'cows', since: 1, encounters: 20 };
  const action = (await d.next(s, route))[0];
  expect(d.memory.commitment?.siteId).toBe('barbarians');
  expect(action.fields?.trainingSite).toBe('barbarians');
}));
test('an active commitment yields immediately when equipment stops being viable', fixture(async d => {
  const s = state(); await d.next(s, route); s.tick++; s.combatStyle.weaponName = 'Unarmed';
  const a = (await d.next(s, route))[0]; expect(a.type).toBe('wait'); expect(a.fields?.npcIndex).toBeUndefined();
}));
test('empty site waits for bounded local respawn evidence before cooling down', fixture(async (d, _file, clock) => {
  const s = state(); s.skills[0].level = 1; d.memory.sites.cows.cooldownUntil = clock.now + 500_000;
  for (let i = 0; i < 3; i++) { s.tick += 5; await d.next(s, route); }
  expect(d.memory.sites.chickens.cooldownUntil).toBe(0);
  s.tick += 50; await d.next(s, route); expect(d.memory.sites.chickens.cooldownUntil).toBeGreaterThan(clock.now);
}));
test('encounter timeout requests recovery without inventing a completed escape', fixture(d => {
  const s = state(); s.nearbyNpcs = [npc()];
  const a = { id: 'training-attack-chickens', type: 'interactNpc', fields: { trainingSite: 'chickens', npcIndex: 7 }, waitTicks: 6 };
  d.beforeAction(s, a); const next = structuredClone(s); next.tick += 181;
  next.player.combat = { inCombat: true, targetType: 'npc', targetIndex: 7, lastDamageTick: next.tick };
  d.afterAction(s, next, { id: 'continue-combat', type: 'wait', waitTicks: 2 });
  expect(d.timedOut(next)).toBe(true); expect(Object.keys(d.memory.sites.chickens.stats)).toHaveLength(0);
  d.afterAction(next, { ...next, tick: next.tick + 2 }, { id: 'escape', type: 'retreat', waitTicks: 2 });
  expect(Object.values(d.memory.sites.chickens.stats)[0].escapes).toBe(1);
}));
test('failed committed route falls back within the same selection without arbitrary adjacent success', fixture(async (d, _file, clock) => {
  d.memory.commitment = { siteId: 'barbarians', since: clock.now, encounters: 0 };
  const a = (await d.next(state(), async (f,t) => t.x === 200 ? { status: 'blocked', reason: 'partial-path' } : route(f,t)))[0];
  expect(a.fields?.trainingSite).toBe('cows'); expect(a.fields?.x).toBe(110);
}));
test('a fence detour cannot change the committed approach midway through travel', fixture(async (d, _file, clock) => {
  const s=state();s.skills[0].level=1;s.player.worldX=90;
  d.memory.sites.cows.cooldownUntil=clock.now+500_000;
  d.memory.sites.chickens.points=[{x:100,z:100,level:0},{x:80,z:100,level:0}];
  const first=(await d.next(s,route))[0];expect(first.fields?.x).toBe(100);
  s.player.worldX=85;s.tick+=2;
  expect((await d.next(s,route))[0].fields?.x).toBe(100);
}));

test('costly repeated higher-tier outcomes overcome its exploration bonus', fixture(async d => {
  const s=state(),key='melee:Iron scimitar:def0:skill2';
  d.memory.sites.cows.stats[key]={encounters:10,kills:10,productive:10,xp:500,ticks:100,damage:0,food:0,ammo:0,escapes:0,deaths:0};
  d.memory.sites.barbarians.stats[key]={encounters:10,kills:0,productive:0,xp:10,ticks:1000,damage:500,food:100,ammo:0,escapes:5,deaths:2};
  expect((await d.next(s,route))[0].fields?.trainingSite).toBe('cows');
}));

test('whole-trip measurements include support, outward travel and return; restart does not erase the trip', fixture((d,file,clock)=>{
  let s=state();d.beginTrial(s,{key:'test-trip',domain:'combat',target:{fact:'xp:strength'}});
  const step=(ticks:number,action:any,change:(v:any)=>void=()=>{})=>{const a=structuredClone(s);a.tick+=ticks;change(a);d.afterAction(s,a,action);s=a;};
  step(20,{id:'prep',type:'wait'});
  step(20,{id:'walk-out',type:'walkTo',fields:{trainingSite:'chickens'}},s=>s.player.worldX=101);
  step(10,{id:'trial',type:'interactNpc',fields:{trainingSite:'chickens'}},s=>s.skills[0].experience+=50);
  expect(d.memory.completedTrips).toBeUndefined();expect(d.memory.sites.chickens.tripStats).toBeUndefined();
  const resumed=new TrainingDiscovery(file,'stinger',catalog,false,false,()=>clock.now);
  const bank=structuredClone(s);bank.tick+=50;bank.bank={isOpen:true,items:[]};
  resumed.afterAction(s,bank,{id:'open-bank',type:'interactLoc',fields:{},waitTicks:1});
  const measured=Object.values(resumed.memory.sites.chickens.tripStats??{})[0];
  expect(measured).toMatchObject({trips:1,xp:50,ticks:100,spentGp:0});expect(resumed.memory.trip).toBeUndefined();
  expect(resumed.memory.completedTrips?.[0]?.mixed).toBe(false);
  resumed.afterAction(s,bank,{id:'duplicate-result',type:'interactLoc',fields:{},waitTicks:1});
  expect(Object.values(resumed.memory.sites.chickens.tripStats??{})[0].trips).toBe(1);
}));

test('unsampled accounting changes cannot produce a trusted full-trip estimate', fixture(d=>{
  const s=state();d.beginTrial(s,{key:'test-trip',domain:'combat',target:{fact:'xp:strength'}});
  const before=structuredClone(s);before.skills[0].experience+=500;before.tick+=50;
  const after=structuredClone(before);after.tick+=5;after.skills[0].experience+=10;
  d.afterAction(before,after,{id:'trial',type:'interactNpc',fields:{trainingSite:'chickens'},waitTicks:1});
  const bank=structuredClone(after);bank.tick+=20;bank.bank={isOpen:true,items:[]};
  d.afterAction(after,bank,{id:'bank',type:'interactLoc',fields:{},waitTicks:1});
  expect(d.memory.completedTrips?.[0]?.mixed).toBe(true);expect(d.memory.sites.chickens.tripStats).toBeUndefined();
}));

test('a death does not become a successful full-trip return', fixture(d=>{
  const s=state();d.beginTrial(s,{key:'test-trip',domain:'combat',target:{fact:'xp:strength'}});
  const after=structuredClone(s);after.tick+=10;after.player.lifeId++;
  d.afterAction(s,after,{id:'wait',type:'wait',waitTicks:1});
  expect(d.memory.completedTrips?.[0]?.result).toBe('interrupted');expect(d.memory.sites.chickens.tripStats).toBeUndefined();
}));

const guideCatalog:Catalog={...catalog,sites:catalog.sites.map(s=>({...s,id:s.id==='chickens'?'east-chickens':s.id==='cows'?'east-cows':'village-barbarians'}))};
test('superior measured full-trip performance outweighs a recommended-site prior', fixture(async d=>{
  const s=state(),key='melee:Iron scimitar:def0:skill2:target-strength';s.skills.push({name:'defence',level:1,experience:0});
  d.memory.sites['east-chickens'].tripStats={[key]:{trips:1,xp:10,ticks:500,food:1,ammo:0,spentGp:1}};
  d.memory.sites['east-cows'].tripStats={[key]:{trips:3,xp:900,ticks:90,food:0,ammo:0,spentGp:0}};
  const a=(await d.next(s,route,['lumbridge-chickens'],'strength'))[0];
  expect(a.fields?.trainingSite).toBe('east-cows');
}, {catalog:guideCatalog}));
test('guide recommendation cannot override a blocked route or manufacture rock-crab content', fixture(async d=>{
  const s=state();s.skills[0].level=1;
  const a=(await d.next(s,async(f,t)=>t.x===100?{status:'blocked'}:route(f,t),['lumbridge-chickens','rock-crabs'],'strength'))[0];
  expect(a.fields?.trainingSite).toBe('east-cows');
  expect(Object.values(d.memory.sites).some(s=>s.name.includes('Rock'))).toBe(false);
  expect(d.memory.status.guideLeads.find((l:any)=>l.id==='rock-crabs').status).toBe('investigation-required');
}, {catalog:guideCatalog}));
test('the selected training skill supersedes the original role mode but unsupported magic is not faked', fixture(async d=>{
  const s=state();s.skills[0].level=1;s.combatStyle.weaponName='Shortbow';s.equipment=[{name:'Iron arrow',count:50}];
  expect((await d.next(s,route,[],'ranged'))[0].type).not.toBe('interactLoc');
  d.memory.commitment=undefined;s.tick++;s.combatStyle.weaponName='Iron scimitar';s.equipment=[];
  expect((await d.next(s,route,[],'strength'))[0].id).not.toContain('no-viable');
  expect((await d.next(s,route,[],'magic'))[0].id).toBe('training-spell-executor-required');
}));
