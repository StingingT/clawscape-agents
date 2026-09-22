import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LiveAgency,neutralInterfaceRecovery,stateProvesAcknowledgementStillRequired,STATE_PROVEN_ACKNOWLEDGEMENT_RETRY_MS} from '../../src/agency/live-adapter.ts';
import {capabilityContext} from '../../src/agency/world-model.ts';
import {retryExhausted,stepKey} from '../../src/agency/step-retry.ts';

const state=(bankOpen:boolean)=>({character:'tester',world:'test',inGame:true,tick:1,player:{level:0,hp:10,maxHp:10},skills:[],inventory:[],equipment:[],nearbyLocs:[],nearbyNpcs:[],bank:{isOpen:bankOpen,items:[]},shop:{isOpen:false,shopItems:[]},dialog:{isOpen:false,options:[]}});

test('same-context repeated route failures exhaust into replanning but reset on changed knowledge',()=>{
  const retry:any={state:'uncertain',attempts:3,at:10,retryAt:100,context:'same',learningRevision:4,evidence:[],reason:'partial path'};
  assert.equal(retryExhausted(retry,'same',4),true);
  assert.equal(retryExhausted(retry,'other',4),false);
  assert.equal(retryExhausted(retry,'same',5),false);
});

test('a bounded executor episode can normalize an idle bank interface without bypassing the action journal',t=>{
  const root=mkdtempSync(join(tmpdir(),'interface-recovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const agency=new LiveAgency(join(root,'agency.json'),{agent:'tester',world:'test',revision:'r'},{supported:['exploration']});
  (agency as any).document.executorEpisode={at:0,context:capabilityContext(state(true)),learningRevision:0,executorRevision:'r',failures:['a','b','c'],recheckAt:Date.now()+60_000};
  const action=agency.blockedInterfaceRecovery(state(true));
  assert.equal(action?.type,'closeModal');
  assert.equal(action?.id,'recover-close-bank-interface');
  assert.equal(agency.blockedInterfaceRecovery(state(false)),undefined);
});

test('bank visibility changes executor capability context but moving alone does not',()=>{
  const open=state(true),closed=state(false);
  assert.notEqual(capabilityContext(open),capabilityContext(closed));
  const moved={...closed,player:{...closed.player,x:10,z:20}};
  assert.equal(capabilityContext(closed),capabilityContext(moved));
});

test('a new executor revision clears a stale capability episode for one fresh planning pass',t=>{
  const root=mkdtempSync(join(tmpdir(),'executor-revision-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'agency.json'),identity={agent:'tester',world:'test',revision:'r'},open=state(false);
  const old=new LiveAgency(file,identity,{supported:['exploration'],executorRevision:'old-build'});
  (old as any).document.executorEpisode={at:0,context:capabilityContext(open),learningRevision:0,executorRevision:'old-build',failures:['a','b','c'],recheckAt:Date.now()+60_000};
  (old as any).save();
  const updated=new LiveAgency(file,identity,{supported:['exploration'],executorRevision:'new-build'});
  updated.plan(open);
  assert.equal(updated.summary().executorEpisode,undefined);
});

test('only an observed open neutral interface may use the recovery journal',t=>{
  const root=mkdtempSync(join(tmpdir(),'interface-recovery-journal-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const agency=new LiveAgency(join(root,'agency.json'),{agent:'tester',world:'test',revision:'r'},{supported:['exploration']});
  const open=state(true),close={id:'recover-close-bank-interface',type:'closeModal' as const,waitTicks:1};
  assert.equal(neutralInterfaceRecovery(open,close),true);
  assert.equal(neutralInterfaceRecovery(state(false),close),false);
  assert.doesNotThrow(()=>agency.beginSafety(close,open,'neutral-close'));
});

test('a still-visible design acknowledgement rechecks on a bounded cadence instead of inheriting exponential retry debt',t=>{
  const root=mkdtempSync(join(tmpdir(),'design-acknowledgement-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let now=100_000;
  const design={...state(false),modalOpen:true};
  const agency=new LiveAgency(join(root,'agency.json'),{agent:'tester',world:'test',revision:'r'},
    {supported:['exploration'],now:()=>now});
  const action={id:'accept-design',type:'acceptCharacterDesign',waitTicks:1};
  const key=stepKey(action,design);
  (agency as any).document.retries={[key]:{state:'uncertain',attempts:8,at:now,retryAt:now+30*60_000,
    context:capabilityContext(design),learningRevision:0,evidence:['old acknowledgement unknown'],reason:'unattributed'}};
  assert.equal(agency.eligible(action,design),false);
  now+=STATE_PROVEN_ACKNOWLEDGEMENT_RETRY_MS;
  assert.equal(agency.eligible(action,design),true);
  // The exception is predicate-bound: closing the modal returns to normal
  // retry semantics and cannot authorize a stale UI action.
  assert.equal(agency.eligible(action,{...design,modalOpen:false}),false);
  assert.equal(stateProvesAcknowledgementStillRequired(action,{...design,bank:{isOpen:true,items:[]}}),false);
});
