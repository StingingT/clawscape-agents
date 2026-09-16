import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Director, createMemory } from '../../src/agency/director.ts';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';
import { buildCatalogue, defaultPolicy, emptyKnowledge } from '../../src/agency/world-model.ts';

const identity={agent:'generic-player',world:'test',revision:'test'};
const state=(tick:number):any=>({character:identity.agent,world:identity.world,inGame:true,tick,
  player:{worldX:10,worldZ:10,level:0,lifeId:1,respawnCount:0,hp:30,maxHp:30,animId:-1,combat:{inCombat:false,targetType:'none',lastDamageTick:-1}},
  inventory:[],equipment:[],skills:[],nearbyLocs:[],bank:{isOpen:false},shop:{isOpen:false},dialog:{isOpen:false},modalOpen:false});
const view=(at:number):any=>({...identity,at,context:'stable-capability',facts:{visited:0,output:0},capabilities:['navigate','manufacture'],
  budget:{spendableGp:0,maxLossGp:100,maxDeaths:1,maxDurationMs:1800000}});
const opportunities:any[]=[{id:'investigate-local-route',domain:'exploration',source:'frontier',target:{fact:'visited',minimum:1},reason:'Learn a currently observed route',evidence:['fresh-local-observation']},
  {id:'use-prepared-material',domain:'crafting',source:'collection',target:{fact:'output',minimum:1},reason:'Use personally available input',evidence:['observed-input']}];
const methods:any[]=[{id:'assessed-route',capability:'navigate',domain:'exploration',effects:{visited:1},prerequisites:[],risk:'safe',costGp:0,lossBoundGp:0,durationMs:1000},
  {id:'known-material-operation',capability:'manufacture',domain:'crafting',effects:{output:1},prerequisites:[],risk:'safe',costGp:0,lossBoundGp:0,durationMs:1000}];

test('repeated blocked diagnostics cannot slide a recheck deadline or reset its attempts across restart',()=>{
  let director=new Director(createMemory(identity));assert.equal(director.next(view(0),opportunities,methods).type,'execute');
  assert.equal(director.memory.active?.id,'investigate-local-route');
  director.blocked(100,'No executable approach',['route-refusal']);
  const firstDue=director.memory.active!.blocker!.recheckAt;
  for(let n=1;n<6;n++){const at=100+n*1000;assert.equal(director.next(view(at),opportunities,methods).type,'blocked');director.blocked(at,'No executable approach',['route-refusal']);}
  assert.equal(director.memory.active!.blocker!.recheckAt,firstDue);
  director=new Director(JSON.parse(JSON.stringify(director.memory)));
  for(let n=0;n<2;n++){
    const at=firstDue+n*30000;assert.equal(director.next(view(at),opportunities,methods).type,'blocked');director.blocked(at+1,'No executable approach',['route-refusal']);
    assert.equal(director.memory.active!.blocker!.attempts,n+1);
  }
  const decision=director.next(view(firstDue+60000),opportunities,methods);assert.equal(decision.type,'execute');
  assert.equal(director.memory.active?.id,'use-prepared-material');
  assert.equal(director.memory.reviews.at(-1)?.goal.id,'investigate-local-route');assert.equal(director.memory.reviews.at(-1)?.result,'partial');
});

test('an unresolved command still owns its execution slot even when its planner has no progress',()=>{
  const director=new Director(createMemory(identity)),decision=director.next(view(0),opportunities,methods);
  director.begin(view(0),decision,methods[0],'pending');
  assert.throws(()=>director.blocked(1000,'no progress'),/RECONCILE_PENDING_ACTION_FIRST/);
  assert.equal(director.next(view(999999),opportunities,methods).type,'reconcile');
});

