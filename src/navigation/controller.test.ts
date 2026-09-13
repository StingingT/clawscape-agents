import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Navigator } from './controller';
import { splitRoute, interrupted } from './geometry';
const start = { x: 100, z: 100, level: 0 }, goal = { x: 103, z: 100, level: 0 };
const state = () => ({ tick: 1, player: { worldX: 100, worldZ: 100, level: 0, hp: 10, lifeId: 1, combat: { inCombat: false } }, nearbyLocs: [] });
test('map preparation is read-only and an unready planner times out',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'claw-nav-test-'));let actions=0;
  const nav=new Navigator({state:async()=>state(),act:async()=>{actions++;return{};},wait:async()=>{actions++;return state();}},join(dir,'navigation.json'),async()=>({legs:[]}));
  try {
    await nav.prepare(0);expect(actions).toBe(0);
    (nav as any).ready=false;
    await expect(nav.prepare(0)).rejects.toThrow('map-initialization-timeout');
    expect(actions).toBe(0);
  }finally{nav.close();rmSync(dir,{recursive:true});}
});
test('subdivision preserves detour turns and limits each leg', () => {
  const legs = splitRoute(start, [{ x: 80, z: 100, level: 0 }, { x: 80, z: 120, level: 0 }]);
  expect(legs).toEqual([{ x: 88, z: 100, level: 0 }, { x: 80, z: 100, level: 0 }, { x: 80, z: 112, level: 0 }, { x: 80, z: 120, level: 0 }]);
});
test('interrupts on damage, life changes, plane changes and tick reset', () => {
  const a = state();
  expect(interrupted(a, { ...a, player: { ...a.player, hp: 9 } })).toBe('danger');
  expect(interrupted(a, { ...a, player: { ...a.player, lifeId: 2 } })).toBe('respawned');
  expect(interrupted(a, { ...a, player: { ...a.player, level: 1 } })).toBe('plane-changed');
  expect(interrupted(a, { ...a, tick: 0 })).toBe('session-reset');
});
for (const mode of ['arrival', 'stalled', 'rejected', 'damage', 'wrong-plane'] as const) test(`controller: ${mode}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-'));
  let s = state(), commands = 0, polls = 0;
  const nav = new Navigator({ state: async () => s, act: async () => { commands++; if (mode === 'rejected') throw new Error('success:false client_rejected'); return {}; }, wait: async () => {
    polls++; s = { ...s, tick: s.tick + 2, player: { ...s.player } };
    if (mode === 'arrival') s.player.worldX = goal.x;
    if (mode === 'damage') s.player.hp--;
    return s;
  } }, join(dir, 'navigation.json'), async () => ({ legs: [{ target: goal, doors: [] }] }));
  try {
    const result = await nav.step(mode === 'wrong-plane' ? { ...goal, level: 1 } : goal, s);
    expect(result.navigation.status).toBe(mode === 'arrival' ? 'arrived' : mode === 'damage' ? 'interrupted' : 'blocked');
    if (mode === 'stalled') { expect(polls).toBe(3); await nav.step(goal, s); expect(commands).toBe(1); }
    if (mode === 'rejected' || mode === 'wrong-plane') expect(polls).toBe(0);
    if (mode === 'damage') expect(commands).toBe(1);
  } finally { nav.close(); rmSync(dir, { recursive: true }); }
});
test('damage near Draynor immediately dispatches escape, not idle wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-'));
  let s = { ...state(), player: { ...state().player, worldX: 3087, worldZ: 3237 } };
  const commands: any[] = [];
  const nav = new Navigator({ state: async () => s, act: async (type, fields) => { commands.push({ type, fields }); return {}; }, wait: async () => {
    if (commands.length === 1) s = { ...s, tick: s.tick + 2, player: { ...s.player, hp: 7 } };
    else s = { ...s, tick: s.tick + 2, player: { ...s.player, worldX: 3094, worldZ: 3226 } };
    return s;
  } }, join(dir, 'navigation.json'), async (_from, to) => ({ legs: [{ target: to, doors: [] }] }));
  try {
    const result = await nav.step({ x: 3087, z: 3230, level: 0 }, s);
    expect(commands.length).toBe(2);
    expect(commands[1].fields).toMatchObject({ x: 3094, z: 3226, running: true });
    expect(result.state.player.hp).toBe(7);
    expect(result.navigation.escape).toBe(true);
    expect(result.navigation.status).toBe('arrived');
  } finally { nav.close(); rmSync(dir, { recursive: true }); }
});

test('out-of-arrows chicken retreat opens the implicated gate and retains the exterior target across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-')), file = join(dir, 'navigation.json');
  const door = { x: 3236, z: 3295, level: 0 };
  let s: any = { ...state(), player: { ...state().player, worldX: 3232, worldZ: 3295, combat: { inCombat: true, targetType: 'npc', targetIndex: 7 } }, nearbyNpcs: [{ index: 7, optionsWithIndex: [{ text: 'Attack' }] }], nearbyLocs: [{ ...door, id: 100, name: 'Gate', reachable: true, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }] };
  const commands: any[] = [], destinations: any[] = [];
  const port = { state: async () => s, act: async (type: string, fields: any) => { commands.push({ type, fields }); return { success: true, phase: 'dispatch' }; }, wait: async () => {
    s.tick += 2;
    const last = commands.at(-1);
    if (last.type === 'interactLoc') s.nearbyLocs = [];
    if (last.type === 'walkTo') { s.player.worldX = last.fields.x; s.player.worldZ = last.fields.z; }
    return structuredClone(s);
  } };
  const planner = async (from: any, to: any) => { destinations.push(to); return { legs: from.x === 3232 ? [{ target: { x: 3235, z: 3295, level: 0 }, doors: [door] }, { target: to, doors: [] }] : [{ target: to, doors: [] }] }; };
  let nav = new Navigator(port, file, planner);
  try {
    expect((await nav.escape(structuredClone(s))).navigation.status).toBe('progress');
    expect(commands[0].type).toBe('interactLoc');
    nav.close(); nav = new Navigator(port, file, planner);
    expect((await nav.escape(structuredClone(s))).navigation.status).toBe('arrived');
    expect(destinations.every(p => p.x === 3238 && p.z === 3295)).toBe(true);
    expect(commands.filter(c => c.type === 'walkTo').map(c => c.fields.x)).toEqual([3235, 3238]);
  } finally { nav.close(); rmSync(dir, { recursive: true }); }
});

test('legacy interior retreat target is replaced by the exterior gate route', async () => {
  const dir=mkdtempSync(join(tmpdir(),'claw-nav-test-')),file=join(dir,'navigation.json');
  writeFileSync(file,JSON.stringify({escapeTarget:{x:3226,z:3296,level:0},escapeLife:1}));
  let s={...state(),player:{...state().player,worldX:3226,worldZ:3296}},chosen:any;
  const nav=new Navigator({state:async()=>s,act:async()=>({}),wait:async()=>{s={...s,tick:s.tick+2,player:{...s.player,worldX:3238,worldZ:3295}};return s;}},file,async(_f,to)=>{chosen=to;return{legs:[{target:to,doors:[]}]};});
  try { expect((await nav.escape(s)).navigation.status).toBe('arrived');expect(chosen).toEqual({x:3238,z:3295,level:0}); }
  finally{nav.close();rmSync(dir,{recursive:true});}
});

test('escape with an unchanged closed gate is bounded and retains cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-'));
  const door = { x: 3236, z: 3295, level: 0 };
  let s: any = { ...state(), player: { ...state().player, worldX: 3232, worldZ: 3295 }, nearbyLocs: [{ ...door, id: 100, name: 'Gate', reachable: true, optionsWithIndex: [{ text: 'Open', opIndex: 1 }] }] };
  let commands = 0;
  const nav = new Navigator({ state: async () => structuredClone(s), act: async () => { commands++; return {}; }, wait: async () => { s.tick += 2; return structuredClone(s); } }, join(dir, 'navigation.json'), async (_from, to) => ({ legs: [{ target: to, doors: [door] }] }));
  try {
    let result: any;
    for (let i = 0; i < 4; i++) result = await nav.escape(structuredClone(s));
    expect(result.navigation.status).toBe('blocked'); expect(commands).toBe(3);
  } finally { nav.close(); rmSync(dir, { recursive: true }); }
});

test('a partial route ending adjacent never proves arrival or an interaction approach', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-')); let commands = 0;
  const nav = new Navigator({ state: async () => state(), act: async () => { commands++; return {}; }, wait: async () => state() }, join(dir, 'navigation.json'), async () => ({ legs: [{ target: { ...goal, x: goal.x - 1 }, doors: [] }] }));
  try {
    expect((await nav.assess(start, goal)).status).toBe('blocked');
    expect((await nav.step(goal, state())).navigation.reason).toBe('partial-path'); expect(commands).toBe(0);
  } finally { nav.close(); rmSync(dir, { recursive: true }); }
});
test('planned route is persisted and reused after controller restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-')), file = join(dir, 'navigation.json');
  let s: any = state(), plans = 0;
  const port = { state: async () => structuredClone(s), act: async (type: string, fields: any) => { s.player.worldX = fields.x; s.player.worldZ = fields.z; return {}; }, wait: async () => structuredClone(s) };
  const planner = async (_from: any, to: any) => { plans++; return { legs: [{ target: to, doors: [] }], hash: 'map-test' }; };
  let nav = new Navigator(port, file, planner);
  try {
    expect((await nav.step(goal, s)).navigation.status).toBe('arrived');
    expect(plans).toBe(1);
    nav.close(); nav = new Navigator(port, file, async () => { plans++; throw new Error('route should have been recalled'); });
    s = { ...s, tick: 2, player: { ...s.player, worldX: start.x, worldZ: start.z } };
    expect((await nav.step(goal, s)).navigation.status).toBe('arrived');
    expect(plans).toBe(1);
  } finally { nav.close(); rmSync(dir, { recursive: true }); }
});

test('success:false dispatch is rejected without waiting for movement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-')); let waits = 0;
  const nav = new Navigator({ state: async () => state(), act: async () => ({ success: false, reason: 'client_rejected' }), wait: async () => { waits++; return state(); } }, join(dir, 'navigation.json'), async () => ({ legs: [{ target: goal, doors: [] }] }));
  try { expect((await nav.step(goal, state())).navigation.status).toBe('blocked'); expect(waits).toBe(0); }
  finally { nav.close(); rmSync(dir, { recursive: true }); }
});
test('new life discards an old escape target without permanently blocking future recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-'));
  let s = { ...state(), player: { ...state().player, worldX: 3232, worldZ: 3295 } };
  const nav = new Navigator({ state: async () => structuredClone(s), act: async () => ({}), wait: async () => { s.tick+=2;s.player.worldX=3238;return structuredClone(s); } }, join(dir, 'navigation.json'), async (_f,to)=>({legs:[{target:to,doors:[]}]}));
  try {
    expect((await nav.escape(structuredClone(s))).navigation.status).toBe('arrived');
    s.player.lifeId=2;s.player.worldX=3232;
    expect((await nav.escape(structuredClone(s))).navigation.reason).toBe('respawned');
    expect((await nav.escape(structuredClone(s))).navigation.status).toBe('arrived');
  } finally { nav.close(); rmSync(dir, { recursive: true }); }
});
test('discovery cannot mistake SDK mainland fill for measured collision coverage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claw-nav-test-'));
  const nav = new Navigator({ state: async()=>state(),act:async()=>{throw new Error('read-only probe');},wait:async()=>state() },join(dir,'navigation.json'),async()=>({legs:[{target:goal,doors:[]}],unmappedTiles:3}));
  try { expect((await nav.assess(start,goal)).reason).toBe('unverified-collision-coverage'); }
  finally { nav.close();rmSync(dir,{recursive:true}); }
});
