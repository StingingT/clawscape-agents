import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FeasibilityEvidence} from '../../src/team/local-diagnostics.ts';
import type {WorkerSnapshot} from '../../src/team/protocol.ts';
test('only exact executor failures exclude a registered choice; an empty list remains diagnostic input',()=>{
  const s:WorkerSnapshot={version:1,agent:'clawscout',session:'s',at:1000,context:'c',fingerprint:'f',connected:true,pending:false,
    stalled:true,progressAt:null,candidates:[],blocked:'Selected task has no feasible current executor step: production-batch'};
  const e=new FeasibilityEvidence();e.observe(s,1000);
  const current={...s,at:2000,blocked:'No executable goals',candidates:[{id:'production-batch',domain:'crafting',source:'collection',reason:'Listed',
    target:{fact:'result',minimum:1},plan:{family:'production',registered:true,firstMethodId:'production-batch',capability:'production',steps:1,durationMs:1000,costGp:0,lossBoundGp:0}}]};
  assert.equal(e.snapshot(current,2000).candidates.length,0);assert.equal(e.frame(current,2000).mode,'capability-gap');
});
