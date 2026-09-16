import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.ts';
import {LiveAgency,isSelection} from '../../../src/agency/live-adapter.ts';
import {agencyState,agencyCandidate,arbiterVerification} from '../src/agency-bridge.ts';
import {reconcileAstraJournals} from '../src/restart-journals.ts';
import type {ActionCommand,ActionResult,Observation} from '../src/contracts.ts';

function observation(tick:number,seq:number):Observation {
  return {schema_version:'1.0',character:'arbitrary-player',world:'test',profile_id:'test-profile',world_epoch:'epoch',session_id:'client',
    tick,seq,observed_at:Date.now(),fresh_at:Date.now(),provenance:'cli-player-observation',connected:true,
    position:{x:10,z:10,plane:0},hp:30,max_hp:30,life_id:1,respawns:0,
    skills:[],capacity:28,inventory:[],equipment:[],bank:{open:false,items:null},shop_open:false,
    dialog:{open:false,waiting:false,text:'',options:[]},feedback:[],danger:{active:false,damage_margin:2},unavailable:[],entities:[],
    activity:{animation:-1,target_index:-1,target_type:'none',last_damage_tick:-1,modal_open:false,modal_id:-1,style:0,styles:[],design_open:false,events:[]}};
}

for(const kind of ['bank','traversal','traversal-life'] as const) test('Astra '+kind+' recovery survives reset game ticks and accounts both exact journals',()=>{
  const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
  const dir=mkdtempSync(join(tmpdir(),'astra-context-reset-'));const store=new Store(join(dir,'journal.sqlite'));
  try {
    const before=observation(50_000,50_000);before.observed_at=before.fresh_at=clock-180_000;
    if(kind==='bank')before.bank={open:true,items:[{slot:7,id:315,name:'Owned resource',count:5,protected:false,options:[]}]};
    else {
      before.position={x:10,z:10,plane:1};
      before.entities=[{ref:'captured-stair',kind:'object',content_id:71,index:null,name:'Ordinary staircase',position:{x:11,z:10,plane:1},
        reachable:true,hp:null,max_hp:null,combat_level:null,in_combat:false,options:[{index:1,text:'Climb-down'}]} as any];
    }
    let agencyClock=clock-180_000;
    const agency=new LiveAgency(join(dir,'agency-v2.json'),{agent:before.character,world:before.world,revision:before.profile_id},
      {supported:kind==='bank'?['production','exploration']:['discovery','exploration'],now:()=>agencyClock});
    const selected=agency.plan(agencyState(before));expect(isSelection(selected)).toBe(true);if(!isSelection(selected))return;
    const lease=store.acquireRecovery('sole-owner',clock);
    const command:ActionCommand={schema_version:'1.0',action_id:'original',character:before.character,world:before.world,world_epoch:before.world_epoch,
      profile_id:before.profile_id,session_id:before.session_id,lease,plan_id:selected.task.id,based_on_snapshot:before.seq,expires_at:agencyClock+1000,
      intent:kind==='bank'?{operation:'withdraw',slot:7,item_id:315,amount:1}:{operation:'interact',entity_ref:'captured-stair',option_index:1}};
    const result:ActionResult={schema_version:'1.0',action_id:command.action_id,status:'RUNNING',reason:'OUTCOME_UNKNOWN',at:agencyClock,evidence:[]};
    agency.begin(selected,agencyCandidate(before,{goal:selected.task.id,reason:'recorded original operation',intent:command.intent}),agencyState(before),'original');
    agency.record('original',agencyState(before),{status:'unknown',evidence:[],reason:'transport timeout'});
    store.createAction(command,result);store.append('action_checkpoints','original',{action_id:'original',before});
    let report:any;
    for(let n=0;n<=6;n++){
      if(n)clock+=5000;agencyClock=clock;store.renew(lease,clock);
      const first=observation(n*2+1,50_001+n*2),second=observation(n*2+2,50_002+n*2);
      if(kind==='bank'){first.world_epoch=second.world_epoch='new-epoch';}
      if(kind==='traversal-life'){first.life_id=second.life_id=2;first.respawns=second.respawns=1;}
      report=reconcileAstraJournals(store,dir,first,second,agency);
      if(n<6){expect(report.ready).toBe(false);expect(report.unresolved.some((r:any)=>r.settling)).toBe(true);expect(store.pending()).toHaveLength(1);}
    }
    expect(report.ready).toBe(true);expect(agency.pending()).toBeUndefined();expect(store.pending()).toHaveLength(0);
    expect(store.action('original')!.result.status).toBe('CANCELLED');
    expect(agency.director.memory.learningRevision??0).toBe(0);
    expect(agency.director.memory.reviews.some(r=>r.result==='success')).toBe(false);
    if(kind==='bank'){
      expect(arbiterVerification('original',store.action('original')!.result).status).toBe('unknown');
      expect(agency.quarantinedTransaction('original')!.originalReceipt).toBeDefined();
      expect(store.records('transaction_quarantine')).toHaveLength(1);
    } else {
      expect(agency.summary().historicalRetirements).toHaveLength(1);
      expect(agency.summary().historicalRetirements[0]!.lossAttribution).toBe('unknown');
      expect(store.records('transient_reconciliation')).toHaveLength(1);
    }
    const first=observation(20,50_100),second=observation(21,50_101);
    if(kind==='bank')first.world_epoch=second.world_epoch='new-epoch';
    if(kind==='traversal-life'){first.life_id=second.life_id=2;first.respawns=second.respawns=1;}
    expect(reconcileAstraJournals(store,dir,first,second,agency).ready).toBe(true);
    expect(store.records(kind==='bank'?'transaction_quarantine':'transient_reconciliation')).toHaveLength(1);
    store.promoteRecovery(lease,clock);
  } finally {
    Date.now=realNow;store.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
