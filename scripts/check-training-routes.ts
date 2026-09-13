// Offline source + production planner probe. No CLI, login or gameplay actions.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalog, mapEntries } from '../src/training/catalog';
const catalog = loadCatalog();
assert.equal(catalog.sites.length, 7);
assert(catalog.monsters.every(m => !/minotaur|flesh crawler|drake|ankou/i.test(m.name)));
const upstream = resolve(import.meta.dir, '../../tmp/clawscape/upstream');
const locs = mapEntries(readFileSync(resolve(upstream, 'server/content/maps/m48_54.jm2'), 'utf8'), 'm48_54', 'LOC');
const pack = readFileSync(resolve(upstream, 'server/content/pack/loc.pack'), 'utf8');
const willowId = Number(/^(\d+)=willowtree$/m.exec(pack)![1]);
const willow = locs.find(l => l.id === willowId && l.x === 3111 && l.z === 3487)!;
assert(willow, 'source willow footprint');
const treeConfig = readFileSync(resolve(upstream, 'server/content/scripts/skill_woodcutting/configs/trees/willow.loc'), 'utf8');
const interaction = { ...willow, width: Number(/^width=(\d+)/m.exec(treeConfig)![1]), height: Number(/^length=(\d+)/m.exec(treeConfig)![1]) };
const worker = new Worker(new URL('../src/navigation/map-worker.ts', import.meta.url).href);
let seq = 0;
const pending = new Map<number, (data: any) => void>();
let ready: () => void;
const loaded = new Promise<void>(r => { ready = r; });
worker.onmessage = ({ data }) => data.ready ? ready() : pending.get(data.id)?.(data);
const timer = setTimeout(() => { worker.terminate(); console.error('FAIL: offline probe timeout'); process.exit(1); }, 120_000);
async function probe(name: string, from: any, to: any, expectedError: boolean | 'alternative' = false, extra = {}) {
  const id = ++seq;
  const result: any = await new Promise(r => { pending.set(id, r); worker.postMessage({ id, from, to, ...extra }); });
  pending.delete(id);
  if (expectedError === true) assert.match(result.error ?? '', /partial-path/);
  else if (!expectedError) { assert.equal(result.error, undefined, name); assert.deepEqual(result.legs.at(-1)?.target ?? from, to); }
  console.log(JSON.stringify({ name, endpoint: result.legs?.at(-1)?.target, legs: result.legs?.length, error: result.error, unmappedTiles: result.unmappedTiles, interactionValid: result.interactionValid, doors: result.legs?.flatMap((l: any) => l.doors.map((d: any) => [d.x, d.z])), hash: result.hash, liveVerified: false }));
  return result;
}
try {
  await loaded;
  const bank = { x: 3185, z: 3436, level: 0 };
  await probe('old willow footprint rejected', bank, { x: 3112, z: 3487, level: 0 }, true);
  const approach = { x: 3113, z: 3487, level: 0 };
  const fixed = await probe('willow exact interaction approach', bank, approach, false, { interaction });
  assert.equal(fixed.interactionValid, true);
  await probe('willow return to Edgeville bank', approach, { x: 3094, z: 3491, level: 0 });
  const oakLocs = mapEntries(readFileSync(resolve(upstream, 'server/content/maps/m49_53.jm2'), 'utf8'), 'm49_53', 'LOC');
  const oak = oakLocs.find(l => l.x === 3167 && l.z === 3420 && l.id === Number(/^(\d+)=oaktree$/m.exec(pack)![1]))!;
  assert(oak);
  const oakResult = await probe('fallback Varrock oak interaction', bank, { x: 3170, z: 3420, level: 0 }, false, { interaction: { ...oak, width: 3, height: 3 } });
  assert.equal(oakResult.interactionValid, true);
  const yew = locs.find(l => l.x === 3085 && l.z === 3480 && l.id === Number(/^(\d+)=yewtree$/m.exec(pack)![1]))!;
  assert(yew);
  const yewResult = await probe('yew exact interaction approach', bank, { x: 3088, z: 3480, level: 0 }, false, { interaction: { ...yew, width: 3, height: 3 } });
  assert.equal(yewResult.interactionValid, true);
  const blockedSide = await probe('adjacent yew tile across wall is NOT interaction success', bank, { x: 3084, z: 3480, level: 0 }, false, { interaction: { ...yew, width: 3, height: 3 } });
  assert.equal(blockedSide.interactionValid, false);
  const exit = await probe('chicken enclosure retreat through gate', { x: 3232, z: 3295, level: 0 }, { x: 3238, z: 3295, level: 0 });
  assert(exit.legs.some((l: any) => l.doors.length > 0), 'retreat must inspect the enclosure gate');
  await probe('continued retreat beyond chicken leash', { x: 3238, z: 3295, level: 0 }, { x: 3238, z: 3275, level: 0 });
  await probe('income route to observed Lumbridge road', { x: 3238, z: 3275, level: 0 }, { x: 3232, z: 3230, level: 0 });
  await probe('nearby Varrock general shop for production sales', bank, {x:3218,z:3415,level:0});
  for (const site of catalog.sites) {
    const points = [...site.points].sort((a,b)=>Math.max(Math.abs(a.x-bank.x),Math.abs(a.z-bank.z))-Math.max(Math.abs(b.x-bank.x),Math.abs(b.z-bank.z))).slice(0,3);
    let usable = false;
    for (const point of points) {
      const result = await probe(site.id, bank, point, 'alternative');
      if (result.error) { assert.match(result.error, /partial-path/); continue; }
      assert.deepEqual(result.legs.at(-1)?.target ?? bank, point);
      assert.equal(result.unmappedTiles, 0, 'catalog routes must use measured collision zones'); usable = true; break;
    }
    assert(usable, `${site.id} needs at least one exact source-spawn route in the bounded approach shortlist`);
  }
  console.log(`PASS: source compatibility (${catalog.monsters.length} monster types, ${catalog.sites.length} sites), exact route endpoints and willow interaction. No live actions.`);
} finally { clearTimeout(timer); worker.terminate(); }
