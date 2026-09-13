#!/usr/bin/env bun
// Supervised integration probe, not the production navigator. Default: plan
// only. --execute requires the character's normal runner to be paused first.
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
function arg(name: string, fallback: string) { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] ?? fallback; }
const character = arg('character', 'coincrafter');
if (!/^[a-z0-9_-]+$/i.test(character)) throw new Error('Invalid character');
const execute = args.includes('--execute');
const deposit = args.includes('--deposit-logs');
const returnTrip = args.includes('--return');
type Tile = { x: number; z: number; level: number };
type State = any;
function parseTile(value: string): Tile {
  const parts = value.split(',');
  const nums = parts.map(Number);
  if (parts.length !== 3 || parts.some(p => !p.trim()) || nums.some(n => !Number.isInteger(n) || n < 0) || nums[2]! > 3) throw new Error('Use x,z,plane');
  return { x: nums[0]!, z: nums[1]!, level: nums[2]! };
}
const goal = parseTile(arg('to', '3185,3436,0'));
const returnTo = args.includes('--return-to') ? parseTile(arg('return-to', '')) : undefined;
if (returnTo && !returnTrip) throw new Error('--return-to requires --return');
const started = Date.now();
const logs = resolve(root, 'data', 'navigation-tests');
mkdirSync(logs, { recursive: true });
const logPath = resolve(logs, `${character}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
function record(event: string, data: object = {}) {
  const row = { time: new Date().toISOString(), event, character, ...data };
  appendFileSync(logPath, JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}
async function cli(...params: string[]) {
  const child = Bun.spawn([process.execPath, resolve(root, '../tmp/clawscape/src/cli.ts'), '--character', character, ...params], {
    env: { ...process.env, CLAWSCAPE_HOME: process.env.CLAWSCAPE_HOME ?? resolve(root, 'data/online-home') }, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`CLI failed: ${err.trim() || 'no successful response'}`);
    const result = JSON.parse(out);
    if (result.error || result.success === false) throw new Error(`DISPATCH_REJECTED ${result.reason ?? ''}: ${result.message ?? result.error}`);
    return result;
  } finally { clearTimeout(timer); }
}
async function state(): Promise<State> { const result = await cli('state'); if (!result.connected || !result.state?.player) throw new Error('No connected character state'); return result.state; }
function position(s: State): Tile { return { x: s.player.worldX, z: s.player.worldZ, level: s.player.level }; }
const distance = (a: Tile, b: Tile) => a.level !== b.level ? Infinity : Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
async function act(type: string, fields: object = {}) {
  if (!execute) throw new Error('Read-only probe cannot dispatch actions');
  const result = await cli('act', type, '--json', JSON.stringify({ ...fields, reason: 'supervised navigation test' }));
  record('dispatch', { type, fields, phase: result.phase, success: result.success });
}
async function wait(ticks = 2): Promise<State> { const result = await cli('wait', String(ticks)); return result.state ?? await state(); }
let life: number;
let initialHp: number;
let previousSafe: Tile[] = [];
async function check(s: State) {
  if (Date.now() - started > 12 * 60_000) throw new Error('Test time budget exhausted');
  if (s.player.isDead || s.player.lifeId !== life) throw new Error('RESPAWN: old route invalid');
  if (s.player.hp < initialHp || s.player.combat?.inCombat) {
    record('safety-interrupt', { player: s.player });
    const food = s.inventory.find((i: any) => i.optionsWithIndex?.some((o: any) => /^eat$/i.test(o.text)));
    if (food && s.player.hp < s.player.maxHp * .75) {
      if (s.bank?.isOpen || s.shop?.isOpen) await act('closeModal');
      await act('useInventoryItem', { slot: food.slot, optionIndex: food.optionsWithIndex.find((o: any) => /^eat$/i.test(o.text)).opIndex });
      s = await wait();
    }
    for (const safe of previousSafe.slice(-6).reverse()) {
      if (distance(position(s), safe) < 4) continue;
      try { await act('walkTo', { x: safe.x, z: safe.z, running: true }); s = await wait(3); } catch { break; }
      if (!s.player.combat?.inCombat) break;
    }
    throw new Error('Safety interrupt: test stopped and attempted backtrack');
  }
}

async function main() {
  const planner = await import(pathToFileURL(resolve(root, '../tmp/clawscape/upstream/sdk/pathfinding.ts')).href);
  planner.initPathfinding();
  let s = await state();
  const origin = position(s);
  life = s.player.lifeId;
  initialHp = s.player.hp;
  previousSafe = [origin];
  record('start', { execute, goal, origin, returnTo, hp: initialHp, inventorySlots: s.inventory.length, logPath });
  await check(s);
  if (execute && (s.dialog?.isOpen || s.bank?.isOpen || s.shop?.isOpen)) {
    await act('closeModal'); s = await wait(); await check(s);
    if (s.dialog?.isOpen || s.bank?.isOpen || s.shop?.isOpen) throw new Error('MODAL_DID_NOT_CLOSE');
  }
  const doorAttempts = new Map<string, number>();
  async function travel(destination: Tile) {
    s = await state(); await check(s);
    if (position(s).level !== destination.level) throw new Error('TRANSITION_REQUIRED');
    const route: Tile[] = planner.findLongPath(destination.level, s.player.worldX, s.player.worldZ, destination.x, destination.z, 500);
    const endpoint = route.at(-1) ?? position(s);
    if (distance(endpoint, destination) > 0) throw new Error(`PARTIAL_PATH ${JSON.stringify(endpoint)}`);
    record('planned', { destination, waypoints: route.length, endpoint });
    if (!execute) return;
    for (const point of route) {
      while (distance(position(s), point) > 0) {
        await check(s);
        const from = position(s);
        const length = distance(from, point);
        const scale = Math.min(1, 12 / length);
        const target = { x: Math.round(from.x + (point.x - from.x) * scale), z: Math.round(from.z + (point.z - from.z) * scale), level: point.level };
        const samples: Tile[] = [];
        for (let i = 0, count = distance(from, target); i <= count; i++) samples.push({
          x: Math.round(from.x + (target.x - from.x) * i / Math.max(1, count)),
          z: Math.round(from.z + (target.z - from.z) * i / Math.max(1, count)), level: from.level,
        });
        const predicted = planner.findDoorsAlongPath(samples);
        const door = s.nearbyLocs?.find((loc: any) => loc.reachable && loc.level === from.level &&
          loc.optionsWithIndex?.some((o: any) => /^open$/i.test(o.text)) &&
          predicted.some((p: Tile) => distance(p, loc) <= 1));
        if (door) {
          const id = `${door.level},${door.x},${door.z}`;
          const attempts = (doorAttempts.get(id) ?? 0) + 1;
          if (attempts > 2) throw new Error(`DOOR_BLOCKED ${id}`);
          doorAttempts.set(id, attempts);
          await act('interactLoc', { x: door.x, z: door.z, locId: door.id, optionIndex: door.optionsWithIndex.find((o: any) => /^open$/i.test(o.text)).opIndex });
          s = await wait(3); await check(s);
          record('door-observed', { at: id, position: position(s), current: s.nearbyLocs.filter((l: any) => l.x === door.x && l.z === door.z) });
        }
        await act('walkTo', { x: target.x, z: target.z, running: true });
        let stationary = 0;
        let prev = position(s);
        for (let tick = 0; tick < 18; tick += 2) {
          s = await wait(); await check(s);
          const now = position(s);
          stationary = distance(prev, now) === 0 ? stationary + 2 : 0;
          if (distance(now, target) === 0) break;
          if (stationary >= 6) throw new Error(`NO_PROGRESS ${JSON.stringify({ from: now, target, messages: s.gameMessages?.slice(-3), feedback: s.opFeedback })}`);
          prev = now;
        }
        if (distance(position(s), target) > 0) throw new Error('Leg exceeded observation budget');
        previousSafe.push(position(s));
        record('leg-arrived', { position: position(s), hp: s.player.hp });
      }
    }
    record('arrived', { position: position(s), destination });
  }
  await travel(goal);
  if (execute && deposit) {
    s = await state();
    const booth = s.nearbyLocs.find((loc: any) => /bank booth|bank chest/i.test(loc.name) && loc.reachable && loc.optionsWithIndex?.some((o: any) => /bank|use/i.test(o.text)));
    if (!booth) throw new Error('NO_USABLE_BANK: coordinate arrival is not service arrival');
    // Use starts a banker conversation. Use-quickly opens the bank directly.
    // Resolve the current option index from observation, never hard-code it.
    const bankOption = booth.optionsWithIndex.find((o: any) => /^use-quickly$/i.test(o.text))
      ?? booth.optionsWithIndex.find((o: any) => /^bank$/i.test(o.text));
    if (!bankOption) throw new Error('NO_DIRECT_BANK_OPTION: dialog handling required');
    await act('interactLoc', { x: booth.x, z: booth.z, locId: booth.id, optionIndex: bankOption.opIndex });
    s = await wait(3);
    if (!s.bank?.isOpen) throw new Error('BANK_DID_NOT_OPEN');
    const sumLogs = (items: any[]) => items.filter(i => /^logs$/i.test(i.name)).reduce((n, i) => n + i.count, 0);
    const carriedBefore = sumLogs(s.inventory);
    const bankBefore = sumLogs(s.bank.items);
    const logs = s.inventory.find((i: any) => /^logs$/i.test(i.name));
    if (!logs || carriedBefore === 0) throw new Error('No logs to verify deposit');
    await act('bankDeposit', { slot: logs.slot, amount: -1 });
    s = await wait(3);
    const carriedAfter = sumLogs(s.inventory);
    const bankAfter = sumLogs(s.bank.items);
    if (carriedAfter !== 0 || bankAfter - bankBefore !== carriedBefore) throw new Error('DEPOSIT_MISMATCH');
    record('deposit-verified', { carriedBefore, carriedAfter, bankBefore, bankAfter });
    await act('closeModal'); s = await wait();
    if (s.bank?.isOpen) throw new Error('Bank did not close');
  }
  if (execute && returnTrip) await travel(returnTo ?? origin);
  record('passed', { mode: execute ? 'live' : 'offline', returnTrip: execute && returnTrip, deposit: execute && deposit, elapsedMs: Date.now() - started });
}
main().catch(error => { record('failed', { message: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started }); process.exitCode = 1; });
