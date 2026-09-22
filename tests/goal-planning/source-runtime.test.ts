import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { loadSourceCatalogue } from '../../src/catalog/source-catalogue.ts';
import { createMemory, makePlan, Director } from '../../src/agency/director.ts';
import { buildGoalReadiness, GOAL_SETTINGS_PATH, readGoalSettings, classifyBlocker } from '../../src/agency/goal-readiness.ts';
import { preparationContext, SOURCE_XP_DATA, recipeXp } from '../../src/agency/goal-xp.ts';
import { SourceResources, SOURCE_CONFIG } from '../../src/agency/source-resources.ts';
import { emptyKnowledge, defaultPolicy, type Catalogue, type Route } from '../../src/agency/world-model.ts';
import { applyIntentPolicy, currentPurpose } from '../../src/agency/goal-intents.ts';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';

const SOURCE=process.env.CLAWSCAPE_SOURCE_CATALOGUE??resolve(import.meta.dirname,'../../data/catalog/clawscape-source-20260921');
const id={agent:'stinger',world:'clawscape',revision:'test'},now=1_000_000;
let source:ReturnType<typeof loadSourceCatalogue>,root:string;
before(()=>{source=loadSourceCatalogue(SOURCE);root=mkdtempSync(join(tmpdir(),'goals-'));cpSync(SOURCE,join(root,'data/catalog/source'),{recursive:true});});
after(()=>rmSync(root,{recursive:true,force:true}));
const item=(id:number,count=1,slot=0)=>({id,name:source.item(id)?.name??String(id),count,slot});
const state=(extras:any={}):any=>({character:'stinger',world:'clawscape',inGame:true,tick:1,members:true,capacity:28,
 player:{lifeId:1,worldX:3200,worldZ:3200,level:0,hp:30,maxHp:30,isDead:false,combat:{inCombat:false}},
 inventory:[],equipment:[],skills:['smithing','mining','fletching','woodcutting','runecraft','ranged'].map(name=>({name,level:1,baseLevel:1,currentLevel:1,experience:0})),
 bank:{isOpen:false,items:[]},shop:{isOpen:false},dialog:{isOpen:false},nearbyLocs:[],nearbyNpcs:[],groundItems:[],...extras});
const config=()=>({version:1 as const,directory:'data/catalog/source',mode:'shadow' as const,pilotAgents:[],maxActions:40,maxSpendGp:100,requests:{stinger:[{item:2355,quantity:1}]}});
const settings=(mode:'shadow'|'pilot'='shadow')=>({version:1 as const,mode,xpRate:25,confirmedProfileId:source.data.profile.id});
const cat=(s:any):Catalogue=>({view:{...id,at:now,context:'fixture',facts:{},capabilities:['acquisition'],budget:{spendableGp:100,maxLossGp:0,maxDeaths:0,maxDurationMs:600_000}},methods:[],opportunities:[],tasks:new Map()});
const furnace=()=>{const recipe=source.recipes.get('recipe:smelt:silver_bar')!;const loc:any=source.locations.get(recipe.locationIds!.find(id=>(source.locations.get(id) as any).sourceTypeId===2781)!);
 return {id:2781,name:'Furnace',x:loc.coordinates.x,z:loc.coordinates.z,level:loc.coordinates.plane,reachable:true,optionsWithIndex:[{text:'Smelt',opIndex:2}]};};
const trainingState=()=>{const s=state({inventory:[item(436,1,0),item(438,1,1),item(442,1,2)],nearbyLocs:[furnace()]});
 s.skills.find((x:any)=>x.name==='smithing').level=19;s.skills.find((x:any)=>x.name==='smithing').baseLevel=19;s.skills.find((x:any)=>x.name==='smithing').currentLevel=19;
 s.skills.find((x:any)=>x.name==='smithing').experience=SOURCE_XP_DATA.thresholds['20']-10;return s;};

