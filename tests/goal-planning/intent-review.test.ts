import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadSourceCatalogue } from '../../src/catalog/source-catalogue.ts';
import { Director, createMemory } from '../../src/agency/director.ts';
import { buildGoalReadiness, GOAL_SETTINGS_PATH, readGoalSettings } from '../../src/agency/goal-readiness.ts';
import { SourceResources, SOURCE_CONFIG } from '../../src/agency/source-resources.ts';
import { emptyKnowledge, defaultPolicy, type Catalogue, type Route } from '../../src/agency/world-model.ts';
import { applyIntentPolicy, currentPurpose, intentionReviewSafe } from '../../src/agency/goal-intents.ts';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';
import { summarizeGoalRuntime, readGoalRuntime } from '../../src/agency/goal-status.ts';
const SOURCE=process.env.CLAWSCAPE_SOURCE_CATALOGUE??resolve(import.meta.dirname,'../../data/catalog/clawscape-source-20260921');
const identity={agent:'featherer',world:'clawscape',revision:'fixture'},now=1_000_000;
let source:ReturnType<typeof loadSourceCatalogue>,root:string,serial=0;
before(()=>{source=loadSourceCatalogue(SOURCE);root=mkdtempSync(join(tmpdir(),'intent-review-'));cpSync(SOURCE,join(root,'data/catalog/source'),{recursive:true});});
after(()=>rmSync(root,{recursive:true,force:true}));
const config=()=>({version:1,directory:'data/catalog/source',mode:'shadow',pilotAgents:[],maxActions:40,maxSpendGp:100});
const configure=(intentMode:'shadow'|'enforce'='enforce')=>{writeFileSync(join(root,GOAL_SETTINGS_PATH),JSON.stringify({version:1,mode:'shadow',intentMode}));writeFileSync(join(root,SOURCE_CONFIG),JSON.stringify(config()));};
const route:Route={id:'inherited-destination',x:3250,z:3200,level:0,evidence:'bundled route lead; arrival not yet personally verified'};
const state=(extra:any={}):any=>({character:identity.agent,world:identity.world,inGame:true,tick:1,members:true,capacity:28,
 player:{lifeId:1,worldX:3200,worldZ:3200,level:0,hp:30,maxHp:30,isDead:false,combat:{inCombat:false}},
 inventory:[],equipment:[],skills:[{name:'fishing',level:1,baseLevel:1,currentLevel:1,experience:0}],bank:{isOpen:false,items:[]},
 shop:{isOpen:false},dialog:{isOpen:false},nearbyLocs:[],nearbyNpcs:[],groundItems:[],...extra});
function catalogue():Catalogue{return {view:{...identity,at:now,context:'fixture',facts:{},capabilities:['exploration'],
 budget:{spendableGp:100,maxLossGp:0,maxDeaths:0,maxDurationMs:600000}},methods:[],opportunities:[],tasks:new Map()};}
function seeded(){const c=catalogue(),k=emptyKnowledge(),memory=createMemory(identity);k.routes[route.id]={...route};
 const id='survey:'+route.id;c.methods.push({id,capability:'exploration',domain:'exploration',prerequisites:[],effects:{['visited:'+route.id]:1},costGp:0,lossBoundGp:0,durationMs:1000,risk:'safe'});
 c.opportunities.push({id,domain:'exploration',target:{fact:'visited:'+route.id,minimum:1},source:'frontier',reason:'Visit a seeded lead',evidence:[route.evidence]});
 c.tasks.set(id,{id,kind:'exploration',route});return {c,k,memory};}
function agency(initial:'shadow'|'enforce'='shadow'){
 configure(initial);const file=join(root,'data','case-'+(++serial),'agency-v2.json');let time=now;
 const a=new LiveAgency(file,identity,{supported:['exploration'],routes:[route],sourceCatalogueRoot:root,now:()=>time});
 const s=state(),c=a.catalogue(s),goal=c.opportunities.find(g=>g.id==='survey:'+route.id);
 if(initial==='shadow'){assert.ok(goal);const decision=a.director.next(c.view,[goal],c.methods);assert.equal(decision.type,'execute');}
 return {a,file,s,setTime:(value:number)=>time=value};
}

