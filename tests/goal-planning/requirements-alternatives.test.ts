import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadSourceCatalogue } from '../../src/catalog/source-catalogue.ts';
import { requirementBranches, buildSourceMethods } from '../../src/agency/source-methods.ts';
import { classifyBlocker } from '../../src/agency/goal-readiness.ts';
import { sourceActions } from '../../src/agency/source-actions.ts';
import { createMemory } from '../../src/agency/director.ts';
import { emptyKnowledge, defaultPolicy, type Catalogue } from '../../src/agency/world-model.ts';
const SOURCE=process.env.CLAWSCAPE_SOURCE_CATALOGUE??resolve(import.meta.dirname,'../../data/catalog/clawscape-source-20260921');
let source:ReturnType<typeof loadSourceCatalogue>;
before(()=>{source=loadSourceCatalogue(SOURCE);});
const identity={agent:'stinger',world:'clawscape',revision:'fixture'};
const cfg:any={version:1,directory:'data/catalog/source',mode:'shadow',pilotAgents:[],maxActions:40,maxSpendGp:100,requests:{stinger:[{item:436,quantity:1}]}};
function state(pickaxe=1265,level=25):any{return {character:'stinger',world:'clawscape',inGame:true,tick:1,capacity:28,members:true,
 player:{lifeId:1,hp:30,maxHp:30,worldX:3200,worldZ:3200,level:0,combat:{inCombat:false}},
 inventory:pickaxe?[{id:pickaxe,count:1,slot:0}]:[],equipment:[],skills:[{name:'mining',level,baseLevel:level,currentLevel:level}],nearbyLocs:[],nearbyNpcs:[],groundItems:[],bank:{isOpen:false},shop:{isOpen:false}};}
const copper=()=>source.routes.get('gather:mine:copper_rock_table')!;
const c=():Catalogue=>({view:{...identity,at:1000,context:'fixture',facts:{},capabilities:[],budget:{spendableGp:0,maxLossGp:0,maxDeaths:0,maxDurationMs:60000}},methods:[],opportunities:[],tasks:new Map()});
function rock(s:any){const r=copper(),l:any=source.locations.get(r.locationIds![0]!);s.player.level=l.coordinates.plane;
 s.nearbyLocs=[{id:l.sourceTypeId,x:l.coordinates.x,z:l.coordinates.z,level:l.coordinates.plane,reachable:true,optionsWithIndex:[{text:'Mine',opIndex:1}]}];return l.id;}
