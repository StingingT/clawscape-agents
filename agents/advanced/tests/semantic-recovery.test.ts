import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.ts';
import {settleAstraTransient} from '../src/transient-recovery.ts';
import {LivePolicy} from '../src/live-policy.ts';
import {agencyCandidate,arbiterVerification} from '../src/agency-bridge.ts';
import type {ActionCommand,ActionResult,Observation} from '../src/contracts.ts';

const observed=(tick=1,at=1000):Observation=>({schema_version:'1.0',character:'independent-player',world:'test',world_epoch:'epoch',session_id:'session',profile_id:'profile',seq:tick,tick,
 observed_at:at,fresh_at:at,provenance:'cli-player-observation',connected:true,position:{x:10,z:10,plane:0},hp:20,max_hp:20,life_id:1,respawns:0,
 skills:[],capacity:28,inventory:[],equipment:[],bank:{open:false,items:[]},shop_open:false,dialog:{open:false,waiting:false,text:'',options:[]},
 feedback:[],danger:{active:false,damage_margin:2},unavailable:[],
 entities:[{kind:'object',ref:'near-object',index:null,content_id:41,name:'Observed obstruction',position:{x:11,z:10,plane:0},reachable:true,options:[{index:1,text:'Open'}],combat_level:null,hp:null,max_hp:null,in_combat:null},
 {kind:'object',ref:'other-object',index:null,content_id:42,name:'Another observed obstruction',position:{x:12,z:10,plane:0},reachable:true,options:[{index:1,text:'Open'}],combat_level:null,hp:null,max_hp:null,in_combat:null}],
 activity:{animation:-1,target_index:-1,target_type:'none',last_damage_tick:-1,modal_open:false,modal_id:-1,style:0,styles:[],design_open:false,events:[]}});