test('XP overlay preserves server decimal units and source default is explicitly unconfirmed',()=>{
 assert.equal(SOURCE_XP_DATA.thresholds['2'],80);assert.equal(SOURCE_XP_DATA.thresholds['99'],998458);assert.equal(SOURCE_XP_DATA.sourceDefaultXpRate,25);
 assert.equal(SOURCE_XP_DATA.recipes['recipe:smelt:bronze_bar'].rawXpTenths,62);
 assert.ok(Object.keys(SOURCE_XP_DATA.evidence).length>=10);
});
test('training activity outside the final product ancestry becomes a real prerequisite plan',()=>{
 const s=trainingState();const before=JSON.stringify(s),memory=createMemory(id),b=cat(s);
 const result=buildGoalReadiness(source,b,s,emptyKnowledge(),undefined,defaultPolicy,memory,config(),settings(),now,false);
 const plan=result.report.forecasts.find(g=>g.goalId==='source-request:2355');assert.ok(plan);assert.equal(plan.status,'needs-preparation');
 assert.equal(result.catalogue.tasks.get(plan.next!.methodId)?.sourceResource?.recipeId,'recipe:smelt:bronze_bar');
 assert.ok(plan.subgoals.some(x=>x.fact==='level:smithing'&&x.minimum===20));
 assert.equal(result.enabled,false);assert.equal(b.methods.length,0);assert.equal(memory.active,undefined);assert.equal(JSON.stringify(s),before);
});
test('prepared XP uses lower bounds, not the old +1 activity flag',()=>{
 const s=trainingState(),result=buildGoalReadiness(source,cat(s),s,emptyKnowledge(),undefined,defaultPolicy,createMemory(id),config(),settings(),now,false);
 const method=result.catalogue.methods.find(m=>result.catalogue.tasks.get(m.id)?.sourceResource?.recipeId==='recipe:smelt:bronze_bar')!;
 assert.equal(method.effects['xp:smithing'],155);assert.equal(method.training?.maximumXp?.smithing,155);
});
test('unconfirmed live XP rate yields a specific information gap and never training authorization',()=>{
 const s=trainingState(),result=buildGoalReadiness(source,cat(s),s,emptyKnowledge(),undefined,defaultPolicy,createMemory(id),config(),{version:1,mode:'shadow'},now,false);
 assert.equal(result.report.xp.confirmedRate,null);assert.equal(result.report.forecasts[0]!.status,'blocked');
 assert.ok(result.report.forecasts[0]!.blockers.some(b=>b.kind==='needs-information'));assert.equal(result.enabled,false);
});
test('boosted or inconsistent XP/levels cannot support projected level gains',()=>{
 const s=state();s.skills[0].level=40;const v=cat(s).view;
 const context=preparationContext(source,s,v,{profileId:source.data.profile.id,xpRate:25});assert.equal(context.skillModels.smithing,undefined);
});
test('membership unknown and confirmed false remain distinct and neither grants access',()=>{
 const s=state();delete s.members;
 assert.equal(classifyBlocker('recipe','Unverified or unmet flag: world.members',s,config()).kind,'needs-information');
 s.members=false;assert.equal(classifyBlocker('recipe','Unverified or unmet flag: world.members',s,config()).kind,'prohibited');
});
test('missing software adapter is not classified as insufficient character skill',()=>{
 assert.equal(classifyBlocker('recipe','executor not integrated: smith-at-anvil',state(),config()).kind,'implementation-gap');
 assert.equal(classifyBlocker('recipe','smithing requires 30, observed 1',state(),config()).kind,'needs-training');
});
test('both independent rollout gates must authorize any enhanced runtime behavior',()=>{
 const s=trainingState(),f=(mode:'shadow'|'pilot',sourceGate:boolean)=>buildGoalReadiness(source,cat(s),s,emptyKnowledge(),undefined,defaultPolicy,createMemory(id),config(),settings(mode),now,sourceGate);
 assert.equal(f('shadow',true).enabled,false);assert.equal(f('pilot',false).enabled,false);assert.equal(f('pilot',true).enabled,true);
});
test('settings reject unknown rate values and a pilot without source confirmation',()=>{
 const p=join(root,GOAL_SETTINGS_PATH);writeFileSync(p,JSON.stringify({version:1,mode:'pilot'}));assert.throws(()=>readGoalSettings(root));
 writeFileSync(p,JSON.stringify({version:1,mode:'shadow',xpRate:-1}));assert.throws(()=>readGoalSettings(root));
 rmSync(p);
});
const route:Route={id:'old-example-destination',x:10,z:10,level:0,evidence:'bundled route lead; arrival not yet personally verified'};
function seeded(){const k=emptyKnowledge();k.routes[route.id]={...route};const c=cat(state());
 c.opportunities.push({id:'survey:'+route.id,domain:'exploration',target:{fact:'visited:'+route.id,minimum:1},source:'frontier',reason:'seed',evidence:[route.evidence]});
 c.methods.push({id:'survey:'+route.id,capability:'exploration',domain:'exploration',prerequisites:[],effects:{['visited:'+route.id]:1},costGp:0,lossBoundGp:0,durationMs:1000,risk:'safe'});
 c.tasks.set('survey:'+route.id,{id:'survey:'+route.id,kind:'exploration',route});c.view.capabilities.push('exploration');return {c,k,memory:createMemory(id)};}
