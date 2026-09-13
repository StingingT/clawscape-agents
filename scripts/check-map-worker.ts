import { strict as assert } from 'node:assert';
import { samples } from '../src/navigation/geometry';
const worker = new Worker(new URL('../src/navigation/map-worker.ts', import.meta.url).href);
const timer = setTimeout(() => { worker.terminate(); console.error('planner smoke test timed out'); process.exitCode = 1; }, 90_000);
worker.onerror = event => { console.error(event.message); clearTimeout(timer); worker.terminate(); process.exitCode = 1; };
worker.onmessage = ({ data }) => {
  try {
    if (data.ready) {
      worker.postMessage({ id: 1, from: { x: 3169, z: 3313, level: 0 }, to: { x: 3185, z: 3436, level: 0 } });
      return;
    }
    assert.equal(data.error, undefined);
    if (data.id === 1) {
      assert.deepEqual(data.legs.at(-1).target, { x: 3185, z: 3436, level: 0 });
      assert(data.legs[0].target.x < 3169, 'must detour west instead of walking north into fence');
      worker.postMessage({ id: 2, from: { x: 3014, z: 3224, level: 0 }, to: { x: 3094, z: 3226, level: 0 } });
      console.log('PASS: fence detour');
      return;
    }
    assert.deepEqual(data.legs.at(-1).target, data.id === 2 ? { x: 3094, z: 3226, level: 0 } : { x: 3100, z: 3257, level: 0 });
    let previous = data.id === 2 ? { x: 3014, z: 3224, level: 0 } : { x: 3087, z: 3227, level: 0 };
    for (const leg of data.legs) {
      for (const t of samples(previous, leg.target)) assert(!(t.x >= 3076 && t.x <= 3092 && t.z >= 3233 && t.z <= 3247), 'route enters wizard exclusion');
      previous = leg.target;
    }
    console.log(JSON.stringify({ passed: true, legs: data.legs.length, requiredDoors: data.legs.flatMap((l: any) => l.doors).map((d: any) => [d.x, d.z]), hash: data.hash }));
    if (data.id === 2) worker.postMessage({ id: 3, from: { x: 3087, z: 3227, level: 0 }, to: { x: 3100, z: 3257, level: 0 } });
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (!data.ready && data.id === 3) { clearTimeout(timer); worker.terminate(); } }
};