const decision={goal:'discover:discovered:interaction:41:11:10:0:1',reason:'Fresh observed experiment',intent:{operation:'interact' as const,entity_ref:'near-object',option_index:1}};
const result:ActionResult={schema_version:'1.0',action_id:'original',status:'RUNNING',reason:'OUTCOME_UNKNOWN',at:1000,evidence:[]};
// Simulate the independent live heartbeat while observation time advances.
function keepAlive(store:Store,lease:string,now:number){
 while(store.control().expires<=now)store.renew(lease,store.control().expires-1000);
 store.renew(lease,now);
}
function fixture(run:(store:Store,lease:string,command:ActionCommand)=>void){
 const dir=mkdtempSync(join(tmpdir(),'semantic-recovery-')),store=new Store(join(dir,'journal.sqlite'));
 try{
   const lease=store.acquireRecovery('test',1000);store.promoteRecovery(lease,1000);
   const command:ActionCommand={schema_version:'1.0',action_id:'original',character:'independent-player',world:'test',world_epoch:'epoch',session_id:'session',profile_id:'profile',lease,
     plan_id:decision.goal,based_on_snapshot:1,expires_at:6000,intent:decision.intent};
   store.createAction(command,result);store.append('action_checkpoints','original',{action_id:'original',before:observed()});
   run(store,lease,command);
 }finally{store.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}

test('live interaction quiescence settles only its exact arbiter entry and clears the matching policy uncertainty without success',()=>fixture((store,lease,command)=>{
 const before=observed(),policy=new LivePolicy();policy.recordOutcome(before,observed(2,2000),decision,'RUNNING');
 const initial=policy.summary().state.counters.effects;
 expect(policy.summary().state.uncertain).not.toBeNull();
 store.renew(lease,2000);expect(settleAstraTransient(store,command,result,before,observed(2,2000),2000).settling).toBe(true);
 keepAlive(store,lease,32001);const proof=settleAstraTransient(store,command,result,before,observed(40,32001),32001);
 expect(proof.result?.status).toBe('CANCELLED');expect(store.pending()).toHaveLength(0);
 expect(store.records('transient_reconciliation')).toHaveLength(1);
 expect(arbiterVerification('original',proof.result).status).toBe('interrupted');
 expect(policy.retireReconciledOutcome({...before,seq:999},command.intent,proof.result!)).toBe(false);
 expect(policy.retireReconciledOutcome(before,{operation:'interact',entity_ref:'other-object',option_index:1},proof.result!)).toBe(false);
 expect(policy.retireReconciledOutcome(before,command.intent,proof.result!)).toBe(true);
 expect(policy.summary().state.uncertain).toBeNull();expect(policy.summary().state.counters.effects).toBe(initial);
 expect(policy.retireReconciledOutcome(before,command.intent,proof.result!)).toBe(false);
 const next=policy.next(observed(41,33000),{id:'discover:discovered:interaction:42:12:10:0:1',kind:'discovery'});
 expect(next.intent).toEqual({operation:'interact',entity_ref:'other-object',option_index:1});
}));

test('unknown bank transfers cannot enter transient settlement, even with a quiet current bank view',()=>fixture((store,lease,command)=>{
 const bank=observed();bank.bank={open:true,items:[]};
 store.renew(lease,2000);
 const c={...command,intent:{operation:'withdraw' as const,slot:0,item_id:40,amount:1}};
 expect(settleAstraTransient(store,c,result,bank,{...bank,seq:2,tick:2,fresh_at:2000},2000).settling).toBe(false);
 keepAlive(store,lease,100000);
 expect(settleAstraTransient(store,c,result,bank,{...bank,seq:100,tick:100,fresh_at:100000},100000).result).toBeUndefined();
 expect(store.action('original')?.result.status).toBe('RUNNING');
}));

test('fresh danger or manual takeover cannot be used to retire an unresolved interaction',()=>fixture((store,lease,command)=>{
 store.renew(lease,2000);settleAstraTransient(store,command,result,observed(),observed(2,2000),2000);
 keepAlive(store,lease,33000);const unsafe=observed(40,33000);unsafe.danger.active=true;
 expect(settleAstraTransient(store,command,result,observed(),unsafe,33000).result).toBeUndefined();
 store.setControl('MANUAL');
 expect(settleAstraTransient(store,command,result,observed(),observed(41,34000),34000).result).toBeUndefined();
 expect(store.records('transient_reconciliation')).toHaveLength(0);
}));

test('policy cannot clear uncertainty from ordinary timeout, unrelated result, or zero evidence',()=>{
 const p=new LivePolicy(),before=observed();p.recordOutcome(before,observed(2,2000),decision,'RUNNING');
 expect(p.retireReconciledOutcome(before,decision.intent,{...result,status:'CANCELLED',reason:'OUTCOME_UNKNOWN',evidence:['timeout']})).toBe(false);
 expect(p.retireReconciledOutcome(before,decision.intent,{...result,status:'CANCELLED',reason:'RECONCILED_TRANSIENT_INTERRUPTED'})).toBe(false);
 expect(p.summary().state.uncertain).not.toBeNull();
});

test('navigation evidence retains the planned endpoint rather than only the next waypoint',()=>{
 const action=agencyCandidate(observed(),{goal:'observed-route',reason:'Route leg',destination:{x:80,z:80,plane:0},intent:{operation:'move',destination:{x:12,z:10,plane:0}}});
 expect(action.approach).toEqual({x:80,z:80,level:0});expect(action.fields).toEqual({x:12,z:10,level:0});
});

test('discovery dispatch binds the selected observable target, not the nearest object',()=>{
 const p=new LivePolicy(),o=observed();
 const d=p.next(o,{id:'discover:discovered:interaction:42:12:10:0:1',kind:'discovery'});
 expect(d.intent).toEqual({operation:'interact',entity_ref:'other-object',option_index:1});
 const absent=p.next(o,{id:'discover:discovered:interaction:9000:12:10:0:1',kind:'discovery'});
 expect(absent.intent).toBeUndefined();expect(absent.blocked).toBe('NO_LOCAL_RECOVERY_EXPERIMENT');
});

test('missing original target evidence stays unresolved instead of crashing the reconciliation loop',()=>fixture((store,lease,command)=>{
 const before=observed();before.entities=[];store.renew(lease,2000);
 const settlement=settleAstraTransient(store,command,result,before,observed(2,2000),2000);
 expect(settlement.result).toBeUndefined();expect(settlement.reason).toContain('Original observed');
 expect(store.action('original')?.result.status).toBe('RUNNING');
}));
