import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { ActionArbiter } from '../src/arbiter.ts';
import { reconcileAstraJournals } from '../src/restart-journals.ts';
import type { ActionCommand, ActionResult, Observation } from '../src/contracts.ts';

function observation(tick=10):Observation {
  return {schema_version:'1.0',character:'astra',world:'test-world',world_epoch:'epoch1',session_id:'new-local-client',profile_id:'test',seq:tick,tick,
    observed_at:Date.now(),fresh_at:Date.now(),provenance:'cli-player-observation',connected:true,position:{x:10,z:10,plane:0},hp:30,max_hp:30,life_id:1,respawns:0,
    skills:[],capacity:28,inventory:[],equipment:[],bank:{open:true,items:[{slot:7,id:315,name:'Shrimps',count:5,protected:false,options:[]}]},
    shop_open:false,dialog:{open:false,waiting:false,text:'',options:[]},feedback:[],danger:{active:false,damage_margin:2},unavailable:[],entities:[],
    activity:{animation:-1,target_index:-1,target_type:'none',last_damage_tick:-1,modal_open:false,modal_id:-1,style:0,styles:[],design_open:false,events:[]}};
}
function command(lease:string):ActionCommand {
  return {schema_version:'1.0',action_id:'old-command',character:'astra',world:'test-world',world_epoch:'epoch1',session_id:'old-local-client',profile_id:'test',
    lease,plan_id:'food',based_on_snapshot:1,expires_at:Date.now()+10_000,intent:{operation:'withdraw',slot:7,item_id:315,amount:1}};
}
const result=(status:ActionResult['status']='RUNNING',reason='OUTCOME_UNKNOWN'):ActionResult=>({schema_version:'1.0',action_id:'old-command',status,reason,at:Date.now(),evidence:[]});
async function journal(run:(store:Store,dir:string,lease:string)=>void|Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'astra-recovery-'));const store=new Store(join(dir,'journal.sqlite'));
  try {const lease=store.acquireRecovery('test-recovery',Date.now());await run(store,dir,lease);}
  finally {store.close();rmSync(dir,{recursive:true,force:true});}
}
function seed(store:Store,lease:string,status:ActionResult['status']='RUNNING',reason='OUTCOME_UNKNOWN') {
  store.createAction(command(lease),result(status,reason));const before=observation(1);before.session_id='old-local-client';
  store.append('action_checkpoints','old-command',{action_id:'old-command',before});return before;
}
function transfer(){const a=observation(10);a.inventory=[{slot:0,id:315,name:'Shrimps',count:1,protected:false,options:[]}];a.bank.items![0]!.count=4;
  const b=structuredClone(a);b.tick=11;b.seq=11;return [a,b] as const;}

