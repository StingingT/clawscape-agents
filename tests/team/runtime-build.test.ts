import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,copyFileSync,appendFileSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {installedRuntime,installedWorkerRuntime,LOADED_RUNTIME,RUNTIME_SOURCES,runtimeDiagnostic} from '../../src/team/runtime.ts';
import {TeamManager} from '../../src/team/manager.ts';
import {readJson} from '../../src/team/storage.ts';

test('disk updates cannot relabel an already loaded runtime as the new build',t=>{
 const root=mkdtempSync(join(tmpdir(),'team-build-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const original=fileURLToPath(new URL('../../',import.meta.url));
 for(const file of RUNTIME_SOURCES){
  const target=join(root,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(original,file),target);
 }
 assert.equal(installedRuntime(root).sourceHash,LOADED_RUNTIME.sourceHash);
 appendFileSync(join(root,'src/team/manager.ts'),'\n// simulated newer disk source\n');
 assert.notEqual(installedRuntime(root).sourceHash,LOADED_RUNTIME.sourceHash);
 assert.equal(installedRuntime(original).sourceHash,LOADED_RUNTIME.sourceHash);
});

test('worker build fingerprint changes when controller source changes after launch',t=>{
 const root=mkdtempSync(join(tmpdir(),'worker-build-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'src','agency'),{recursive:true});
 writeFileSync(join(root,'src','agent.ts'),'export const agent = 1;\n');
 writeFileSync(join(root,'src','agency','live-adapter.ts'),'export const live = 1;\n');
 const initial=installedWorkerRuntime(root,'clawscout');
 appendFileSync(join(root,'src','agency','live-adapter.ts'),'// changed after launch\n');
 assert.notEqual(installedWorkerRuntime(root,'clawscout').sourceHash,initial.sourceHash);
});

test('manager status exposes that a running worker needs a controlled restart after source changes',async t=>{
 const root=mkdtempSync(join(tmpdir(),'worker-restart-status-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'src'),{recursive:true});writeFileSync(join(root,'src','agent.ts'),'export const agent = 1;\n');
 const initial=installedWorkerRuntime(root,'clawscout'),manager=new TeamManager(root);t.after(()=>manager.close());
 (manager as any).processes.clawscout={status:'running',pid:123,sourceHash:initial.sourceHash,sourceFiles:initial.files};
 manager.save();
 assert.equal(readJson<any>(join(root,'data/team-control/status.json'))?.processes?.clawscout?.restartRequired,false);
 appendFileSync(join(root,'src','agent.ts'),'// new worker source\n');manager.save();
 const saved=readJson<any>(join(root,'data/team-control/status.json'))?.processes?.clawscout;
  assert.equal(saved?.restartRequired,true);assert.notEqual(saved?.sourceHash,saved?.currentSourceHash);
});

test('a stale manager reports its own restart requirement and refuses to mix new workers into the old control plane',async t=>{
 const root=mkdtempSync(join(tmpdir(),'manager-restart-status-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const file of RUNTIME_SOURCES){const target=join(root,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(fileURLToPath(new URL('../../',import.meta.url)),file),target);}
 mkdirSync(join(root,'src'),{recursive:true});writeFileSync(join(root,'src','agent.ts'),'export const agent = 1;\n');
 const manager=new TeamManager(root);t.after(()=>manager.close());
 appendFileSync(join(root,'src/team/manager.ts'),'// newer manager source\n');
 manager.save();
 const runtime=readJson<any>(join(root,'data/team-control/status.json'))?.runtime;
  assert.equal(runtime?.restartRequired,true);assert.notEqual(runtime?.sourceHash,runtime?.currentSourceHash);
  assert.throws(()=>manager.start('clawscout'),/OVERSEER_RESTART_REQUIRED/);
  await assert.rejects(()=>manager.restart('clawscout'),/OVERSEER_RESTART_REQUIRED/);
});

test('non-interactive diagnostics prescribe a controlled reload for a stale active manager',async t=>{
 const root=mkdtempSync(join(tmpdir(),'manager-diagnostic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const file of RUNTIME_SOURCES){const target=join(root,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(fileURLToPath(new URL('../../',import.meta.url)),file),target);}
 const manager=new TeamManager(root);t.after(()=>manager.close());appendFileSync(join(root,'src/team/manager.ts'),'// newer manager source\n');manager.save();
 const diagnostic=runtimeDiagnostic(root);
 assert.equal(diagnostic.sourceMatches,false);assert.match(diagnostic.nextAction,/reload, then start all/);
});
