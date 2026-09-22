import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {TeamManager} from '../../src/team/manager.ts';
import {PanelLifecycle} from '../../src/team/panel-lifecycle.ts';
import {controlDir,readJson} from '../../src/team/storage.ts';
import {LOADED_RUNTIME} from '../../src/team/runtime.ts';
function fixture(t:any){const r=mkdtempSync(join(tmpdir(),'team-live-regression-'));t.after(()=>rmSync(r,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return r;}
function fakeWorker(root:string){
 const s=`const fs=require('node:fs'),p=require('node:path');const dir=p.join(process.env.CLAWSCAPE_TEAM_ROOT,'data/team-control');
 const tick=()=>{const s=JSON.parse(fs.readFileSync(p.join(dir,'session.json'),'utf8'));const mode=s.modes.clawscout;
 fs.writeFileSync(p.join(dir,'clawscout-fixture.json'),JSON.stringify({pid:process.pid,mode,session:s.id}));
 if(!s.active||mode==='stopped')process.exit(0);};tick();setInterval(tick,30);`;
 mkdirSync(join(root,'src'),{recursive:true});writeFileSync(join(root,'src/agent.ts'),s);writeFileSync(join(root,'run'),s);
}
async function until(fn:()=>boolean){const end=Date.now()+6000;while(!fn()){if(Date.now()>end)throw new Error('fixture timeout');await new Promise(r=>setTimeout(r,20));}}
test('actual process restart: closed manager rejects starts; new process starts a real isolated worker',t=>{
 const root=fixture(t);fakeWorker(root);
 const managerURL=new URL('../../src/team/manager.ts',import.meta.url).href;
 const script=join(root,'lifecycle.fixture.mts');
 writeFileSync(script,`import {TeamManager} from ${JSON.stringify(managerURL)};
 import assert from 'node:assert/strict';import {readFileSync,existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
 const root=process.argv[2];const m=new TeamManager(root);const f=join(root,'data/team-control/clawscout-fixture.json');
 try{m.start('clawscout');const end=Date.now()+6000;while(!existsSync(f)||JSON.parse(readFileSync(f,'utf8')).session!==m.session.id){if(Date.now()>end)throw new Error('worker startup timeout');await new Promise(r=>setTimeout(r,20));}
 const worker=JSON.parse(readFileSync(f,'utf8'));assert.equal(worker.mode,'running');assert.ok(worker.pid>0);
 await m.close('operator-stop-all');assert.equal(m.children.size,0);assert.throws(()=>m.start('clawscout'),/TEAM_STOPPING/);
 writeFileSync(join(root,process.argv[3]),JSON.stringify({pid:process.pid,session:m.session.id,worker:worker.pid,mode:worker.mode}));
 }finally{await m.close();}`);
 const env={...process.env};delete env.HERDR_PANE_ID;delete env.HERDR_ENV;
 for(const out of ['first.json','second.json']){
   const args=[...(process.versions.bun?[]:['--experimental-strip-types']),script,root,out];
   const result=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:15000});
   assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
 }
 const first=JSON.parse(readFileSync(join(root,'first.json'),'utf8')),second=JSON.parse(readFileSync(join(root,'second.json'),'utf8'));
 assert.notEqual(first.session,second.session);assert.notEqual(first.pid,second.pid);assert.equal(second.mode,'running');
});
test('monitor errors are diagnosed, withhold new starts, and recover without closing the manager',async t=>{
 const root=fixture(t);fakeWorker(root);const m=new TeamManager(root);t.after(()=>m.close());
 const save=m.save.bind(m);m.save=()=>{throw Object.assign(new Error('SECRET must not be written'),{code:'EBUSY'});};
 (m as any).monitorOnce();assert.equal(m.isClosing(),false);assert.equal(m.lifecycle().phase,'monitor-fault');
 assert.throws(()=>m.start('clawscout'),/TEAM_MONITOR_FAULT/);assert.equal(m.children.size,0);
 m.save=save;(m as any).monitorOnce();assert.equal(m.lifecycle().phase,'ready');
 m.start('clawscout');await until(()=>readJson<any>(join(controlDir(root),'clawscout-fixture.json'))?.mode==='running');
 await m.close('operator-stop-all');
 const trace=readFileSync(join(controlDir(root),'diagnostics',m.session.id+'.json'),'utf8');
 assert.ok(trace.includes('EBUSY'));assert.ok(trace.includes('monitor-recovered'));assert.ok(!trace.includes('SECRET'));
 const rows=JSON.parse(trace).records;assert.ok(rows.find((r:any)=>r.event==='close-begin').stack.length>0);
 assert.ok(rows.every((r:any)=>r.version===LOADED_RUNTIME.version));
});
test('shutdown persistence failure cannot skip worker cleanup or reopen the same instance',async t=>{
 const root=fixture(t);fakeWorker(root);const m=new TeamManager(root);t.after(()=>m.close().catch(()=>{}));
 m.start('clawscout');await until(()=>!!readJson(join(controlDir(root),'clawscout-fixture.json')));
 m.save=()=>{throw Object.assign(new Error('simulated disk write'),{code:'EACCES'});};
 await assert.rejects(()=>m.close('operator-stop-all'),/simulated disk/);
 assert.equal(m.children.size,0);assert.throws(()=>m.start('clawscout'),/TEAM_STOPPING/);
 const next=new TeamManager(root);await next.close();
});
test('a real readline EOF shuts down once; queued starts cannot outlive the panel',async()=>{
 const input=new PassThrough(),output=new PassThrough();const rl=createInterface({input,output,terminal:false});
 let closes=0,releases=0,started=0;const reasons:string[]=[];
 const p=new PanelLifecycle({close:async(reason)=>{closes++;reasons.push(reason!);}},()=>rl.close(),async()=>{releases++;});
 const done=new Promise<void>(resolve=>rl.once('close',()=>{void p.shutdown('input-closed').then(resolve);}));
 rl.on('line',line=>{if(p.accepting&&line==='start')started++;});
 input.write('start\n');assert.equal(started,1);input.end();await done;
 rl.emit('line','start');assert.equal(started,1);assert.equal(closes,1);assert.equal(releases,1);assert.deepEqual(reasons,['input-closed']);
});
test('terminal client detachment without closing pane input does not stop its manager',async()=>{
 const input=new PassThrough(),output=new PassThrough();const rl=createInterface({input,output,terminal:false});let closes=0;
 const p=new PanelLifecycle({close:async()=>{closes++;}},()=>rl.close(),async()=>{});
 rl.on('close',()=>void p.shutdown('input-closed'));
 await new Promise(r=>setTimeout(r,30));assert.equal(p.accepting,true);assert.equal(closes,0);
 await p.shutdown('operator-stop-all');assert.equal(closes,1);assert.equal(p.accepting,false);
});
test('reentrant stop/EOF/signal requests share one irreversible cleanup operation',async()=>{
 let calls=0,releases=0;let p:PanelLifecycle;
 p=new PanelLifecycle({close:async()=>{calls++;}},()=>{void p.shutdown('input-closed');},async()=>{releases++;});
 const a=p.shutdown('operator-stop-all'),b=p.shutdown('sigterm');assert.equal(a,b);assert.equal(p.accepting,false);
 await Promise.all([a,b]);assert.equal(calls,1);assert.equal(releases,1);
});