function agencyFixture(t:any){
  const dir=mkdtempSync(join(tmpdir(),'exhausted-method-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  let now=1000;const route={id:'observed-service',x:15,z:10,level:0,evidence:'own observed service: ordinary access'};
  const a=new LiveAgency(join(dir,'agency.json'),identity,{supported:['exploration','production'],routes:[route],now:()=>now});
  const before=state(1),selected=a.plan(before);assert.ok(isSelection(selected));assert.equal(selected.task.id,'survey:'+route.id);
  a.begin(selected,{id:'local-leg',type:'walkTo',fields:{x:15,z:10,level:0}},before,'navigation-command');
  return {a,before,selected,route,setNow:(v:number)=>now=v};
}

test('a terminal navigator retry-budget refusal defers that route and allows an already feasible unrelated objective',t=>{
  const f=agencyFixture(t);f.setNow(2000);
  f.a.rememberExecution('navigation-command',{navigation:{status:'blocked',reason:'door-retry-budget',movementDispatched:false}});
  f.a.record('navigation-command',state(2),{status:'interrupted',reason:'navigator preparation ended without a movement dispatch: door-retry-budget',evidence:['navigator preparation ended without a movement dispatch: door-retry-budget']});
  assert.equal(f.a.pending(),undefined);assert.equal(f.a.director.memory.active,undefined);
  assert.match(f.a.director.memory.reviews.at(-1)!.reason,/NAVIGATION_APPROACH_EXHAUSTED/);
  const next=f.a.plan(state(3));assert.ok(isSelection(next));assert.equal(next.task.kind,'production');
  assert.equal(f.a.director.memory.learningRevision??0,0);assert.equal(f.a.summary().progressHealth.lastProductiveAt,null);
});

test('a loading-map observation never becomes exhausted navigation or arrival',t=>{
  const f=agencyFixture(t);f.setNow(2000);
  f.a.rememberExecution('navigation-command',{navigation:{status:'loading-map',movementDispatched:false}});
  f.a.record('navigation-command',state(2),{status:'verified',evidence:['map preparation; no movement dispatch']});
  assert.equal(f.a.director.memory.active?.id,'survey:'+f.route.id);
  assert.equal(f.a.director.memory.reviews.length,0);
});

test('a retry-budget label cannot release an unverified pending command',t=>{
  const f=agencyFixture(t);f.setNow(2000);
  f.a.rememberExecution('navigation-command',{navigation:{status:'blocked',reason:'door-retry-budget'}});
  f.a.record('navigation-command',state(2),{status:'unknown',reason:'door-retry-budget',evidence:[]});
  assert.equal(f.a.pending()?.commandId,'navigation-command');assert.equal(f.a.director.memory.reviews.length,0);
});

function memoryWithReview(id:string,at:number):any {
  const memory:any=createMemory(identity);
  memory.progress={since:1,lastProductiveAt:at,lastVerifiedActionAt:at,noProgressActions:0,cycleDetected:false};
  memory.reviews=[{at,result:'success',goal:{id,domain:'exploration',context:'old-context'},reason:'Verified outcome',evidence:['own-result']}];
  return memory;
}

test('a successful discovery probe can continue its bounded episode, but ordinary productive work cannot activate bootstrap',()=>{
  const now=100000;
  const continuation=buildCatalogue(identity,state(10),emptyKnowledge(),defaultPolicy,['exploration'],memoryWithReview('survey:local-probe:7:10:0',now-1000),now);
  assert.ok(continuation.opportunities.some(o=>o.id.startsWith('survey:local-probe:')));
  const ordinary=buildCatalogue(identity,state(10),emptyKnowledge(),defaultPolicy,['exploration'],memoryWithReview('production-batch',now-1000),now);
  assert.equal(ordinary.opportunities.some(o=>o.id.startsWith('survey:local-probe:')),false);
});

test('discovery budget exhaustion is explicit and does not hide normal feasible goals; probes become eligible after the budget window',()=>{
  const memory=memoryWithReview('survey:local-probe:7:10:0',90000);
  memory.reviews.push({at:95000,result:'partial',goal:{id:'survey:local-probe:10:7:0',domain:'exploration',context:'old-context'},reason:'Exhausted approach',evidence:['route-refusal']});
  const k=emptyKnowledge(),c=buildCatalogue(identity,state(10),k,defaultPolicy,['exploration','production'],memory,100000);
  assert.equal(c.opportunities.some(o=>o.id.startsWith('survey:local-probe:')),false);
  assert.equal(c.discovery?.nextProbeAt,690000);
  assert.ok(c.opportunities.some(o=>o.id==='production-batch'));
  const next=new Director(memory).next(c.view,c.opportunities,c.methods);assert.equal(next.type,'execute');
  assert.equal(memory.active?.id,'production-batch');delete memory.active;
  const renewed=buildCatalogue(identity,state(11),k,defaultPolicy,['exploration'],memory,690001);
  assert.ok(renewed.opportunities.some(o=>o.id.startsWith('survey:local-probe:')));
});