test('actual copper requirements at Mining 25 with bronze tool do not demand Mining 31 or 41',()=>{
 const result=requirementBranches(copper().requirements,state(),cfg,source);assert.ok(result.branches.length);assert.ok(result.alternatives.some(a=>a.ready));assert.deepEqual(result.gaps,[]);
});
test('an actual usable equipped tool satisfies its OR branch without demanding a carried duplicate',()=>{
 const s=state(0);s.equipment=[{id:1265,count:1}];const result=requirementBranches(copper().requirements,s,cfg,source);assert.ok(result.alternatives.some(a=>a.ready));assert.deepEqual(result.gaps,[]);
});
test('absent tools remain alternative missing resources, not a mandatory high-tier training goal',()=>{
 const result=requirementBranches(copper().requirements,state(0),cfg,source);assert.equal(result.alternatives.some(a=>a.ready),false);
 assert.ok(result.gaps.length);assert.equal(result.gaps.some(g=>/mining requires (31|41)/.test(g)),false);
 assert.ok(result.alternatives.some(a=>a.missing.some(r=>r.fact==='carried:1265')));
});
test('true shared skill requirement still reports the minimum across all alternatives',()=>{
 const req={all:[{skill:'mining',level:30},{any:[{skill:'mining',level:41},{skill:'mining',level:31}]}]};
 const r=requirementBranches(req,state(1265,25),cfg,source);assert.deepEqual(r.gaps,['mining requires 31, observed 25']);
});
test('one satisfied OR flag removes warnings from rejected optional branches',()=>{
 const r=requirementBranches({any:[{flag:'unsupported',value:true},{flag:'world.members',value:true}]},state(),cfg,source);
 assert.equal(r.alternatives.some(a=>a.ready),true);assert.deepEqual(r.gaps,[]);assert.ok(r.rejected.length);
});
test('an unmet AND flag prevents all branches and is never silently dropped',()=>{
 const r=requirementBranches({all:[{flag:'unsupported',value:true},{skill:'mining',level:1}]},state(),cfg,source);assert.equal(r.branches.length,0);assert.ok(r.gaps.some(x=>x.includes('unsupported')));
});
test('an unknown or false implicit flag is not assumed true',()=>{
 assert.equal(requirementBranches({flag:'unsupported'},state(),cfg,source).branches.length,0);
 assert.equal(requirementBranches({flag:'world.members'},state(),cfg,source).branches.length,1);
 const s=state();s.members=false;assert.equal(requirementBranches({flag:'world.members'},s,cfg,source).branches.length,0);
 assert.equal(requirementBranches({flag:'world.members',value:false},s,cfg,source).branches.length,1);
});
test('generic predicates without a comparator require true instead of accepting false',()=>{
 const s=state();s.sourceFacts={access:false};assert.equal(requirementBranches({fact:'access'},s,cfg,source).branches.length,0);
 assert.equal(requirementBranches({fact:'access',equals:false},s,cfg,source).branches.length,1);
});
test('unknown skill is a specific information gap, not an invented level',()=>{
 const r=requirementBranches({skill:'fletching',level:10},state(),cfg,source);assert.deepEqual(r.gaps,['Unknown skill: fletching']);
});
test('AND item quantity preserves the strongest prerequisite rather than double-counting a reusable tool',()=>{
 const r=requirementBranches({all:[{itemId:1265,quantity:1},{itemId:1265,quantity:2}]},state(),cfg,source);
 assert.equal(r.alternatives[0]!.missing[0]!.minimum,2);assert.equal(r.gaps[0],'Missing carried item: 1265; requires 2, observed 1');
 assert.equal(classifyBlocker('recipe',r.gaps[0]!,state(),cfg).kind,'needs-resource');
});
test('bounded branches/depth fail closed rather than accepting a partial condition tree',()=>{
 const req={any:Array.from({length:65},()=>({skill:'mining',level:1}))};assert.equal(requirementBranches(req,state(),cfg,source).branches.length,0);
 let deep:any={skill:'mining',level:1};for(let n=0;n<20;n++)deep={all:[deep]};assert.equal(requirementBranches(deep,state(),cfg,source).branches.length,0);
});
test('source report separates valid gathering alternative from failed optional tool branches',()=>{
 const s=state();rock(s);const cat=c(),r=buildSourceMethods(source,cat,s,emptyKnowledge(),undefined,defaultPolicy,createMemory(identity),cfg,1000);
 assert.equal(r.blockers.some(b=>b.id===copper().id),false);
 const alternatives=r.requirementAlternatives!.find(a=>a.id===copper().id)!;assert.equal(alternatives.ready,true);assert.ok(alternatives.rejected.length);
 assert.ok(cat.methods.some(m=>cat.tasks.get(m.id)?.sourceResource?.routeId===copper().id));
});
test('fresh executor still refuses a high-tier tool at an insufficient level',async()=>{
 const s=state(1275,25),locationId=rock(s),r=await sourceActions(source,{profileId:source.data.profile.id,kind:'gather',routeId:copper().id,locationId,itemId:436,quantity:1},s,cfg,
 {bank:()=>[],route:async()=>({status:'blocked'})},undefined,1000);assert.equal(r.actions.length,0);
});
test('fresh executor accepts the low-tier alternative and checks it again after a tool change',async()=>{
 const s=state(),locationId=rock(s),task:any={profileId:source.data.profile.id,kind:'gather',routeId:copper().id,locationId,itemId:436,quantity:1},
 port:any={bank:()=>[],route:async()=>({status:'blocked'})};
 const ready=await sourceActions(source,task,s,cfg,port,undefined,1000);assert.equal(ready.actions[0]!.type,'interactLoc');
 s.inventory=[];const missing=await sourceActions(source,task,s,cfg,port,undefined,1001);assert.equal(missing.actions.length,0);
});

test('missing local resource observation is information to obtain, not a character training requirement',()=>{
 assert.equal(classifyBlocker('gather','no matching resource placement is currently observed and reachable',state(),cfg).kind,'needs-information');
});
