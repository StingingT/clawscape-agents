import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {plannerLearning,transitionInteractionUnavailable} from '../../src/agency/planner-learning.ts';

test('a confirmed transition executor gap is available to catalogue policy as a capability family',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'transition-gap-'));
  fs.mkdirSync(path.join(root,'data','team-control'),{recursive:true});
  fs.writeFileSync(path.join(root,'data','team-control','capability-gaps.json'),JSON.stringify({version:1,gaps:[
    {target:'discovery:observed-transition-interaction',agent:'clawscout',confirmations:2,suppressUntil:5000,status:'active'}
  ]}));
  const learning=plannerLearning(root,'clawscout',1000);
  assert(learning.exhausted.has('discovery:observed-transition-interaction'));
  assert.equal(transitionInteractionUnavailable(learning),true);
  assert.equal(learning.noveltyPressure,false);
});
