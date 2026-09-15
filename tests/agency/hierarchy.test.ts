import { seedProvisionHistory } from './provision-fixture.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Director,createMemory} from '../../src/agency/director.ts';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import type {Method,Observation,Opportunity} from '../../src/agency/types.ts';
import {inspectAgency} from '../../scripts/agency-status.ts';
const id={agent:'test',world:'test',revision:'v1'};
const view=(facts:Record<string,number>={},at=1000):Observation=>({...id,at,context:'kit-1',facts,capabilities:['gather','craft','explore'],
  budget:{spendableGp:100,maxLossGp:20,maxDeaths:1,maxDurationMs:60_000}});
const method=(id:string,effects:Record<string,number>,prerequisites:Method['prerequisites']=[]):Method=>({id,capability:'craft',domain:'crafting',effects,prerequisites,costGp:0,lossBoundGp:0,durationMs:1000,risk:'safe'});
const goal:Opportunity={id:'make-two-bows',domain:'crafting',target:{fact:'bows',minimum:2},reason:'Collect two useful examples of the known recipe.',source:'collection',evidence:['own-recipe']};
const methods=[method('wood',{wood:2}),{...method('bow',{bows:1}),consumes:{wood:2}}];
function recorded(d:Director,command:string,seq:number,facts:Record<string,number>,status:'verified'|'rejected'|'interrupted'='verified'){
  d.record({commandId:command,sequence:seq,at:1000+seq*1000,status,facts,spentGp:0,lostGp:0,deaths:0,elapsedMs:1000,evidence:['attributed-observation']});
}

test('dependency methods have explicit support nodes beneath one outcome goal',()=>{
  const d=new Director(createMemory(id));const decision=d.next(view(),[goal],methods);
  assert.equal(decision.type,'execute');if(decision.type!=='execute')return;
  assert.equal(decision.goal.id,goal.id);assert.equal(decision.step.methodId,'wood');
  const support=decision.goal.supportGoals!.find(n=>n.id===decision.step.supportGoalId)!;
  assert.equal(support.parentId,decision.goal.key);assert.deepEqual(support.target,{fact:'wood',minimum:2});
  assert.equal(support.status,'active');assert.equal(decision.step.goalKey,decision.goal.key);
  d.begin(view(),decision,methods[0]!,'wood');recorded(d,'wood',1,{wood:2});
  assert.equal(d.memory.reviews.length,0);assert.equal(d.memory.active?.supportGoals?.[0]?.status,'satisfied');
  const after=d.next(view({wood:2},2000),[goal],methods);
  assert.equal(after.type==='execute'&&after.step.methodId,'bow');assert.equal(d.memory.active?.key,decision.goal.key);
});

test('unavailable steps retain the parent, its spending and its exact outcome across restart',()=>{
  let d=new Director(createMemory(id));const first=d.next(view(),[goal],methods);assert.equal(first.type,'execute');
  d.memory.active!.spentGp=7;d.blocked(1100,'The observed resource is temporarily unavailable.');
  assert.equal(d.memory.reviews.length,0);const key=d.memory.active!.key;
  d=new Director(JSON.parse(JSON.stringify(d.memory)));
  const next=d.next(view({},1200),[goal],methods);assert.equal(next.type,'blocked');
  assert.equal(d.memory.active!.key,key);assert.equal(d.memory.active!.spentGp,7);assert.equal(d.memory.reviews.length,0);
  const later=d.next({...view({},1300),context:'better-tool'},[goal],methods);
  assert.equal(later.type,'execute');assert.equal(d.memory.active!.key,key);
});

test('a sourced investigation is a support goal, and completing it does not finish the parent',()=>{
  const d=new Director(createMemory(id));d.next(view(),[goal],methods);d.blocked(1100,'Need a usable resource method.');
  const lead:Opportunity={id:'survey-alternative',domain:'exploration',target:{fact:'visited',minimum:1},reason:'Investigate an observed nearby resource lead.',source:'investigation',investigates:[goal.target.fact],evidence:['own-location']};
  const survey={...method('survey',{visited:1}),capability:'explore',domain:'exploration' as const};
  const p=d.next(view({},1200),[goal,lead],[...methods,survey]);assert.equal(p.type,'execute');if(p.type!=='execute')return;
  assert.equal(p.goal.id,goal.id);assert.equal(p.step.methodId,'survey');assert.ok(p.step.supportGoalId);
  assert.equal(p.goal.supportGoals?.find(s=>s.id===p.step.supportGoalId)?.purpose,'investigate-blocker');
  d.begin(view({},1200),p,survey,'survey');recorded(d,'survey',1,{visited:1});assert.equal(d.memory.reviews.length,0);
  const retry=d.next({...view({visited:1},3000),knowledgeRevision:d.memory.learningRevision},[goal,lead],[...methods,survey]);
  assert.equal(retry.type==='execute'&&retry.step.methodId,'wood');assert.equal(d.memory.active!.id,goal.id);
});

