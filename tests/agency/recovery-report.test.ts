import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectReport} from '../../scripts/status-export.ts';

test('bounded historical recovery diagnostics expose cooldowns but never archived full snapshots',t=>{
  const root=mkdtempSync(join(tmpdir(),'recovery-report-'));
  t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const hidden='full-snapshot-content-must-not-be-exported';
  for(const dir of ['data/online','agents/advanced/data/astra-live']){
    mkdirSync(join(root,dir),{recursive:true});
    const doc={version:2,memory:{},discoveryRetryAt:70_000,
      receipt:{commandId:'current',action:{type:'interactLoc'},historical:{loss:'observed-tick-origin-reset',since:1000,at:31_000,tick:7,samples:7,observer:hidden,fingerprint:hidden}},
      transactionQuarantine:Array.from({length:12},(_,at)=>({at,commandId:'q'+at,reason:'historical context ended',evidence:['new current observations'],originalReceipt:{before:hidden},arbitrary:hidden})),
      historicalRetirements:[{at:30_000,commandId:'past',reason:'ended timeline',evidence:['no success inferred'],lossAttribution:'unknown',receipt:{before:hidden}}]};
    writeFileSync(join(root,dir,'agency-v2.json'),JSON.stringify(doc));
  }
  const path=join(root,'data/online/agency-v2.json'),before=readFileSync(path);
  const report=collectReport(root,40_000);
  for(const name of ['clawscout','astra']){
    const a=report.agents.find((v:any)=>v.agent===name);
    assert.equal(a.discoveryRetryAt,70_000);assert.equal(a.transactionQuarantine.length,8);
    assert.equal(a.transactionQuarantine[0].commandId,'q4');
    assert.equal(a.historicalRetirements[0].lossAttribution,'unknown');
    assert.equal(a.pending.historicalWindow.samples,7);
    assert.equal(a.pending.historicalWindow.observer,undefined);
  }
  assert.equal(JSON.stringify(report).includes(hidden),false);
  assert.deepEqual(readFileSync(path),before);
});