test('intention policy can enforce with both action gates in shadow and XP unconfirmed',()=>{
 configure();const x=seeded(),bridge=new SourceResources(root,join(root,'data/bridge/agency-v2.json'),identity,()=>now),before=JSON.stringify(x.memory),knowledge=JSON.stringify(x.k);
 bridge.augment(x.c,state(),x.k,undefined,defaultPolicy,x.memory);
 assert.equal(x.c.intentPolicyEnabled,true);assert.equal(x.c.opportunities.length,0);assert.equal(x.c.methods.length,0);assert.equal(x.c.view.goalPlanning,undefined);
 assert.equal(JSON.stringify(x.memory),before);assert.equal(JSON.stringify(x.k),knowledge);
 assert.equal(x.c.methods.some(m=>m.id.startsWith('source:')),false);
});
test('filter runs again inside the diagnostic throttle window so seed regeneration cannot leak through',()=>{
 configure();let clock=now;const bridge=new SourceResources(root,join(root,'data/cadence/agency-v2.json'),identity,()=>clock);
 for(let n=0;n<3;n++){const x=seeded();bridge.augment(x.c,state({tick:n+1}),x.k,undefined,defaultPolicy,x.memory);assert.equal(x.c.methods.length,0);clock+=1;}
});
test('shadow intention setting makes no catalogue or memory changes',()=>{
 configure('shadow');const x=seeded(),bridge=new SourceResources(root,join(root,'data/shadow/agency-v2.json'),identity,()=>now);
 const memory=JSON.stringify(x.memory);bridge.augment(x.c,state(),x.k,undefined,defaultPolicy,x.memory);
 assert.equal(x.c.methods.length,1);assert.equal(x.c.opportunities.length,1);assert.equal(x.c.intentPolicyEnabled,undefined);assert.equal(JSON.stringify(x.memory),memory);
});
test('runtime retires old active seed intention and retains its knowledge and method learning',()=>{
 const {a,file,s}=agency();const methods=JSON.stringify(a.director.memory.methods);configure();a.plan(s);
 assert.notEqual(a.director.memory.active?.id,'survey:'+route.id);assert.equal(a.director.memory.intentPolicy?.archived[0]?.goalId,'survey:'+route.id);
 const saved=JSON.parse(readFileSync(file,'utf8'));assert.ok(saved.knowledge.routes[route.id]);assert.equal(saved.knowledge.visited[route.id],undefined);
 assert.equal(JSON.stringify(a.director.memory.methods),methods);assert.equal(a.director.memory.reviews[0]?.result,'partial');
});
test('restart does not regenerate or erase the archived intention',()=>{
 const {a,file,s}=agency();configure();a.plan(s);
 const restored=new LiveAgency(file,identity,{supported:['exploration'],routes:[route],sourceCatalogueRoot:root,now:()=>now+1});
 restored.plan({...s,tick:2});assert.notEqual(restored.director.memory.active?.id,'survey:'+route.id);assert.equal(restored.director.memory.intentPolicy?.archived.length,1);
});
test('a stale pre-filter selection cannot dispatch after intentions are enabled',()=>{
 const {a,s}=agency();const c=a.catalogue(s),goal=a.director.memory.active!,decision=a.director.next(c.view,[goal],c.methods);
 assert.equal(decision.type,'execute');if(decision.type!=='execute')return;
 const method=c.methods.find(m=>m.id===decision.step.methodId)!,task=c.tasks.get(method.id)!;
 configure();assert.throws(()=>a.begin({decision,method,task,view:c.view},{id:'old-walk',type:'walkTo',fields:{x:route.x,z:route.z,level:route.level}},s,'never-dispatched'),/INTENTION_REVIEW_REQUIRED/);
 assert.equal(a.pending(),undefined);assert.equal(a.director.memory.pending,undefined);
});
test('a real pending task receipt is preserved when the filter activates',()=>{
 const {a,s}=agency();const c=a.catalogue(s),decision=a.director.next(c.view,[a.director.memory.active!],c.methods);assert.equal(decision.type,'execute');if(decision.type!=='execute')return;
 const method=c.methods.find(m=>m.id===decision.step.methodId)!,task=c.tasks.get(method.id)!;
 a.begin({decision,method,task,view:c.view},{id:'prior-walk',type:'walkTo',fields:{x:route.x,z:route.z,level:route.level}},s,'pending-walk');
 configure();const result=a.plan({...s,tick:2});assert.equal('type'in result&&result.type,'reconcile');assert.ok(a.pending());assert.equal(a.director.memory.active?.id,'survey:'+route.id);
 assert.equal(a.director.memory.intentPolicy?.archived.length??0,0);
});
test('a Director pending command without a task receipt still prevents retirement',()=>{
 const {a,s}=agency(),c=a.catalogue(s),decision=a.director.next(c.view,[a.director.memory.active!],c.methods);
 a.director.begin(c.view,decision,c.methods.find(m=>m.id===(decision as any).step.methodId)!,'director-pending');configure();
 const result=a.plan(s);assert.equal('type'in result&&result.type,'reconcile');assert.ok(a.director.memory.pending);assert.equal(a.director.memory.active?.id,'survey:'+route.id);
});
test('a pending safety receipt prevents retirement without clearing its history',()=>{
 const {a,s}=agency();a.beginSafety({id:'emergency',type:'retreat'},state({player:{...s.player,hp:1}}),'safety-pending');configure();
 const result=a.plan(s);assert.equal('type'in result&&result.type,'blocked');assert.ok(a.pending('safety'));assert.equal(a.director.memory.active?.id,'survey:'+route.id);
});
test('combat, death, danger and offline observations cannot authorize intention retirement',()=>{
 assert.equal(intentionReviewSafe(state()),true);
 for(const s of [state({inGame:false}),state({danger:{active:true}}),state({player:{hp:0}}),state({player:{hp:30,isDead:true}}),state({player:{hp:30,combat:{inCombat:true}}})])assert.equal(intentionReviewSafe(s),false);
 const {a,s}=agency();configure();a.plan({...s,player:{...s.player,combat:{inCombat:true}}});assert.equal(a.director.memory.intentPolicy?.archived.length??0,0);
});
test('an explicit operator destination survives the generic filter',()=>{
 const x=seeded();x.c.opportunities[0]!.evidence.push('operator-resource-request');assert.deepEqual(applyIntentPolicy(x.c,x.k,x.memory,now),[]);
});
test('a justified resource purpose preserves the same destination without a name exception',()=>{
 const x=seeded();x.k.routes[route.id]!.purpose={kind:'resource',reason:'Resolve a current input deficit',evidence:['own-resource-deficit'],expiresAt:now+60000};
 assert.deepEqual(applyIntentPolicy(x.c,x.k,x.memory,now),[]);assert.equal(x.c.opportunities[0]!.reason,'Resolve a current input deficit');
});
test('purpose expiry reinstates review rather than creating a permanent permission',()=>{
 const x=seeded();x.k.routes[route.id]!.purpose={kind:'resource',reason:'temporary',evidence:['own-resource-deficit'],expiresAt:now};
 assert.equal(currentPurpose(x.k.routes[route.id]!,now),false);assert.equal(applyIntentPolicy(x.c,x.k,x.memory,now).length,1);
});
test('malformed purpose is not accepted as a reason to keep an inherited goal',()=>{
 for(const purpose of [{kind:'resource',reason:4,evidence:['x'],expiresAt:now+100},{kind:'resource',reason:'x',evidence:'x',expiresAt:now+100},{kind:'resource',reason:'x',evidence:[''],expiresAt:now+100}])
  assert.equal(currentPurpose({...route,purpose} as any,now),false);
});
test('real observed exploration is not deleted merely because an old seed is filtered',()=>{
 const x=seeded();x.k.routes[route.id]!.evidence='own-transition:1:1:open';assert.deepEqual(applyIntentPolicy(x.c,x.k,x.memory,now),[]);
});
test('purposeful current investigation can revisit a seed under its actual parent',()=>{
 const x=seeded(),d=new Director(x.memory);d.next(x.c.view,x.c.opportunities,x.c.methods);x.memory.active!.id='production-parent';x.memory.active!.target={fact:'inputs',minimum:1};
 x.memory.active!.investigation={...x.c.opportunities[0]!,source:'investigation',investigates:['inputs'],reason:'Find an observed input source',evidence:['own-missing-input']};
 assert.deepEqual(applyIntentPolicy(x.c,x.k,x.memory,now),[]);
 x.memory.active!.investigation!.investigates=['unrelated'];assert.equal(applyIntentPolicy(x.c,x.k,x.memory,now).length,1);
});
test('an old saved seed leaf without support records is removed but its productive parent remains',()=>{
 const x=seeded(),d=new Director(x.memory);d.next(x.c.view,x.c.opportunities,x.c.methods);x.memory.active!.id='production-parent';
 const key=x.memory.active!.key;d.retireUnjustifiedIntents(new Set(['survey:'+route.id]),now);
 assert.equal(x.memory.active!.key,key);assert.equal(x.memory.active!.plan,undefined);assert.equal(x.memory.intentPolicy!.archived[0]!.goalId,'survey:'+route.id);
});
test('invalid intention mode is rejected rather than activating either gate',()=>{
 configure();writeFileSync(join(root,GOAL_SETTINGS_PATH),JSON.stringify({version:1,mode:'shadow',intentMode:'yes'}));assert.throws(()=>readGoalSettings(root),/INVALID_GOAL_PLANNING_SETTINGS/);
});
test('report separates intention mode, source count, total methods and forecast from dispatch',()=>{
 const x=seeded(),cfg=config() as any,r=buildGoalReadiness(source,x.c,state(),x.k,undefined,defaultPolicy,x.memory,cfg,{version:1,mode:'shadow',intentMode:'enforce'},now,false);
 assert.equal(r.report.enabled,false);assert.equal(r.report.intentionPolicy.enabled,true);assert.equal(r.report.xp.confirmedRate,null);
 assert.equal(r.report.forecastIsNotDispatch,true);assert.equal(r.report.methodCounts.source,0);assert.equal(r.report.methodCounts.legacy,1);assert.equal(r.report.observation.skills[0]!.baseLevel,1);
});
function document(){return {version:2,memory:createMemory(identity),updatedAt:now,lastObservation:{at:now,tick:10,connected:true,position:{x:1,z:2,level:0}}};}
test('runtime summary reports saved state without asserting a live process is running',()=>{
 const d=document(),r=summarizeGoalRuntime(d,identity.agent,now);assert.equal(r.status,'reported-no-active-goal');assert.equal(r.isLiveProcessCheck,false);assert.equal(r.progress,null);
});
test('active goal, planned leaf, pending action and forecast remain distinct',()=>{
 const x=seeded(),director=new Director(x.memory);director.next(x.c.view,x.c.opportunities,x.c.methods);
 const d:any={...document(),memory:x.memory,receipt:{scope:'task',commandId:'one',action:{type:'walkTo'},startedAt:now}};
 const summary=summarizeGoalRuntime(d,identity.agent,now);assert.equal(summary.status,'reported-pending-reconciliation');assert.equal(summary.pendingAction.type,'walkTo');assert.equal(summary.activeGoal.id,'survey:'+route.id);
});
test('stale/future/missing own observations are not reported as healthy',()=>{
 const d=document();for(const at of [now-61000,now+6000]){d.lastObservation.at=at;assert.equal(summarizeGoalRuntime(d,identity.agent,now).stale,true);}
 assert.equal(summarizeGoalRuntime({...d,lastObservation:undefined},identity.agent,now).status,'stale-or-missing-observation');
});
test('runtime summary rejects another character and exposes missing file honestly',()=>{
 assert.throws(()=>summarizeGoalRuntime(document(),'other',now),/IDENTITY/);assert.equal(readGoalRuntime(join(root,'absent.json'),identity.agent,now).available,false);
});
test('corrupt runtime file yields bounded error metadata rather than a success status',()=>{
 const f=join(root,'corrupt.json');writeFileSync(f,'{');const x=readGoalRuntime(f,identity.agent,now);assert.equal(x.available,false);assert.ok(x.error);
});

