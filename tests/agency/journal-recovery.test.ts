import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { durableRecoveryEvidence, recoverLegacyJournals } from '../../src/agency/journal-recovery.ts';
import { runtimeHome, runWithStartupStatus, startupFailure, checkedUpstream } from '../../agents/advanced/src/startup.ts';

const identity={agent:'astra',world:'test-world'};
const state=()=>({character:'astra',world:'test-world',profileId:'test',inGame:true,tick:1,
  player:{lifeId:1,hp:30,maxHp:30,level:0,worldX:10,worldZ:10,combat:{inCombat:false}},equipment:[],skills:[],
  inventory:[{id:995,name:'Coins',count:50,slot:0}],bank:{isOpen:true,items:[{id:315,name:'Shrimps',count:5,slot:7}]}});
const planner=()=>({schema:1,...identity,pending:{commandId:'old-synthetic',method:{effects:{'goal:food':1},prerequisites:[]}},active:{target:{fact:'goal:food'}}});
const action=(s:any,patch:any={})=>({commandId:'old-executor',type:'bankWithdraw',actionId:'withdraw-food',status:'pending',fields:{slot:7,amount:1},beforeState:s,...patch});
function directory(run:(dir:string)=>void){const dir=mkdtempSync(join(tmpdir(),'legacy-test-'));try{run(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
const put=(dir:string,name:string,value:any)=>writeFileSync(join(dir,name),JSON.stringify(value,null,2)+'\n');

test('a wait may be retired without claiming a game effect and without editing the original',()=>directory(dir=>{
  put(dir,'action-intent.json',action(state(),{type:'wait'}));put(dir,'agency-memory.json',planner());
  const original=readFileSync(join(dir,'action-intent.json'),'utf8');
  const r=recoverLegacyJournals(dir,identity,{apply:true});
  assert.equal(r.ready,true);assert.equal(r.entries[0]?.disposition,'accounted');
  assert.match(r.entries[0]!.reason,/no success/);assert.equal(readFileSync(join(dir,'action-intent.json'),'utf8'),original);
  assert.equal(readdirSync(join(dir,'journal-backups')).length,2);
}));
test('unknown purchase plus synthetic planner record remains unresolved',()=>directory(dir=>{
  const b=state();put(dir,'action-intent.json',action(b,{type:'shopBuy',fields:{slot:2,amount:1}}));put(dir,'agency-memory.json',planner());
  const a={...b,tick:2},c={...b,tick:3};const r=recoverLegacyJournals(dir,identity,{state:a,stable:c,apply:true});
  assert.equal(r.ready,false);assert.ok(r.entries.every(e=>e.disposition==='unresolved'));assert.equal(existsSync(join(dir,'journal-backups')),false);
}));
test('exact stable bank effect resolves across a local client restart and unblocks the obsolete duplicate',()=>directory(dir=>{
  const b=state(),a=structuredClone(b);a.tick=2;a.inventory.push({id:315,name:'Shrimps',count:1,slot:1});a.bank.items[0]!.count=4;
  const c={...structuredClone(a),tick:3};put(dir,'action-intent.json',action(b));put(dir,'agency-memory.json',planner());
  const r=recoverLegacyJournals(dir,identity,{state:a,stable:c,apply:true});assert.equal(r.ready,true);
  assert.match(r.entries[1]!.reason,/not declared successful/);
}));
test('unchanged balances are not proof that a transfer failed',()=>directory(dir=>{
  const b=state();put(dir,'action-intent.json',action(b));
  const r=recoverLegacyJournals(dir,identity,{state:{...b,tick:2},stable:{...b,tick:3},apply:true});
  assert.equal(r.ready,false);assert.equal(JSON.parse(readFileSync(join(dir,'action-intent.json'),'utf8')).status,'pending');
}));
test('an old failed/quarantined mutation is not treated as a confirmed server rejection',()=>directory(dir=>{
  put(dir,'action-intent.json',action(state(),{status:'failed',failure:'old restart quarantine'}));
  assert.equal(recoverLegacyJournals(dir,identity,{apply:true}).ready,false);
}));
test('synthetic planner record cannot substitute for a missing executor journal',()=>directory(dir=>{
  put(dir,'agency-memory.json',planner());assert.equal(recoverLegacyJournals(dir,identity,{executorSettled:true,apply:true}).ready,false);
}));
test('a settled real executor allows archival of the known synthetic format without inventing a result',()=>directory(dir=>{
  put(dir,'agency-memory.json',planner());const r=recoverLegacyJournals(dir,identity,{executorSettled:true,executorHasHistory:true,apply:true});
  assert.equal(r.ready,true);assert.equal(JSON.parse(readFileSync(join(dir,'agency-memory.json'),'utf8')).pending.commandId,'old-synthetic');
}));
test('recovery is idempotent by file hash but changed files are inspected again',()=>directory(dir=>{
  put(dir,'action-intent.json',action(state(),{type:'wait'}));assert.equal(recoverLegacyJournals(dir,identity,{apply:true}).ready,true);
  assert.equal(recoverLegacyJournals(dir,identity,{apply:true}).ready,true);assert.equal(readdirSync(join(dir,'journal-backups')).length,1);
  put(dir,'action-intent.json',action(state(),{commandId:'new-unknown'}));assert.equal(recoverLegacyJournals(dir,identity,{apply:true}).ready,false);
}));
test('corrupt and wrong-identity journals are never replaced with empty memory',()=>directory(dir=>{
  writeFileSync(join(dir,'agency-memory.json'),'{invalid');assert.throws(()=>recoverLegacyJournals(dir,identity,{apply:true}),/CORRUPT/);
  put(dir,'agency-memory.json',{...planner(),agent:'stinger'});assert.throws(()=>recoverLegacyJournals(dir,identity,{apply:true}),/AGENT_MISMATCH/);
}));
test('unrecognized legacy intent format is not automatically retired',()=>directory(dir=>{
  const p=planner();p.pending.method.effects={'real-item':1} as any;put(dir,'agency-memory.json',p);
  assert.throws(()=>recoverLegacyJournals(dir,identity,{executorSettled:true,executorHasHistory:true,apply:true}),/UNRECOGNIZED/);
}));
test('stable durable reconciliation rejects other lives, actors, mutations and clock resets',()=>{
  const b=state(),a=structuredClone(b);a.tick=2;a.inventory.push({id:315,name:'Shrimps',count:1,slot:1});a.bank.items[0]!.count=4;
  const c={...structuredClone(a),tick:3};assert.ok(durableRecoveryEvidence(b,a,action(b),c).length);
  for(const patch of [{character:'other'},{world:'other'},{tick:0},{player:{...a.player,lifeId:2}}])
    assert.deepEqual(durableRecoveryEvidence(b,{...a,...patch},action(b),c),[]);
  a.inventory.push({id:100,name:'Unrelated',count:1,slot:2});c.inventory=structuredClone(a.inventory);
  assert.deepEqual(durableRecoveryEvidence(b,a,action(b),c),[]);
});
test('old NPC/dialogue identities are not reconstructed from coincidental current events',()=>{
  const b=state(),a={...state(),tick:2},c={...state(),tick:3};
  for(const type of ['interactNpc','clickDialogOption','talkToNpc','pickupItem'])assert.deepEqual(durableRecoveryEvidence(b,a,{type},c),[]);
});
test('read-only inspection neither archives nor creates a receipt',()=>directory(dir=>{
  put(dir,'action-intent.json',action(state(),{type:'wait'}));recoverLegacyJournals(dir,identity);
  assert.equal(existsSync(join(dir,'legacy-recovery.json')),false);assert.equal(existsSync(join(dir,'journal-backups')),false);
}));
test('legacy runtime home is selected as a whole without copying journals or credentials',()=>directory(dir=>{
  const code=join(dir,'agents-repo/agents/advanced'),old=join(dir,'clawscape-autonomous-agent');mkdirSync(code,{recursive:true});mkdirSync(old,{recursive:true});
  put(old,'config.local.json',{});assert.equal(runtimeHome(code,[],{}),old);
  put(code,'config.local.json',{});assert.throws(()=>runtimeHome(code,[],{}),/AMBIGUOUS/);
  assert.equal(runtimeHome(code,[],{CLAWSCAPE_ASTRA_HOME:old}),old);
}));
test('durable state in both layouts requires an explicit home',()=>directory(dir=>{
  const code=join(dir,'repo/agents/advanced'),old=join(dir,'clawscape-autonomous-agent');mkdirSync(join(code,'data/astra-live'),{recursive:true});mkdirSync(old,{recursive:true});
  put(old,'config.local.json',{});put(join(code,'data/astra-live'),'agency-memory.json',planner());
  assert.throws(()=>runtimeHome(code,[],{}),/AMBIGUOUS/);
}));
test('runtime option without a value and missing collision assets produce actionable failures',()=>directory(dir=>{
  assert.throws(()=>runtimeHome(dir,['--runtime-root'],{}),/ARGUMENT_REQUIRED/);
  assert.throws(()=>checkedUpstream(dir,'missing','also-missing'),/COLLISION_FILES_MISSING/);
}));
test('error classification does not include secret-bearing exception text',()=>{
  const result=startupFailure(new Error('remote replied token=TEST_SECRET'));assert.equal(JSON.stringify(result).includes('TEST_SECRET'),false);
  assert.equal(startupFailure(new Error('CONFIG_FILE_MISSING')).retryable,false);
});
test('bootstrap persists status even when importing the main runtime fails',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'bootstrap-test-'));const exit=process.exitCode ?? 0; // Bun needs an explicit numeric restoration after an expected startup failure.
  try {
    await runWithStartupStatus(dir,['run','--runtime-root',dir],async()=>{throw Object.assign(new Error('Cannot find package zod TOKEN_SHOULD_NOT_APPEAR'),{code:'ERR_MODULE_NOT_FOUND'});});
    assert.equal(process.exitCode,2); // Production must still report the expected startup failure.
    const text=readFileSync(join(dir,'data/astra-live/status.json'),'utf8'),s=JSON.parse(text);
    assert.equal(s.status,'STARTUP_FAILED');assert.equal(s.reason,'RUNTIME_DEPENDENCY_MISSING');assert.equal(s.pid,process.pid);
    assert.equal(text.includes('TOKEN_SHOULD_NOT_APPEAR'),false);assert.equal(existsSync(join(dir,'data/astra-launcher-status.json')),true);
  } finally {process.exitCode=exit;rmSync(dir,{recursive:true,force:true});}
});