test('recovery lease accepts an old queued journal but cannot authorize dispatch',()=>journal(async(store,dir,lease)=>{
  seed(store,lease,'QUEUED','VALIDATED');let dispatched=0;const o=observation();
  const arbiter=new ActionArbiter(store,{snapshot:async()=>o,dispatch:async()=>{dispatched++;return {success:true,phase:'test'};}},
    {maxStaleMs:5000,maxDeaths:1,keepIds:[],allowedTiles:new Set(),safeEntities:new Set()});
  const c={...command(lease),action_id:'new-command',session_id:o.session_id,based_on_snapshot:o.seq};
  const denied=await arbiter.submit(c);expect(denied.status).not.toBe('SUCCEEDED');expect(dispatched).toBe(0);
  const report=reconcileAstraJournals(store,dir,o,observation(11));expect(report.ready).toBe(true);
  expect(store.action('old-command')!.result.reason).toBe('RESTART_BEFORE_DISPATCH');store.promoteRecovery(lease,Date.now());expect(store.control().mode).toBe('RUNNING');
}));
test('a completed transfer is recovered across local client UUIDs using stable exact balances',()=>journal((store,dir,lease)=>{
  seed(store,lease);const [a,b]=transfer();const r=reconcileAstraJournals(store,dir,a,b);
  expect(r.ready).toBe(true);expect(store.action('old-command')!.result.status).toBe('SUCCEEDED');expect(store.pending()).toHaveLength(0);
}));
test('an unknown transfer remains pending and promotion is denied',()=>journal((store,dir,lease)=>{
  seed(store,lease);const r=reconcileAstraJournals(store,dir,observation(10),observation(11));
  expect(r.ready).toBe(false);expect(store.action('old-command')!.result.status).toBe('RUNNING');expect(()=>store.promoteRecovery(lease,Date.now())).toThrow('RECONCILE');
}));
test('post-dispatch failure and preemption cannot be treated as no-dispatch cancellations',async()=>{
  for(const [status,reason] of [['FAILED','CLIENT_REJECTED'],['CANCELLED','PREEMPTED_FOR_FOOD_EFFECT_MAY_STILL_COMPLETE']] as const)
    await journal((store,dir,lease)=>{seed(store,lease,status,reason);const r=reconcileAstraJournals(store,dir,observation(10),observation(11));
      expect(r.ready).toBe(false);expect(()=>store.promoteRecovery(lease,Date.now())).toThrow('RECONCILE');});
});
test('already recorded success clears obsolete synthetic bookkeeping without changing its original file',()=>journal((store,dir,lease)=>{
  seed(store,lease);store.result({...result('SUCCEEDED','OBSERVED_EFFECT'),evidence:['matching transfer effect']});
  const old={schema:1,agent:'astra',world:'test',pending:{commandId:'different-old-planner-id',method:{effects:{'goal:food':1},prerequisites:[]}},active:{target:{fact:'goal:food'}}};
  const original=JSON.stringify(old);writeFileSync(join(dir,'agency-memory.json'),original);
  const r=reconcileAstraJournals(store,dir,observation(10),observation(11));expect(r.ready).toBe(true);
  expect(readFileSync(join(dir,'agency-memory.json'),'utf8')).toBe(original);
  expect(JSON.parse(readFileSync(join(dir,'legacy-recovery.json'),'utf8')).entries[0].disposition).toBe('accounted');
}));
test('a server epoch or life change never becomes a recovered transfer',async()=>{
  for(const patch of [{world_epoch:'different-epoch'},{life_id:2},{respawns:1}])await journal((store,dir,lease)=>{
    seed(store,lease);const [a,b]=transfer();Object.assign(a,patch);Object.assign(b,patch);
    expect(reconcileAstraJournals(store,dir,a,b).ready).toBe(false);
  });
});
test('reconciliation rejects a foreign character command',()=>journal((store,dir,lease)=>{
  store.createAction({...command(lease),character:'stinger'},result());
  expect(()=>reconcileAstraJournals(store,dir,observation(10),observation(11))).toThrow('IDENTITY_MISMATCH');
  expect(store.action('old-command')!.result.status).toBe('RUNNING');
}));
test('manual takeover and active owners cannot be bypassed by recovery',()=>journal((store,_dir,lease)=>{
  expect(()=>store.acquireRecovery('second',Date.now())).toThrow('CONTROL_OWNED');
  store.setControl('MANUAL');expect(()=>store.acquireRecovery('second',Date.now())).toThrow('MANUAL');
  expect(()=>store.promoteRecovery(lease,Date.now())).toThrow('CONTROL_REVOKED');
}));
test('recovery result can be rerun without duplicating action outcomes',()=>journal((store,dir,lease)=>{
  seed(store,lease);const [a,b]=transfer();reconcileAstraJournals(store,dir,a,b);const n=store.records('actions').length;
  reconcileAstraJournals(store,dir,a,b);expect(store.records('actions').length).toBe(n);
}));