test('an explicit operator support destination is preserved under a different parent',()=>{
 const x=seeded(),d=new Director(x.memory);d.next(x.c.view,x.c.opportunities,x.c.methods);x.memory.active!.id='productive-parent';
 x.memory.active!.requestedSupport={target:{fact:'visited:'+route.id,minimum:1},reason:'Explicit user destination',evidence:['user-issued:visit']};
 assert.deepEqual(applyIntentPolicy(x.c,x.k,x.memory,now),[]);
});
test('an obsolete unissued visit support is cancelled without replacing its productive parent',()=>{
 const x=seeded(),d=new Director(x.memory);d.next(x.c.view,x.c.opportunities,x.c.methods);x.memory.active!.id='productive-parent';
 x.memory.active!.requestedSupport={target:{fact:'visited:'+route.id,minimum:1},reason:'Inherited direction',evidence:['bundled route lead; unverified']};
 d.retireUnjustifiedIntents(new Set(['survey:'+route.id]),now);assert.equal(x.memory.active!.id,'productive-parent');assert.equal(x.memory.active!.requestedSupport,undefined);
});
test('after pending command is reconciled the next planner turn can retire the old goal',()=>{
 const {a,s}=agency(),c=a.catalogue(s),decision=a.director.next(c.view,[a.director.memory.active!],c.methods);
 a.director.begin(c.view,decision,c.methods.find(m=>m.id===(decision as any).step.methodId)!,'recorded-pending');configure();
 a.plan(s);assert.equal(a.director.memory.active?.id,'survey:'+route.id);
 // Simulate the existing reconciliation layer clearing its terminal command. The policy never clears it.
 delete a.director.memory.pending;a.plan({...s,tick:2});assert.notEqual(a.director.memory.active?.id,'survey:'+route.id);
 assert.equal(a.director.memory.intentPolicy?.archived.length,1);
});
