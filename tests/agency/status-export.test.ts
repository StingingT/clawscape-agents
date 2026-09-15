import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectReport,exportReport,scrub} from '../../scripts/status-export.ts';
function root(t:any){const d=mkdtempSync(join(tmpdir(),'status-export-'));t.after(()=>rmSync(d,{recursive:true,force:true}));mkdirSync(join(d,'data/supervisor'),{recursive:true});return d;}
test('report includes five agents, available status and explicit missing-file warnings without touching the originals',t=>{
 const d=root(t);mkdirSync(join(d,'agents/advanced/data/astra-live'),{recursive:true});const status=JSON.stringify({time:'2026-09-15T00:00:00Z',status:'RUNNING',actions:13,verified:13,failed:0,observation:{connected:true,tick:1}});
 writeFileSync(join(d,'agents/advanced/data/astra-live/status.json'),status);
 const report=collectReport(d);assert.equal(report.agents.length,5);assert.equal(report.agents[4].status.actions,13);assert.ok(report.warnings.length);
 const out=exportReport(d);assert.ok(readFileSync(out,'utf8').includes('RUNNING'));assert.equal(readFileSync(join(d,'agents/advanced/data/astra-live/status.json'),'utf8'),status);
 assert.throws(()=>exportReport(d,join(d,'config.local.json')),/txt/);
});
test('export uses structured bounded log fields, omits credential files and strips sensitive strings',t=>{
 const d=root(t);writeFileSync(join(d,'data/supervisor/status.json'),'{}');
 writeFileSync(join(d,'config.local.json'),'DO_NOT_READ_CONFIGURATION');
 writeFileSync(join(d,'data/supervisor/stinger-1000.log'),JSON.stringify({agency:'reconciling',commandId:'abc',token:'TOP_SECRET',reason:'password=do-not-share'})+'\nopaque-secret-plain-line\n');
 const text=JSON.stringify(collectReport(d));assert.ok(!text.includes('TOP_SECRET'));assert.ok(!text.includes('do-not-share'));assert.ok(!text.includes('opaque-secret-plain-line'));assert.ok(!text.includes('DO_NOT_READ_CONFIGURATION'));assert.ok(text.includes('reconciling'));
 assert.equal(scrub('token=hidden',d),'[redacted]');assert.equal(scrub('https://host/path?key=hidden',d),'https://host/path');
});
test('a log symlink cannot pull arbitrary files into the report',t=>{
 const d=root(t),outside=join(d,'private.txt');writeFileSync(outside,'UNRELATED_PRIVATE_CONTENT');
 try{symlinkSync(outside,join(d,'data/supervisor/astra-10.log'));}catch{t.skip('Symlink permission unavailable');return;}
 assert.ok(!JSON.stringify(collectReport(d)).includes('UNRELATED_PRIVATE_CONTENT'));
});