test('a bundled route is retained as knowledge but not promoted into an intention',()=>{
 const {c,k,memory}=seeded(),before=JSON.stringify(k);assert.deepEqual(applyIntentPolicy(c,k,memory,now),['survey:'+route.id]);
 assert.equal(c.opportunities.length,0);assert.equal(c.methods.length,0);assert.equal(JSON.stringify(k),before);
});
test('the same old destination can be chosen again for a fresh bounded purpose',()=>{
 const {c,k,memory}=seeded();k.routes[route.id]!.purpose={kind:'curiosity',reason:'Resolve a currently chosen information gap',evidence:['own-current-observation'],expiresAt:now+60000};
 assert.deepEqual(applyIntentPolicy(c,k,memory,now),[]);assert.equal(c.opportunities.length,1);assert.match(c.opportunities[0]!.reason,/information gap/);
});
test('expired purposes are not endless mandates and real observed exploration remains eligible',()=>{
 const {c,k,memory}=seeded();k.routes[route.id]!.purpose={kind:'curiosity',reason:'old',evidence:['past'],expiresAt:now-1};
 assert.equal(currentPurpose(k.routes[route.id]!,now),false);k.routes[route.id]!.evidence='own-transition:7:1:open';
 assert.deepEqual(applyIntentPolicy(c,k,memory,now),[]);
});
test('retirement is idempotent, persistent, and does not infer arrival or erase learning',()=>{
 const {c,k,memory}=seeded(),d=new Director(memory);d.next(c.view,c.opportunities,c.methods);
 const ids=new Set(applyIntentPolicy(c,k,memory,now));d.retireUnjustifiedIntents(ids,now);
 assert.equal(d.memory.active,undefined);assert.equal(d.memory.reviews.at(-1)?.result,'partial');assert.equal(d.memory.intentPolicy?.archived.length,1);
 const restored=new Director(JSON.parse(JSON.stringify(d.memory)));restored.retireUnjustifiedIntents(ids,now+1);assert.equal(restored.memory.intentPolicy?.archived.length,1);
 assert.ok(k.routes[route.id]);assert.equal(k.visited[route.id],undefined);
});
test('a pending command or an explicit operator goal is not retired by seed migration',()=>{
 const {c,k,memory}=seeded(),d=new Director(memory),decision=d.next(c.view,c.opportunities,c.methods);d.begin(c.view,decision,c.methods[0]!,'cmd');
 d.retireUnjustifiedIntents(new Set(['survey:'+route.id]),now);assert.ok(d.memory.active);assert.ok(d.memory.pending);
 const other=seeded();other.c.opportunities[0]!.evidence.push('operator-resource-request');assert.deepEqual(applyIntentPolicy(other.c,other.k,other.memory,now),[]);
});
test('live bridge shadow writes a diagnostic report without changing planner methods or memory',()=>{
 const p=join(root,GOAL_SETTINGS_PATH);writeFileSync(p,JSON.stringify(settings()));writeFileSync(join(root,SOURCE_CONFIG),JSON.stringify(config()));
 const agentFile=join(root,'data/test-shadow/agency-v2.json'),b=new SourceResources(root,agentFile,id,()=>now),s=trainingState(),c=cat(s),memory=createMemory(id),before=JSON.stringify(memory);
 b.augment(c,s,emptyKnowledge(),undefined,defaultPolicy,memory);
 assert.equal(c.methods.length,0);assert.equal(c.view.goalPlanning,undefined);assert.equal(JSON.stringify(memory),before);
 const report=JSON.parse(readFileSync(join(dirname(agentFile),'goal-planning-report.json'),'utf8'));assert.equal(report.version,'goal-prerequisites-20260922.3');assert.equal(report.enabled,false);
});
test('live agency pilot selects a concrete training recipe under the original item parent',()=>{
 writeFileSync(join(root,GOAL_SETTINGS_PATH),JSON.stringify(settings('pilot')));
 writeFileSync(join(root,SOURCE_CONFIG),JSON.stringify({...config(),mode:'pilot',pilotAgents:['stinger'],members:true,confirmedWorld:'clawscape',confirmedProfileId:source.data.profile.id,pilotId:'fixture-pilot-123',expiresAt:now+600000}));
 const a=new LiveAgency(join(root,'data/test-pilot/agency-v2.json'),id,{supported:['acquisition'],sourceCatalogueRoot:root,now:()=>now});
 const choice=a.plan(trainingState());assert.equal(isSelection(choice),true);if(!isSelection(choice))return;
 assert.equal(choice.task.sourceResource?.recipeId,'recipe:smelt:bronze_bar');assert.equal(choice.decision.goal.id,'source-request:2355');
 assert.ok(choice.decision.goal.supportGoals?.some(s=>s.target.fact==='level:smithing'));
});

test('invalid prerequisite configuration fails closed even during a valid source pilot',()=>{
 writeFileSync(join(root,GOAL_SETTINGS_PATH),JSON.stringify({version:1,mode:'pilot'}));
 writeFileSync(join(root,SOURCE_CONFIG),JSON.stringify({...config(),mode:'pilot',pilotAgents:['stinger'],members:true,confirmedWorld:'clawscape',confirmedProfileId:source.data.profile.id,pilotId:'fixture-pilot-456',expiresAt:now+600000}));
 const b=new SourceResources(root,join(root,'data/test-bad-config/agency-v2.json'),id,()=>now),s=trainingState(),c=cat(s);
 b.augment(c,s,emptyKnowledge(),undefined,defaultPolicy,createMemory(id));assert.equal(c.methods.length,0);assert.equal(c.view.goalPlanning,undefined);
});
