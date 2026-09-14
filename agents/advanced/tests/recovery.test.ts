import {test,expect} from 'bun:test';
import {Store} from '../src/store.ts';
import {ActionArbiter,evidence,type SafetyPolicy} from '../src/arbiter.ts';
import {LiveNavigator} from '../src/live-navigation.ts';
import {arbiterVerification} from '../src/agency-bridge.ts';
import type {Observation,ActionCommand,Intent} from '../src/contracts.ts';

function observation(at=20_000,tick=20):Observation {
 return {schema_version:'1.0',character:'astra',world:'test',world_epoch:'world-1',session_id:'s1',profile_id:'test',seq:tick,tick,
 observed_at:at,fresh_at:at,provenance:'cli-player-observation',connected:true,position:{x:100,z:100,plane:0},hp:30,max_hp:30,life_id:1,respawns:0,
 skills:[{name:'fletching',current:1,base:1,xp:0}],capacity:28,inventory:[],equipment:[],bank:{open:false,items:null},shop_open:false,
 dialog:{open:false,waiting:false,text:'',options:[]},feedback:[],danger:{active:false,damage_margin:2},unavailable:[],entities:[],
 activity:{animation:-1,target_index:-1,target_type:'none',last_damage_tick:-1,modal_open:false,modal_id:-1,style:0,styles:[],design_open:false,events:[]}};
}
const policy:SafetyPolicy={maxStaleMs:5000,maxDeaths:3,keepIds:[],allowedTiles:new Set(),safeEntities:new Set(),allowLocalEpoch:true};
function pending(store:Store,intent:Intent):ActionCommand {
 const command:ActionCommand={schema_version:'1.0',action_id:'old',character:'astra',world:'test',world_epoch:'world-1',session_id:'s1',profile_id:'test',
 lease:'old-lease',plan_id:'route',based_on_snapshot:1,expires_at:5000,intent};
 store.createAction(command,{schema_version:'1.0',action_id:'old',status:'RUNNING',reason:'DISPATCH_STARTED',at:1000,evidence:[]});
 store.append('action_checkpoints','old',{action_id:'old',before:observation(1000,1)});return command;
}
test('Astra accepts partial movement on the dispatched leg, not off-route or cross-life motion',()=>{
 const before=observation(),after=observation(21_000,21);after.position={x:103,z:100,plane:0};
 const intent:Intent={operation:'move',destination:{x:108,z:100,plane:0}};
 expect(evidence(intent,before,after)).toEqual(['verified-movement-leg-progress']);
 after.position.z=101;expect(evidence(intent,before,after)).toEqual([]);
 after.position.z=100;after.life_id=2;expect(evidence(intent,before,after)).toEqual([]);
});
test('Astra records same-interface production only with consumed inputs, output and XP',()=>{
 const before=observation(),after=observation(21_000,21);
 before.dialog=after.dialog={open:true,waiting:false,text:'Make arrows',options:[{index:1,text:'Make all arrows'}]};
 before.inventory=[{slot:0,id:53,name:'Headless arrow',count:20,protected:false,options:[]}];
 after.inventory=[{slot:0,id:53,name:'Headless arrow',count:10,protected:false,options:[]},{slot:1,id:882,name:'Bronze arrow',count:10,protected:false,options:[]}];
 expect(evidence({operation:'dialogue',option_index:1},before,after)).toEqual([]);
 after.skills[0]!.xp=10;expect(evidence({operation:'dialogue',option_index:1},before,after).length).toBeGreaterThan(0);
});
test('reconciliation ownership does not permit new mutations while a previous action is unresolved',async()=>{
 const store=new Store(':memory:');try{
 pending(store,{operation:'move',destination:{x:108,z:100,plane:0}});
 expect(()=>store.acquire('new',20_000)).toThrow('RECONCILE_PENDING');
 const lease=store.acquireForReconciliation('reconciler',20_000);expect(lease.length).toBeGreaterThan(0);
 expect(()=>store.acquireForReconciliation('second',20_001)).toThrow('CONTROL_OWNED');
 let sends=0;const arbiter=new ActionArbiter(store,{snapshot:async()=>observation(),dispatch:async()=>{sends++;return {success:true,phase:'done'};}},policy,()=>20_000);
 const result=await arbiter.submit({...store.action('old')!.command,action_id:'new',lease,expires_at:25_000});
 expect(result.reason).toBe('RECONCILE_PENDING');expect(sends).toBe(0);
 }finally{store.close();}
});
test('manual takeover and disabled control still prevent reconciliation ownership',()=>{
 for(const mode of ['MANUAL','DISABLED'] as const){const store=new Store(':memory:');try{store.setControl(mode);expect(()=>store.acquireForReconciliation('new',20_000)).toThrow(mode==='MANUAL'?'MANUAL_TAKEOVER':'HARD_DISABLED');}finally{store.close();}}
});
test('stationary legacy motion is superseded with no replay or arrival claim',async()=>{
 const store=new Store(':memory:');try{pending(store,{operation:'move',destination:{x:108,z:100,plane:0}});let now=20_000,current=observation();current.session_id='new-session';
 let sends=0;const arbiter=new ActionArbiter(store,{snapshot:async()=>current,dispatch:async()=>{sends++;return {success:true,phase:'done'};}},policy,()=>now);
 expect(await arbiter.reconcile()).toEqual([]);now+=1500;current={...current,tick:22,seq:22,observed_at:now,fresh_at:now};
 const results=await arbiter.reconcile();expect(results[0]?.reason).toBe('MOTION_SUPERSEDED_WITHOUT_REPLAY');
 expect(arbiterVerification('old',results[0])).toMatchObject({status:'deferred'});expect(store.pending()).toHaveLength(0);expect(sends).toBe(0);
 }finally{store.close();}
});
test('unknown bank transfers never inherit the movement-expiry exception',async()=>{
 const store=new Store(':memory:');try{pending(store,{operation:'withdraw',slot:0,item_id:995,amount:100});let now=20_000,current=observation();
 const arbiter=new ActionArbiter(store,{snapshot:async()=>current,dispatch:async()=>{throw new Error('must not dispatch');}},policy,()=>now);
 expect(await arbiter.reconcile()).toEqual([]);now+=60_000;current={...current,tick:100,seq:100,fresh_at:now,observed_at:now};expect(await arbiter.reconcile()).toEqual([]);expect(store.pending()).toHaveLength(1);
 }finally{store.close();}
});
test('failed map initialization rejects preparation instead of waiting forever',async()=>{
 const worker:any={postMessage(){},terminate(){},onmessage:null,onerror:null};
 const nav=new LiveNavigator(()=>worker);const prepared=nav.prepare(100);worker.onerror({message:'missing private path details',preventDefault(){}});
 await expect(prepared).rejects.toThrow('MAP_WORKER_FAILED');nav.close();
});
test('missing map ready message has a bounded startup timeout',async()=>{
 const nav=new LiveNavigator(()=>({postMessage(){},terminate(){}} as any));try{await expect(nav.prepare(5)).rejects.toThrow('MAP_INITIALIZATION_TIMEOUT');}finally{nav.close();}
});
