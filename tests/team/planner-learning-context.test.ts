import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {plannerLearning} from '../../src/agency/planner-learning.ts';

test('a learned capability gap is reconsidered after a changed observed capability context',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'context-gap-'));
  fs.mkdirSync(path.join(root,'data','team-control'),{recursive:true});
  fs.writeFileSync(path.join(root,'data','team-control','capability-gaps.json'),JSON.stringify({version:1,gaps:[
    {target:'gathering-batch',agent:'clawscout',context:'no-pickaxe',confirmations:2,suppressUntil:5000,status:'active'}
  ]}));
  assert(plannerLearning(root,'clawscout',1000,'no-pickaxe').exhausted.has('gathering-batch'));
  assert.equal(plannerLearning(root,'clawscout',1000,'has-pickaxe').exhausted.has('gathering-batch'),false);
  assert(plannerLearning(root,'clawscout',1000).exhausted.has('gathering-batch'),'legacy callers retain conservative suppression');
});
