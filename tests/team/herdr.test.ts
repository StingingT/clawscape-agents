import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {openWorkspace,currentPanel,launchHerdrClient,overseerReloadSpec} from '../../src/team/herdr.ts';
import {readJson,controlDir,writeJson} from '../../src/team/storage.ts';
import {LOADED_RUNTIME} from '../../src/team/runtime.ts';
import {acquireTeamController} from '../../src/team/lease.ts';
function fixture(t:any){const r=mkdtempSync(join(tmpdir(),'herdr-protocol-'));t.after(()=>rmSync(r,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return r;}
function healthy(root:string,pane='panel') {
  writeJson(join(controlDir(root),'status.json'),{at:Date.now(),active:true,runtime:{...LOADED_RUNTIME,phase:'ready',pane}});
}
function mock(calls:string[][]){return async(args:string[])=>{calls.push(args);return JSON.stringify(args[0]==='workspace'&&args[1]==='create'
  ?{result:{workspace:{workspace_id:'owned'},root_pane:{pane_id:'panel'}}}
  :args[0]==='tab'?{result:{root_pane:{pane_id:'p'+calls.length}}}:{result:{}});};}
test('Herdr bootstrap creates six process panes; only a current live panel is reused',async t=>{
 const root=fixture(t),calls:string[][]=[],run=mock(calls);
 assert.equal(await openWorkspace(root,run),'owned');assert.equal(calls.filter(a=>a[0]==='tab').length,5);
 assert.equal(calls.filter(a=>a[0]==='pane'&&a[1]==='run').length,6);
 assert.ok(!calls.some(a=>a[0]==='agent'||a.some(v=>/codex|src\/agent.ts/.test(v))));
 assert.equal(readJson<any>(join(controlDir(root),'herdr-workspace.json')).complete,true);
 healthy(root);const before=calls.length;await openWorkspace(root,run);
 assert.deepEqual(calls.slice(before).map(c=>c.slice(0,2)),[['workspace','get'],['workspace','focus']]);
});
test('a stopped or older Overseer is focusable for an operator, but never restarted or injected into',async t=>{
 const root=fixture(t),calls:string[][]=[],run=mock(calls);await openWorkspace(root,run);
 const file=join(controlDir(root),'status.json');
 for(const status of [{at:Date.now(),active:false},
   {at:Date.now(),active:true,runtime:{...LOADED_RUNTIME,sourceHash:'old',phase:'ready',pane:'panel'}},
   {at:Date.now()-60_000,active:true,runtime:{...LOADED_RUNTIME,phase:'ready',pane:'panel'}},
   {at:Date.now(),active:true,runtime:{...LOADED_RUNTIME,phase:'ready',pane:'someone-elses-pane'}}]){
   writeJson(file,status);const before=calls.length;
   assert.equal(await openWorkspace(root,run),'owned');
   assert.deepEqual(calls.slice(before).map(c=>c.slice(0,2)),[['workspace','get'],['workspace','focus']]);
 }
});
test('an explicit fresh workspace never injects input into the old pane and preserves old records',async t=>{
 const root=fixture(t),file=join(controlDir(root),'herdr-workspace.json'),old={id:'old-workspace',root,complete:true};
 writeJson(file,old);const calls:string[][]=[];const result=await openWorkspace(root,mock(calls),{fresh:true});
 assert.equal(result,'owned');assert.ok(calls.every(c=>!c.includes('old-workspace')));
 assert.equal(JSON.parse(readFileSync(file,'utf8')).id,'owned');
});
test('fresh workspace refuses an active controller without mutating its lock or workspace',async t=>{
 const root=fixture(t),file=join(controlDir(root),'herdr-workspace.json'),lock=join(root,'data/supervisor/supervisor.lock');
 writeJson(file,{id:'old',root,complete:true});const release=acquireTeamController(lock);
 const oldLock=readFileSync(lock),oldWorkspace=readFileSync(file);let calls=0;
 try{await assert.rejects(()=>openWorkspace(root,async()=>{calls++;return '{}';},{fresh:true}),/already owns/);
 assert.equal(calls,0);assert.deepEqual(readFileSync(lock),oldLock);assert.deepEqual(readFileSync(file),oldWorkspace);}finally{release();}
});
test('partial or lost Herdr workspaces are not silently re-created or injected into',async t=>{
 const root=fixture(t),f=join(controlDir(root),'herdr-workspace.json');writeJson(f,{id:'owned',root,complete:false});
 let calls=0;await assert.rejects(()=>openWorkspace(root,async()=>{calls++;return '{}';}),/INCOMPLETE/);assert.equal(calls,0);
 writeJson(f,{id:'owned',root,complete:true});
 await assert.rejects(()=>openWorkspace(root,async()=>{calls++;throw new Error('unavailable');}),/UNAVAILABLE/);assert.equal(calls,1);
});
test('currentPanel rejects stale, future, stopped or mismatched runtime evidence',()=>{
 const base={at:1000,active:true,runtime:{...LOADED_RUNTIME,phase:'ready'}};
 assert.equal(currentPanel(base,1000),true);
 for(const s of [{...base,at:1001},{...base,at:-50_000},{...base,active:false},
   {...base,runtime:{...base.runtime,phase:'closed'}},{...base,runtime:{...base.runtime,version:'old'}}])assert.equal(currentPanel(s,1000),false);
});
test('client attachment uses inherited terminal IO and never treats a workspace id as a session',async()=>{
 const previous=process.env.HERDR_ENV;delete process.env.HERDR_ENV;
 try{let captured:any;const child=new EventEmitter();
   const spawn=((...args:any[])=>{captured=args;queueMicrotask(()=>child.emit('exit',0,null));return child;}) as any;
   await launchHerdrClient(process.cwd(),spawn);assert.deepEqual(captured[1],[]);assert.equal(captured[2].stdio,'inherit');
 }finally{if(previous===undefined)delete process.env.HERDR_ENV;else process.env.HERDR_ENV=previous;}
});
test('inside a Herdr pane no nested interactive client is launched',async()=>{
 const previous=process.env.HERDR_ENV;process.env.HERDR_ENV='1';
 try{await launchHerdrClient(process.cwd(),(()=>{throw new Error('nested launch');}) as any);}
 finally{if(previous===undefined)delete process.env.HERDR_ENV;else process.env.HERDR_ENV=previous;}
});
test('explicit Overseer reload starts the local UI source without a shell',()=>{
 const spec=overseerReloadSpec('C:/agents/clawscape','bun.exe');
 assert.deepEqual(spec,{file:'bun.exe',args:[join('C:/agents/clawscape','scripts/team.ts'),'ui'],cwd:'C:/agents/clawscape'});
});