async function movementWindow(run:(store:Store,dir:string,lease:string,clock:{advance:()=>void;now:()=>number},snapshot:()=>Observation)=>void|Promise<void>){
  await journal(async(store,dir,lease)=>{
    const real=Date.now;let now=real(),seq=10;Date.now=()=>now;
    try{
      const clock={now:()=>now,advance:()=>{now+=1000;store.renew(lease,now);seq+=2;}};
      const snapshot=()=>{const o=observation(seq++);o.bank={open:false,items:null};return o;};
      await run(store,dir,lease,clock,snapshot);
    }finally{Date.now=real;}
  });
}
function seedMove(store:Store,lease:string){
  const before=observation(1);before.session_id='old-local-client';before.bank={open:false,items:null};
  const c={...command(lease),intent:{operation:'move' as const,destination:{x:90,z:90,plane:0}}};
  store.createAction(c,result());store.append('action_checkpoints',c.action_id,{action_id:c.action_id,before});return c;
}
test('startup old movement settles after measured fresh quiet observations with an immutable interruption receipt',()=>movementWindow((store,dir,lease,clock,snapshot)=>{
  const c=seedMove(store,lease);let report=reconcileAstraJournals(store,dir,snapshot(),snapshot());
  expect(report.ready).toBe(false);expect(report.unresolved[0]!.settling).toBe(true);
  for(let n=0;n<30;n++){clock.advance();report=reconcileAstraJournals(store,dir,snapshot(),snapshot());}
  expect(report.ready).toBe(true);expect(store.action(c.action_id)!.result.status).toBe('CANCELLED');
  expect(store.action(c.action_id)!.result.reason).toBe('RECONCILED_TRANSIENT_INTERRUPTED');
  expect(store.records<any>('transient_reconciliation')[0].original.command).toEqual(c);
  expect(store.records<any>('transient_reconciliation')[0].original.result.status).toBe('RUNNING');
  const count=store.records('actions').length;reconcileAstraJournals(store,dir,snapshot(),snapshot());expect(store.records('actions').length).toBe(count);
  store.promoteRecovery(lease,clock.now());expect(store.control().mode).toBe('RUNNING');
}));
test('live arbiter uses the same movement settlement without dispatching an old packet',()=>movementWindow(async(store,_dir,lease,clock,snapshot)=>{
  store.promoteRecovery(lease,clock.now());const c=seedMove(store,lease);let dispatched=0;
  const arbiter=new ActionArbiter(store,{snapshot:async()=>snapshot(),dispatch:async()=>{dispatched++;return {success:true,phase:'test'};}},
    {maxStaleMs:5000,maxDeaths:1,keepIds:[],allowedTiles:new Set(),safeEntities:new Set()},clock.now);
  await arbiter.reconcile();for(let n=0;n<30;n++){clock.advance();await arbiter.reconcile();}
  expect(dispatched).toBe(0);expect(store.action(c.action_id)!.result.reason).toBe('RECONCILED_TRANSIENT_INTERRUPTED');
}));
test('activity and position changes reset the startup quiet window instead of proving arrival',()=>movementWindow((store,dir,lease,clock,snapshot)=>{
  seedMove(store,lease);reconcileAstraJournals(store,dir,snapshot(),snapshot());
  for(let n=0;n<29;n++){clock.advance();reconcileAstraJournals(store,dir,snapshot(),snapshot());}
  clock.advance();const first=snapshot(),second=snapshot();second.position!.x++;
  expect(reconcileAstraJournals(store,dir,first,second).ready).toBe(false);
  expect(store.action('old-command')!.result.status).toBe('RUNNING');
}));
test('a stale historical dialogue context can be retired as interrupted only after a closed-interface quiet window',()=>movementWindow((store,dir,lease,clock,snapshot)=>{
  const c={...command(lease),intent:{operation:'dialogue' as const,option_index:0}};store.createAction(c,result());
  const before=observation(1);before.session_id='old-local-client';before.dialog={open:true,waiting:false,text:'old page',options:[{index:0,text:'Continue'}]};
  store.append('action_checkpoints',c.action_id,{action_id:c.action_id,before});
  let report=reconcileAstraJournals(store,dir,snapshot(),snapshot());expect(report.ready).toBe(false);expect(report.unresolved[0]!.settling).toBe(true);
  for(let n=0;n<30;n++){clock.advance();report=reconcileAstraJournals(store,dir,snapshot(),snapshot());}
  expect(report.ready).toBe(true);expect(store.action(c.action_id)!.result.status).toBe('CANCELLED');
  expect(store.action(c.action_id)!.result.reason).toBe('RECONCILED_DIALOGUE_CONTEXT_EXPIRED');
  expect(store.records<any>('transient_reconciliation')[0].original.command.intent.operation).toBe('dialogue');
}));
test('dialogue recovery never retires a command whose original open context was not captured',()=>movementWindow((store,dir,lease,clock,snapshot)=>{
  const c={...command(lease),intent:{operation:'dialogue' as const,option_index:0}};store.createAction(c,result());
  const before=observation(1);before.session_id='old-local-client';store.append('action_checkpoints',c.action_id,{action_id:c.action_id,before});
  for(let n=0;n<35;n++){clock.advance();expect(reconcileAstraJournals(store,dir,snapshot(),snapshot()).ready).toBe(false);}
  expect(store.action(c.action_id)!.result.status).toBe('RUNNING');
}));
test('manual takeover during an idle window prevents both settlement and any subsequent dispatch',()=>movementWindow((store,dir,lease,clock,snapshot)=>{
  seedMove(store,lease);reconcileAstraJournals(store,dir,snapshot(),snapshot());clock.advance();store.setControl('MANUAL');
  expect(()=>reconcileAstraJournals(store,dir,snapshot(),snapshot())).toThrow('RECOVERY_LEASE_REQUIRED');
  expect(store.action('old-command')!.result.status).toBe('RUNNING');
}));
