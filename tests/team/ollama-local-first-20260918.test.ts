import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig} from '../../src/team/manager.ts';
import {LocalRoundTracker} from '../../src/team/local-diagnostics.ts';
import type {WorkerSnapshot} from '../../src/team/protocol.ts';
test('local-first preserves unconfigured lifecycle and never treats zero choices as completed local calls',()=>{
  assert.equal(defaultConfig().localModel,null);
  const s:WorkerSnapshot={version:1,agent:'clawscout',session:'s',at:1000,context:'c',fingerprint:'f',connected:true,pending:false,
    stalled:true,progressAt:null,candidates:[],planning:{version:1,clearance:'ready',unavailable:[]}};
  const rounds=new LocalRoundTracker();assert.equal(rounds.gate(s,'e',1000),'call');assert.equal(rounds.view(s),undefined);
  assert.equal(rounds.start(s,'e',1000),1);assert.equal(rounds.view(s)?.completed,0);
});
