import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalRoundTracker} from '../../src/team/local-diagnostics.ts';
import type {WorkerSnapshot} from '../../src/team/protocol.ts';
test('local consultation cadence is independent of the paid-request throttle and waits for fresh rechecks',()=>{
  const s:WorkerSnapshot={version:1,agent:'clawscout',session:'s',at:1000,context:'c',fingerprint:'f',connected:true,pending:false,
    stalled:true,progressAt:null,candidates:[]};
  const rounds=new LocalRoundTracker();rounds.start(s,'e1',1000);rounds.finish(s,1,true,true,2000);
  assert.equal(rounds.gate({...s,at:61000},'e2',61000),'waiting-recheck');
  assert.equal(rounds.gate({...s,at:62000},'e2',62000),'call');
  assert.equal(rounds.gate({...s,at:62000,progressAt:62000},'e2',62000),'call');
});
