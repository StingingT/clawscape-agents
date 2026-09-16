import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { LiveAgency, isSelection } from '../../../src/agency/live-adapter.ts';
import { LivePolicy } from '../src/live-policy.ts';
import { agencyState, agencyCandidate, arbiterVerification } from '../src/agency-bridge.ts';
import { reconcileAstraJournals } from '../src/restart-journals.ts';
import { HISTORICAL_QUARANTINE } from '../src/transaction-quarantine.ts';
import type { Observation, ActionCommand, ActionResult, Intent } from '../src/contracts.ts';

function observation(tick:number):Observation {
  return {schema_version:'1.0',character:'generic-player',world:'test-world',world_epoch:'new-epoch',session_id:'new-session',profile_id:'test',
    seq:tick,tick,observed_at:Date.now(),fresh_at:Date.now(),provenance:'cli-player-observation',connected:true,
    position:{x:10,z:10,plane:0},hp:30,max_hp:30,life_id:1,respawns:0,skills:[],capacity:28,inventory:[],equipment:[],
    bank:{open:false,items:null},shop_open:false,dialog:{open:false,waiting:false,text:'',options:[]},feedback:[],
    danger:{active:false,damage_margin:2},unavailable:[],entities:[],
    activity:{animation:-1,target_index:-1,target_type:'none',last_damage_tick:-1,modal_open:false,modal_id:-1,
      style:0,styles:[],design_open:false,events:[]}};
}

for(const kind of ['bank','transition'] as const)test(`Astra ${kind} historical context uses advancing current ticks and retires both exact journals without success`,()=>{
  const real=Date.now();let now=real-180000;const clock=spyOn(Date,'now').mockImplementation(()=>now);
  const dir=mkdtempSync(join(tmpdir(),'astra-historical-'));const store=new Store(join(dir,'journal.sqlite'));
  try {
    const before=observation(50000);before.world_epoch='old-epoch';before.session_id='old-session';
    before.bank={open:true,items:[{slot:7,id:41,name:'Test material',count:5,protected:false,options:[]}]};
    let intent:Intent={operation:'withdraw',slot:7,item_id:41,amount:1};
    if(kind==='transition'){
      before.position!.plane=1;
      before.entities=[{ref:'observed-stairs',kind:'object',content_id:7123,index:null,name:'Staircase',position:{x:10,z:11,plane:1},
        reachable:true,options:[{index:1,text:'Climb-down'}],hp:null,max_hp:null,combat_level:null,in_combat:null} as any];
      intent={operation:'interact',entity_ref:'observed-stairs',option_index:1};
    }
    const a=new LiveAgency(join(dir,'agency-v2.json'),{agent:before.character,world:before.world,revision:'test'},
      {supported:['production','exploration','discovery'],now:()=>now});
    const plan=a.plan(agencyState(before));if(!isSelection(plan))throw new Error('Expected an observed feasible fixture plan');
    const decision={goal:plan.task.id,reason:'Observed prerequisite or transition',intent};
    a.begin(plan,agencyCandidate(before,decision),agencyState(before),'old-command');
    a.record('old-command',agencyState(before),{status:'unknown',evidence:[],reason:'outcome unknown'});
    now=real;const lease=store.acquireRecovery('current-controller',now);
    const command:ActionCommand={schema_version:'1.0',action_id:'old-command',character:before.character,world:before.world,
      world_epoch:before.world_epoch,session_id:before.session_id,profile_id:before.profile_id,lease,plan_id:plan.task.id,
      based_on_snapshot:before.seq,expires_at:real-170000,intent};
    const result:ActionResult={schema_version:'1.0',action_id:'old-command',status:'RUNNING',reason:'OUTCOME_UNKNOWN',at:real-180000,evidence:[]};
    store.createAction(command,result);store.append('action_checkpoints','old-command',{action_id:'old-command',before});
    const policy=new LivePolicy();const afterUnknown={...before,seq:50001,tick:50001};policy.recordOutcome(before,afterUnknown,decision,'RUNNING');
    const counters=structuredClone((policy.summary() as any).state.counters);
    for(let n=0;n<=3;n++){
      now=real+n*10000;store.renew(lease,now);
      const report=reconcileAstraJournals(store,dir,observation(9+n),observation(10+n),a);
      if(n<3){expect(report.ready).toBe(false);expect(report.unresolved.some(r=>r.settling)).toBe(true);expect(a.pending()).toBeDefined();}
      else {expect(report.ready).toBe(true);expect(report.unresolved).toHaveLength(0);}
    }
    const retired=store.action('old-command')!.result;
    expect(retired.status).toBe('CANCELLED');expect(retired.reason).toBe(HISTORICAL_QUARANTINE);
    expect(store.pending()).toHaveLength(0);expect(a.pending()).toBeUndefined();
    expect(store.records<any>('transaction_quarantine')).toHaveLength(1);
    expect(store.records<any>('transaction_quarantine')[0].original.result.status).toBe('RUNNING');
    expect(a.director.memory.learningRevision??0).toBe(0);
    expect(arbiterVerification('old-command',retired).status).toBe('unknown');
    expect(policy.retireReconciledOutcome(before,intent,retired)).toBe(true);
    expect((policy.summary() as any).state.uncertain).toBeNull();expect((policy.summary() as any).state.counters).toEqual(counters);
    reconcileAstraJournals(store,dir,observation(14),observation(15),a);
    expect(store.records('transaction_quarantine')).toHaveLength(1);
  } finally {store.close();clock.mockRestore();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