test('synthetic action predicates cannot be installed as goals or learned effects',()=>{
  for(const fact of ['action:open-bank','goal:attack']) {
    const d=new Director(createMemory(id));
    const result=d.next(view(),[{...goal,target:{fact,minimum:1}}],[method('fake',{[fact]:1})]);
    assert.equal(result.type,'blocked');assert.equal(d.memory.active,undefined);
  }
});

test('partial movement cannot complete production or refill an economic budget',()=>{
  const d=new Director(createMemory(id));const p=d.next(view(),[goal],methods);d.begin(view(),p,methods[0]!,'move');
  d.record({commandId:'move',sequence:1,at:2000,status:'progress',facts:{x:20},spentGp:0,lostGp:0,deaths:0,elapsedMs:1000,evidence:['movement-leg']});
  assert.equal(d.memory.reviews.length,0);assert.equal(d.memory.active!.budget.spendableGp,100);
  assert.equal(d.memory.active!.lastObjectiveProgressAt,undefined);
});

test('repeated non-exploration preparation is not mistaken for productive progress',()=>{
  const d=new Director(createMemory(id));
  let p=d.next(view(),[goal],methods);assert.equal(p.type,'execute');
  for(let n=1;n<=3;n++) {
    if(p.type!=='execute')break;
    d.begin(view({},1000+n*1000),p,methods[0]!,`prep-${n}`);
    d.record({commandId:`prep-${n}`,sequence:n,at:1000+n*1000,status:'progress',facts:{},spentGp:0,lostGp:0,deaths:0,elapsedMs:1000,evidence:['preparation-observed']});
    if(n<3)p=d.next(view({},2000+n*1000),[goal],methods);
  }
  assert.ok(d.memory.active?.blocker);
  d.memory.active!.budget.maxDurationMs=200_000;
  assert.equal(d.next(view({},34001),[goal],methods).type,'blocked');
  assert.equal(d.next(view({},64001),[goal],methods).type,'blocked');
  d.next(view({},94001),[goal],methods);
  assert.equal(d.memory.active,undefined);
  assert.equal(d.memory.reviews.at(-1)?.result,'partial');
  assert.match(d.memory.reviews.at(-1)?.reason??'',/preparation chain remained non-productive/);
});

test('an interrupted method is uncertain, not disproven, and can be tested again',()=>{
  const d=new Director(createMemory(id));const p=d.next(view(),[goal],methods);d.begin(view(),p,methods[0]!,'leg');
  recorded(d,'leg',1,{},'interrupted');
  assert.equal(Object.values(d.memory.methods)[0]!.viability,'uncertain');assert.equal(Object.values(d.memory.methods)[0]!.rejected,0);
  assert.equal(d.next(view({},3000),[goal],methods).type,'blocked');
  assert.equal(d.next({...view({},3001),context:'new-capability'},[goal],methods).type,'execute');
  assert.equal(d.memory.active!.id,goal.id);
});

test('unknown transaction prevents goal switching even if knowledge and capabilities change',()=>{
  const d=new Director(createMemory(id));const p=d.next(view(),[goal],methods);d.begin(view(),p,methods[0]!,'transaction');
  d.record({commandId:'transaction',sequence:1,at:2000,status:'unknown',facts:{},spentGp:0,lostGp:0,deaths:0,elapsedMs:1000,evidence:[]});
  assert.equal(d.next({...view({},3000),context:'new',knowledgeRevision:99},[],methods).type,'reconcile');
});

const state=(extra:any={})=>({inGame:true,tick:1,player:{lifeId:1,hp:30,maxHp:30,worldX:1,worldZ:1,level:0,animId:-1,combat:{inCombat:false}},
  inventory:[],equipment:[],skills:[],...extra});
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'hierarchy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let now=1000;
  const file=join(dir,'agency.json'),options={supported:['food','funds'] as any,now:()=>now};
  seedProvisionHistory(file,id,state());
  return {dir,file,options,advance:(n:number)=>now+=n,agency:new LiveAgency(file,id,options)};}

