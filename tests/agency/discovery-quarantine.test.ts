import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildCatalogue,defaultPolicy,emptyKnowledge} from '../../src/agency/world-model.ts';
import {createMemory} from '../../src/agency/director.ts';
import {LiveAgency,authorizeAction,isSelection} from '../../src/agency/live-adapter.ts';
import type {Method} from '../../src/agency/types.ts';

const identity={agent:'unknown-player',world:'test',revision:'v1'};
const state=(extra:any={})=>({character:'unknown-player',world:'test',worldEpoch:'epoch',profileId:'profile',sessionId:'session',inGame:true,tick:1,capacity:28,
  player:{hp:20,maxHp:20,lifeId:1,respawnCount:0,isDead:false,worldX:10,worldZ:10,level:0,animId:-1,combat:{inCombat:false,targetType:'none',lastDamageTick:-1}},
  inventory:[],equipment:[],skills:[],nearbyNpcs:[],nearbyLocs:[],groundItems:[],bank:{isOpen:false,items:[]},shop:{isOpen:false,shopItems:[]},dialog:{isOpen:false},modalOpen:false,
  combatStyle:{weaponName:'unarmed',styles:[]},...extra});

const safeMethod:Method={id:'discover',capability:'discovery',domain:'exploration',effects:{'discovered:test':1},prerequisites:[],costGp:0,lossBoundGp:0,durationMs:1000,risk:'safe'};

test('an adjacent observed obstruction may be tested even when its footprint is collision-unreachable',()=>{
  const s=state({nearbyLocs:[{id:41,name:'Observed door',x:11,z:10,level:0,reachable:false,distance:1,optionsWithIndex:[{opIndex:1,text:'Open'}]}]});
  const c=buildCatalogue(identity,s,emptyKnowledge(),defaultPolicy,['discovery'],createMemory(identity),1000);
  assert.ok(c.opportunities.some(o=>o.id==='discover:discovered:interaction:41:11:10:0:1'));
  assert.doesNotThrow(()=>authorizeAction(s,{id:'try',type:'interactLoc',fields:{locId:41,x:11,z:10,optionIndex:1}},safeMethod,0));
});

test('an unreachable transition farther away is not authority for an interaction',()=>{
  const s=state({nearbyLocs:[{id:41,name:'Observed door',x:12,z:10,level:0,reachable:false,distance:2,optionsWithIndex:[{opIndex:1,text:'Open'}]}]});
  const c=buildCatalogue(identity,s,emptyKnowledge(),defaultPolicy,['discovery'],createMemory(identity),1000);
  assert.equal(c.opportunities.some(o=>o.id.startsWith('discover:')),false);
  assert.throws(()=>authorizeAction(s,{id:'try',type:'interactLoc',fields:{locId:41,x:12,z:10,optionIndex:1}},safeMethod,0),/FRESH_LOC_OPTION_REQUIRED/);
});

test('no strategic plan exposes bounded local collision-verified probes as maintenance, not a scripted activity',()=>{
  const memory=createMemory(identity),knowledge=emptyKnowledge();
  const c=buildCatalogue(identity,state(),knowledge,defaultPolicy,['exploration'],memory,1000);
  const probes=c.opportunities.filter(o=>o.id.startsWith('survey:local-probe:'));
  assert.ok(probes.length>0);assert.ok(probes.every(o=>o.priority==='maintenance'));
  for(const p of probes){
    const route=c.tasks.get(p.id)?.route!;
    assert.equal(route.level,0);
    assert.equal(Math.max(Math.abs(route.x-10),Math.abs(route.z-10)),3);
    assert.match(route.evidence,/collision verification required/);
  }
});

test('local probes are bounded after two recent probe completions',()=>{
  const memory=createMemory(identity);const template:any={domain:'exploration',target:{fact:'visited:x',minimum:1},reason:'probe',evidence:['own'],source:'frontier',key:'k',context:'c',startedAt:1,budget:{spendableGp:0,maxLossGp:0,maxDeaths:0,maxDurationMs:1},baseline:0,spentGp:0,lostGp:0,deaths:0,elapsedMs:0,attempts:0,noProgress:0};
  memory.reviews=[{goal:{...template,id:'local-probe:a'},at:900,result:'success',reason:'done',evidence:[]},{goal:{...template,id:'local-probe:b'},at:950,result:'success',reason:'done',evidence:[]}];
  const c=buildCatalogue(identity,state(),emptyKnowledge(),defaultPolicy,['exploration'],memory,1000);
  assert.equal(c.opportunities.some(o=>o.id.startsWith('survey:local-probe:')),false);
});

function fixture(t:any){
  const dir=mkdtempSync(join(tmpdir(),'transaction-quarantine-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  let now=1000;const agency=new LiveAgency(join(dir,'agency.json'),identity,{supported:['production','exploration','discovery'],now:()=>now});
  return {agency,time:(v:number)=>now=v};
}

test('historically unattributable bank transfer is quarantined without success or failure and blocks equivalent replay',t=>{
  const f=fixture(t),a=f.agency;
  const before=state({tick:10,bank:{isOpen:true,items:[{id:995,name:'Coins',slot:0,count:100}]}});
  const planned=a.plan(before);assert.ok(isSelection(planned));
  const action={id:'withdraw',type:'bankWithdraw',itemRefs:[{field:'slot',container:'bank' as const,id:995,name:'Coins',minimum:50}],fields:{slot:0,amount:50}};
  a.begin(planned,action,before,'old-bank');
  a.record('old-bank',before,{status:'unknown',evidence:[],reason:'original bank source unavailable'});
  f.time(122000);
  const current=state({tick:20,bank:{isOpen:false,items:[]}});
  const q=a.quarantinePendingTransaction(current,'original bank source unavailable');
  assert.ok(q);assert.equal(a.pending(),undefined);assert.equal(a.director.memory.learningRevision??0,0);
  assert.equal(a.summary().lastOutcome?.status,'quarantined');assert.equal(a.summary().transactionQuarantine.at(-1)?.active,true);
  const freshOpen=state({tick:21,bank:{isOpen:true,items:[{id:995,name:'Coins',slot:0,count:100}]}});
  assert.equal(a.eligible(action,freshOpen),false);
  a.catalogue(freshOpen);
  assert.equal(a.summary().transactionQuarantine.at(-1)?.active,false);
  assert.equal(a.eligible(action,freshOpen),true);
});

test('elapsed time alone cannot quarantine an unknown value-moving action',t=>{
  const f=fixture(t),a=f.agency,before=state({tick:10,bank:{isOpen:true,items:[{id:995,name:'Coins',slot:0,count:100}]}});
  const planned=a.plan(before);assert.ok(isSelection(planned));
  a.begin(planned,{id:'withdraw',type:'bankWithdraw',itemRefs:[{field:'slot',container:'bank',id:995,name:'Coins',minimum:10}],fields:{slot:0,amount:10}},before,'old-bank');
  a.record('old-bank',before,{status:'unknown',evidence:[],reason:'transport timeout'});f.time(500000);
  assert.equal(a.quarantinePendingTransaction(state({tick:20}),'transport timeout'),undefined);
  assert.equal(a.pending()?.commandId,'old-bank');
});
