import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Navigator, position } from '../src/navigation/controller';
import { acquireController } from '../src/controller-lease';
import { RuneMysteries, type QuestMemory } from '../src/quests/rune-mysteries';
import { isFood, isThreatened, verifyBankTransfer } from '../src/runtime-policy';

const arg = (key: string, fallback: string) => process.argv[process.argv.indexOf(`--${key}`) + 1] ?? fallback;
const character = process.argv.includes('--character') ? arg('character', '') : '';
const profiles: Record<string, string> = { clawscout: 'online', stinger: 'stinger', coincrafter: 'coincrafter' };
if (!(character in profiles)) throw new Error('Select one existing character: clawscout, stinger, coincrafter. Astra uses its own arbiter.');
const root = resolve(import.meta.dir, '..');
const dir = resolve(root, 'data', profiles[character]!);
mkdirSync(dir, { recursive: true });
const file = resolve(dir, 'rune-mysteries.json');
const statusFile = resolve(dir, 'quest-status.json');
const log = resolve(dir, 'rune-mysteries.jsonl');
const cli = resolve(root, '../tmp/clawscape/src/cli.ts');
const seconds = process.argv.includes('--seconds') ? Number(arg('seconds', '900')) : 900;
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 1800) throw new Error('Quest session must be 1..1800 seconds');
let memory: QuestMemory = { character };
try { memory = JSON.parse(readFileSync(file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('Quest memory unreadable'); }
if (memory.character !== character) throw new Error('Quest memory belongs to another character');
if (process.argv.includes('--resume-blocked')) { delete memory.blocked; memory.failures = 0; memory.actions = 0; }
const quest = new RuneMysteries(memory);
const release = acquireController(resolve(dir, 'controller.lock'));
let navigator: Navigator | undefined;
let state: any;
let connected = false;
let logoutVerified = false;
let logoutRequested = false;
async function call(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, '--character', character, ...args], {
    env: { ...process.env, CLAWSCAPE_HOME: process.env.CLAWSCAPE_HOME ?? resolve(root, 'data/online-home') }, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [output, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`CLI_${args[0]}_FAILED`); // Never print raw errors/config.
    const result = JSON.parse(output);
    if (result.error || result.success === false) throw new Error(`CLI_${args[0]}_REJECTED`);
    return result;
  } finally { clearTimeout(timer); }
}
let lastThreatTick: number | undefined;
const extract = (result: any) => {
  const s=result.state ?? result;
  // Capture the actual trigger before Navigator has retreated out of range.
  // A combat target is recorded as a target, never asserted to be the attacker.
  if(s.player && isThreatened(s) && s.tick!==lastThreatTick) {
    lastThreatTick=s.tick;
    const c=s.player.combat, n=s.nearbyNpcs?.find((n:any)=>n.index===c?.targetIndex);
    appendFileSync(log,JSON.stringify({time:new Date().toISOString(),character,event:'quest-threat-observed',
      tick:s.tick,position:position(s),hp:s.player.hp,
      combat:{inCombat:c?.inCombat,lastDamageTick:c?.lastDamageTick,targetType:c?.targetType},
      target:n?{name:n.name,x:n.x,z:n.z}:undefined})+'\n');
  }
  return s;
};
function save() {
  writeFileSync(file, JSON.stringify(memory, null, 2));
  if (state) writeFileSync(statusFile, JSON.stringify({ time: new Date().toISOString(), character, connected, logoutVerified, logoutRequested,
    tick: state.tick, position: state.player ? position(state) : null, hp: state.player?.hp, maxHp: state.player?.maxHp,
    inventory: state.inventory?.map((i: any) => ({ id: i.id, name: i.name, count: i.count })), quest: quest.summary(),
    threatened:isThreatened(state), lifeId:state.player?.lifeId, respawnCount:state.player?.respawnCount,
    nearbyNpcs:memory.blocked ? state.nearbyNpcs?.map((n:any)=>({name:n.name,typeId:n.typeId,x:n.x,z:n.z,inCombat:n.inCombat})) : undefined,
  }, null, 2));
}
try {
  if (memory.blocked) throw new Error(`QUEST_BLOCKED:${memory.blocked}; inspect before explicit --resume-blocked`);
  // Do not pre-empt a non-cooperating/manual connection. Live proof runs start
  // from a disconnected character and retain this single local owner.
  let existing: any;
  try { existing = await call(['state']); } catch {}
  if (existing?.connected === true || extract(existing ?? {}).inGame === true) throw new Error('EXISTING_CONNECTION_REQUIRES_OWNER_HANDOFF');
  navigator = new Navigator({ state: async () => extract(await call(['state'])),
    act: async (type, fields) => call(['act', type, '--json', JSON.stringify({ ...fields, reason: 'Rune Mysteries route' })]),
    wait: async ticks => extract(await call(['wait', String(ticks)])) }, resolve(dir, 'quest-navigation.json'), undefined, true);
  // Load the large collision map before exposing a logged-in character to NPCs.
  await navigator.prepare();
  await call(['connect']); connected = true;
  state = extract(await call(['state']));
  const deadline = Date.now() + seconds * 1000;
  for (let count = 0; count < 900 && Date.now() < deadline; count++) {
    state = extract(await call(['state']));
    const action = quest.next(state); save();
    if (!action || memory.blocked) break;
    const before = state;
    let result: any;
    if (action.type === 'walkTo') {
      result = await navigator.step({ x: action.fields!.x, z: action.fields!.z, level: action.fields!.level }, state);
      state = result.state;
      if (state.tick === before.tick && result.navigation.status !== 'arrived') state = extract(await call(['wait', '2']));
    } else {
      result = await call(action.type === 'wait' ? ['wait', String(action.waitTicks)] : ['act', action.type, '--json', JSON.stringify({ ...action.fields, reason: 'Rune Mysteries quest' })]);
      state = action.type === 'wait' ? extract(result) : extract(await call(['wait', String(action.waitTicks)]));
      if(action.id==='quest-pick-food') {
        const total=(s:any)=>(s.inventory??[]).filter((i:any)=>i.id===1965).reduce((n:number,i:any)=>n+i.count,0);
        for(let poll=0;poll<3&&total(state)<=total(before)&&!isThreatened(state)&&state.player?.hp===before.player?.hp;poll++)state=extract(await call(['wait','2']));
      }
    }
    quest.observe(before, state, action, result);
    if(action.type==='bankDeposit') {
      if(!verifyBankTransfer(before,state,action))quest.block('quest-bank-transfer-unverified');
      else {
        const workPath=resolve(dir,'work-state.json');
        try { const work=JSON.parse(readFileSync(workPath,'utf8'));work.bankItems=state.bank.items;
          if(work.economy)work.economy.bankItems=state.bank.items;
          writeFileSync(workPath,JSON.stringify(work,null,2));
        } catch(e:any) { if(e.code!=='ENOENT')quest.block('bank-memory-update-failed'); }
      }
    }
    const record = { time: new Date().toISOString(), character, action: action.id, type: action.type, tick: state.tick,
      position: position(state), hp: state.player.hp, navigation: result?.navigation?.status, quest: quest.summary() };
    appendFileSync(log, JSON.stringify(record) + '\n'); console.log(JSON.stringify(record)); save();
    if (memory.blocked) break;
  }
  if (!memory.blocked && !memory.returned) quest.block('bounded-session-ended; resume from fresh journal');
  // A detected attack stops questing. Heal, then use the same navigator's
  // observed retreat trail; this does not authorize fighting unrelated NPCs.
  for (let attempts = 0; state?.player && isThreatened(state) && attempts < 6; attempts++) {
    const food = state.inventory?.find(isFood);
    if (food && Number(state.player.hp) < Number(state.player.maxHp) * .9) {
      const eat = food.optionsWithIndex.find((o: any) => /^eat$/i.test(o.text));
      await call(['act', 'useInventoryItem', '--json', JSON.stringify({slot: food.slot, optionIndex: eat.opIndex, reason: 'quest emergency healing'})]);
      state = extract(await call(['wait', '1']));
    } else state = (await navigator.escape(state)).state;
  }
} catch (error: any) {
  quest.block(error.message); console.error(JSON.stringify({ character, blocker: error.message })); process.exitCode = 1;
} finally {
  navigator?.close();
  if (connected) {
    try {
      const result = await call(['disconnect']); logoutRequested = result.ok === true;
      for (let poll=0; poll<10; poll++) {
        try { const after=await call(['state']); if(after.connected===false){logoutVerified=true;connected=false;break;} }
        catch { connected=false; break; } // Runtime closed; server logout timing remains unverified.
        await Bun.sleep(250);
      }
    } catch {}
  }
  save(); release();
  if(memory.blocked)process.exitCode=2;
  console.log(JSON.stringify({ character, ...quest.summary(), connected, logoutRequested, logoutVerified }));
}