test('fresh own bank funds enter planning, cached closed-bank balances do not',t=>{
  const {agency:a}=fixture(t);const s=state({inventory:[{id:995,count:40}],bank:{isOpen:true,items:[{id:995,count:100,slot:0}]}});
  assert.equal(a.catalogue(s).view.budget.spendableGp,115);
  s.bank.isOpen=false;assert.equal(a.catalogue(s).view.budget.spendableGp,15);
});

test('a shop cannot directly spend banked funds or consume the carried reserve',t=>{
  const {agency:a}=fixture(t);const s=state({inventory:[{id:995,count:40}],bank:{isOpen:true,items:[{id:995,count:100,slot:0}]},
    shop:{isOpen:true,shopItems:[{id:303,slot:0,count:5,buyPrice:20}]}});
  const p=a.plan(s);assert.ok(isSelection(p));assert.throws(()=>a.begin(p,{id:'purchase',type:'shopBuy',fields:{slot:0,amount:1}},s),/BUDGET/);
  assert.equal(a.pending(),undefined);
});

test('a quoted funding shortage creates a parent-linked withdrawal support goal',t=>{
  const {agency:a}=fixture(t);a.catalogue(state({bank:{isOpen:true,items:[{id:995,count:100,slot:0}]}}));
  const s=state({shop:{isOpen:true,shopItems:[{id:303,slot:0,count:5,buyPrice:5}]}});
  const first=a.plan(s);assert.ok(isSelection(first));
  assert.equal(a.prepareFunding({id:'buy-net',type:'shopBuy',fields:{slot:0,amount:1}},s),true);
  const next=a.plan(s);assert.ok(isSelection(next));assert.equal(next.decision.goal.key,first.decision.goal.key);
  assert.equal(next.task.kind,'funds');assert.equal(next.task.target?.minimum,30);assert.ok(next.decision.step.supportGoalId);
});

test('current-only diagnostics use ClawScout online profile and never import legacy fake wealth',t=>{
  const {dir}=fixture(t);mkdirSync(join(dir,'data/online'),{recursive:true});
  writeFileSync(join(dir,'data/online/agency-memory.json'),JSON.stringify({budget:{spendableGp:1000000}}));
  writeFileSync(join(dir,'data/online/agency-v2.json'),JSON.stringify({version:2,memory:{active:{id:'real',budget:{spendableGp:5}}}}));
  const text=JSON.stringify(inspectAgency(dir));assert.ok(text.includes('"spendableGp":5'));assert.ok(!text.includes('1000000'));
  assert.ok(text.includes('historicalOnly'));assert.deepEqual(JSON.parse(readFileSync(join(dir,'data/online/agency-memory.json'),'utf8')),{budget:{spendableGp:1000000}});
});

test('multi-level preparation links each support node to its real parent',()=>{
  const d=new Director(createMemory(id));
  const m=[method('find-tool',{tool:1}),method('gather-wood',{wood:2},[{fact:'tool',minimum:1}]),{...method('craft-bow',{bows:1}),consumes:{wood:2}}];
  const p=d.next(view(),[goal],m);assert.equal(p.type,'execute');if(p.type!=='execute')return;
  const tool=p.goal.supportGoals!.find(n=>n.target.fact==='tool')!;
  const wood=p.goal.supportGoals!.find(n=>n.id===tool.parentId)!;
  assert.equal(wood.target.fact,'wood');assert.equal(wood.parentId,p.goal.key);assert.equal(p.step.supportGoalId,tool.id);
});

test('invalid or negative observed cash does not become spendable money',t=>{
  const {agency:a}=fixture(t);
  for(const count of [-1,NaN,Infinity])assert.throws(()=>a.plan(state({inventory:[{id:995,count}]})),/INVALID_OBSERVATION/);
});

test('a funded support step can increase only the verified funding ceiling, not reset past spending',()=>{
  const d=new Director(createMemory(id));d.next(view(),[goal],methods);d.memory.active!.spentGp=20;
  const next={...view({},2000),funding:{carriedGp:80,bankGp:70,reserveGp:25,evidence:['own-bank-observation']},budget:{...view().budget,spendableGp:125}};
  d.next(next,[goal],methods);assert.equal(d.memory.active!.spentGp,20);assert.equal(d.memory.active!.budget.spendableGp,145);
  assert.equal(d.memory.active!.fundingGrants!.length,1);
  d.next(next,[goal],methods);assert.equal(d.memory.active!.budget.spendableGp,145);assert.equal(d.memory.active!.fundingGrants!.length,1);
});
