import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localResultCurrent} from '../../src/team/local-diagnostics.ts';
import type {WorkerSnapshot} from '../../src/team/protocol.ts';
test('Ollama tolerates observation-only churn but never changes safety/progress/session boundaries',()=>{
  const s:WorkerSnapshot={version:1,agent:'clawscout',session:'s',workerRun:'w',at:1000,context:'c',fingerprint:'f',connected:true,
    pending:false,stalled:true,progressAt:null,candidates:[],planning:{version:1,clearance:'ready',unavailable:[]}};
  assert.equal(localResultCurrent(s,{...s,at:2000,fingerprint:'other'},'running','s',2000),true);
  for(const patch of [{workerRun:'other'},{session:'other'},{context:'other'},{progressAt:1500},{pending:true},{stalled:false}])
    assert.equal(localResultCurrent(s,{...s,at:2000,...patch},'running','s',2000),false);
});
