import { describe, expect, test } from 'bun:test';
import { advance, blockOrRetry, emptyLifecycle, learn, loadLifecycle, markPrerequisite, recordOutcome, resumable, saveLifecycle, setGoal } from './lifecycle';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const definition = { id:'mine-iron', title:'Mine iron safely', role:'economy', build:'production', why:'make sellable bars', steps:['get pickaxe','mine a full trip','bank ore'], prerequisites:[{id:'pickaxe',description:'usable pickaxe',status:'unknown' as const}], success:['ore banked'], partial:['some ore'], failure:['death'], limits:{maxRisk:2} };
describe('persistent goal lifecycle',()=>{
 test('runs set plan prepare execute review learn and changes future method',()=>{const l=emptyLifecycle();const g=setGoal(l,definition);expect(g.phase).toBe('set');advance(l,'plan');markPrerequisite(l,'pickaxe','ready','adamant pickaxe');advance(l,'prepare');advance(l,'execute');recordOutcome(l,{at:2,status:'partial',evidence:['12 ore banked']});learn(l,'mine route was safe','use-east-bank-route');expect(l.preferredMethods['mine-iron']).toBe('use-east-bank-route');expect(l.active?.phase).toBe('learn');});
 test('survives restart and preserves active goal',()=>{const dir=mkdtempSync(join(process.cwd(),'tmp-goal-'));try{const file=join(dir,'goal.json');const l=emptyLifecycle();setGoal(l,definition);advance(l,'execute');saveLifecycle(file,l);const loaded=loadLifecycle(file);expect(loaded.active?.id).toBe('mine-iron');expect(loaded.active?.phase).toBe('execute');}finally{rmSync(dir,{recursive:true,force:true});}});
 test('bounded blockers do not immediately discard goal',()=>{const l=emptyLifecycle();setGoal(l,definition,0);blockOrRetry(l,'rock unreachable',100);expect(l.active?.phase).toBe('prepare');blockOrRetry(l,'rock unreachable',200);expect(l.active?.phase).toBe('prepare');blockOrRetry(l,'rock unreachable',300);expect(l.active?.phase).toBe('blocked');expect(resumable(l,350)).toBeUndefined();expect(resumable(l,61_000)).toBe(l.active);});
});
