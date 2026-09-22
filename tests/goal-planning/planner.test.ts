import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory, Director, analyzePlan, makePlan } from '../../src/agency/director.ts';
import type { Facts, Method, Observation, Opportunity } from '../../src/agency/types.ts';

const identity={agent:'fixture',world:'test',revision:'one'};
const context={version:1 as const,profileId:'fixture',skillModels:{smithing:{thresholds:{'1':0,'2':100,'3':200,'4':300},confirmed:true,evidence:['test-source']},mining:{thresholds:{'1':0,'2':100},confirmed:true,evidence:['test-source']}},maxExpansions:512,maxSteps:48,beamWidth:3};
const view=(facts:Facts={},at=1000):Observation=>({...identity,at,context:'one',facts:{'level:smithing':1,'xp:smithing':0,...facts},
 budget:{spendableGp:100,maxLossGp:10,maxDeaths:1,maxDurationMs:120_000},capabilities:['make','buy','gather'],goalPlanning:structuredClone(context)});
const goal:Opportunity={id:'wanted',domain:'crafting',target:{fact:'product',minimum:1},reason:'My own useful objective',source:'need',evidence:['own-state']};
const m=(id:string,effects:Facts,prerequisites:Method['prerequisites']=[],rest:Partial<Method>={}):Method=>({id,capability:'make',domain:'crafting',effects,prerequisites,costGp:0,lossBoundGp:0,durationMs:1000,risk:'safe',...rest});
const train=m('train-unrelated-product',{'xp:smithing':50,surplus:1},[{fact:'level:smithing',minimum:1}],{
 training:{profileId:'fixture',xp:{smithing:50},maximumXp:{smithing:50},evidence:['sourceXP']},consumes:{ore:1}});
const final=m('make-goal',{product:1},[{fact:'level:smithing',minimum:2}],{consumes:{bar:1}});

test('a low skill produces parent-linked real training actions, not a synthetic level-up command',()=>{
 const d=new Director(createMemory(identity));const v=view({ore:2,bar:1});const result=d.next(v,[goal],[train,final]);
 assert.equal(result.type,'execute');if(result.type!=='execute')return;
 assert.equal(result.step.methodId,train.id);assert.equal(result.plan.steps.length,3);
 assert.ok(result.goal.supportGoals?.some(x=>x.target.fact==='level:smithing'&&x.target.minimum===2));
 assert.ok(result.goal.supportGoals?.some(x=>x.target.fact==='xp:smithing'&&x.target.minimum===100));
 assert.ok(result.goal.supportGoals?.every(x=>x.budgetRootKey===result.goal.key&&x.stopWhen&&x.reviewAt));
});
test('whole preparation cost can make a purchase better than a cheap-looking final crafting action',()=>{
 const methods=[{...train,durationMs:50_000},final,m('purchase',{product:1},[],{capability:'buy',costGp:5})];
 assert.equal(makePlan(createMemory(identity),view({ore:2,bar:1}),goal,methods)?.steps[0]?.methodId,'purchase');
});
test('training can beat a purchase without a mandatory crafting or shop preference',()=>{
 const methods=[train,final,m('purchase',{product:1},[],{capability:'buy',costGp:90})];
 assert.equal(makePlan(createMemory(identity),view({ore:2,bar:1}),goal,methods)?.steps[0]?.methodId,train.id);
});
test('already owned materials do not imply an accompanying mining goal',()=>{
 const result=makePlan(createMemory(identity),view({ore:2,bar:1}),goal,[train,final]);
 assert.ok(result);assert.ok(!result.steps.flatMap(s=>s.lineage??[]).some(r=>r.fact==='level:mining'));
});
test('mixed purchase of inputs and production are considered',()=>{
 const result=makePlan(createMemory(identity),view({bar:1}),goal,[train,final,m('buy-ore',{ore:1},[],{capability:'buy',costGp:1})]);
 assert.ok(result);assert.equal(result.costGp,2);assert.ok(result.steps.some(s=>s.methodId===final.id));
});
test('unregistered final executor does not justify training for a nonexistent completion path',()=>{
 const result=analyzePlan(createMemory(identity),view({ore:2,bar:1}),goal,[train,{...final,capability:'missing-anvil'}]);
 assert.equal(result.plan,undefined);assert.ok(result.trace.blockers.some(x=>x.kind==='unavailable'));
});
test('one-unit activity flags are not treated as numeric XP',()=>{
 const marker={...train,effects:{'xp:smithing':1},training:undefined};
 assert.equal(makePlan(createMemory(identity),view({ore:100,bar:1}),goal,[marker,final]),undefined);
});
test('unknown XP rate or missing observed XP cannot authorize training',()=>{
 const v=view({ore:2,bar:1});v.goalPlanning!.skillModels.smithing!.confirmed=false;
 assert.equal(makePlan(createMemory(identity),v,goal,[train,final]),undefined);
 v.goalPlanning!.skillModels.smithing!.confirmed=true;delete v.facts['xp:smithing'];
 assert.equal(makePlan(createMemory(identity),v,goal,[train,final]),undefined);
});
test('protected skills and a future build cap cannot be bypassed',()=>{
 const v=view({ore:20,bar:1});v.strategy={id:'build',protectedSkills:['smithing']};
 assert.equal(makePlan(createMemory(identity),v,goal,[train,final]),undefined);
 v.strategy={id:'build',protectedSkills:[],levelCaps:{smithing:1}};
 assert.equal(makePlan(createMemory(identity),v,goal,[train,final]),undefined);
});
test('training upper bound, not a lower-bound forecast, protects a level ceiling',()=>{
 const v=view({ore:2,bar:1,'xp:smithing':90});v.strategy={id:'build',protectedSkills:[],levelCaps:{smithing:2}};
 const unsafe={...train,training:{...train.training!,maximumXp:{smithing:200}}};
 assert.equal(makePlan(createMemory(identity),v,goal,[unsafe,final]),undefined);
});
test('shared sibling inputs are not consumed twice',()=>{
 const methods=[m('a',{a:1},[],{consumes:{bar:1}}),m('b',{b:1},[],{consumes:{bar:1}}),m('finish',{product:1},[],{consumes:{a:1,b:1}})];
 assert.equal(makePlan(createMemory(identity),view({bar:1}),goal,methods),undefined);
 assert.ok(makePlan(createMemory(identity),view({bar:2}),goal,methods));
});
test('one reusable tool can serve several steps without being consumed',()=>{
 const methods=[m('a',{a:1},[{fact:'tool',minimum:1}]),m('b',{b:1},[{fact:'tool',minimum:1}]),m('finish',{product:1},[],{consumes:{a:1,b:1}})];
 assert.ok(makePlan(createMemory(identity),view({tool:1}),goal,methods));
});
test('physical stocks and aliases cannot be spent independently',()=>{
 const v=view({'carried:1':1,alias:1});v.goalPlanning!.aliases={alias:['carried:1']};
 const methods=[m('a',{a:1},[],{consumes:{'carried:1':1}}),m('b',{b:1},[],{consumes:{alias:1}}),m('finish',{product:1},[],{consumes:{a:1,b:1}})];
 assert.equal(makePlan(createMemory(identity),v,goal,methods),undefined);
});
test('XP and the useful byproduct of one activity are credited together at one cost',()=>{
 const byproduct={...train,effects:{'xp:smithing':50,bar:1}};
 const result=makePlan(createMemory(identity),view({ore:2}),goal,[byproduct,final]);assert.ok(result);assert.equal(result.steps.length,3);assert.equal(result.durationMs,3000);
});
test('material/bootstrap cycles are explicit rather than free missing inputs',()=>{
 const result=analyzePlan(createMemory(identity),view(),goal,[m('cycle',{product:1},[{fact:'tool',minimum:1}]),m('cycle-tool',{tool:1},[{fact:'product',minimum:1}])]);
 assert.equal(result.plan,undefined);assert.ok(result.trace.blockers.some(b=>b.kind==='cycle'));
});
test('bounded search exhaustion is not called definitive impossibility',()=>{
 const v=view({ore:200,bar:1});v.goalPlanning!.maxSteps=1;
 const result=analyzePlan(createMemory(identity),v,goal,[train,final]);assert.equal(result.plan,undefined);assert.equal(result.trace.truncated,true);assert.equal(result.trace.optimal,false);
});
test('preparation spending is included in the parent budget',()=>{
 const v=view({bar:1});v.budget.spendableGp=1;
 assert.equal(makePlan(createMemory(identity),v,goal,[train,final,m('ore',{ore:1},[],{costGp:1})]),undefined);
});
test('verified training advances child progress without claiming the parent is finished',()=>{
 const d=new Director(createMemory(identity));const v=view({ore:2,bar:1}),decision=d.next(v,[goal],[train,final]);assert.equal(decision.type,'execute');
 d.begin(v,decision,train,'cmd');d.record({commandId:'cmd',sequence:1,status:'verified',at:2000,facts:{...v.facts,ore:1,'xp:smithing':50},spentGp:0,lostGp:0,deaths:0,elapsedMs:1000,evidence:['observed XP'],actionType:'useItemOnLoc'});
 assert.equal(d.memory.active?.id,goal.id);assert.equal(d.memory.progress?.last?.productive,true);assert.equal(d.memory.progress?.last?.objective,false);
});
test('training resumes the parent at the threshold and persists budgets over restart',()=>{
 const d=new Director(createMemory(identity));const v=view({ore:2,bar:1}),decision=d.next(v,[goal],[train,final]);
 d.begin(v,decision,train,'cmd');d.record({commandId:'cmd',sequence:1,status:'verified',at:2000,facts:{...v.facts,ore:1,'xp:smithing':100,'level:smithing':2},spentGp:7,lostGp:0,deaths:0,elapsedMs:1000,evidence:['observed XP']});
 const reloaded=new Director(JSON.parse(JSON.stringify(d.memory))),v2=view({ore:1,bar:1,'xp:smithing':100,'level:smithing':2},2100);
 const next=reloaded.next(v2,[goal],[train,final]);assert.equal(next.type,'execute');if(next.type==='execute')assert.equal(next.step.methodId,final.id);
 assert.equal(reloaded.memory.active?.spentGp,7);assert.equal(reloaded.memory.active?.startedAt,1000);
});
test('external parent fulfillment cancels unnecessary descendants instead of training forever',()=>{
 const d=new Director(createMemory(identity));d.next(view({ore:2,bar:1}),[goal],[train,final]);d.next(view({ore:2,bar:1,product:1},1100),[],[train,final]);
 assert.equal(d.memory.active,undefined);assert.ok(d.memory.reviews.at(-1)?.goal.supportGoals?.every(s=>s.status==='cancelled'||s.status==='satisfied'));
});
test('pending command reconciliation takes precedence over replanning',()=>{
 const d=new Director(createMemory(identity)),v=view({ore:2,bar:1}),decision=d.next(v,[goal],[train,final]);d.begin(v,decision,train,'cmd');
 assert.equal(d.next(view({product:1},1100),[],[train,final]).type,'reconcile');
});
test('two roles can choose different valid near-equal approaches without capability restrictions',()=>{
 const methods=[m('craft-route',{product:1},[],{domain:'crafting'}),m('gather-route',{product:1},[],{domain:'gathering'})];
 assert.equal(makePlan(createMemory(identity,{crafting:5}),view(),goal,methods)?.steps[0]?.methodId,'craft-route');
 assert.equal(makePlan(createMemory(identity,{gathering:5}),view(),goal,methods)?.steps[0]?.methodId,'gather-route');
});
test('legacy planner remains the default when the rollout context is absent',()=>{
 const v=view();delete v.goalPlanning;const result=makePlan(createMemory(identity),v,goal,[m('direct',{product:1})]);assert.ok(result);assert.equal(result.approachId,undefined);
});

test('small route fluctuations do not cause thrashing but a materially better route can win',()=>{
 const d=new Director(createMemory(identity));const a=m('a',{product:1},[],{costGp:2}),b=m('b',{product:1},[],{costGp:2.1});
 const first=d.next(view(),[goal],[a,b]);assert.equal(first.type,'execute');if(first.type==='execute')assert.equal(first.step.methodId,'a');
 const next=d.next(view({},1100),[goal],[{...a,costGp:2.2},b]);assert.equal(next.type,'execute');if(next.type==='execute')assert.equal(next.step.methodId,'a');
 const better=d.next(view({},1200),[goal],[{...a,costGp:20},b]);assert.equal(better.type,'execute');if(better.type==='execute')assert.equal(better.step.methodId,'b');
});
test('unqualified XP earned during input preparation cannot be recycled into a projected level',()=>{
 const v=view({bar:1}),qualified={...train,effects:{'xp:smithing':1},training:{profileId:'fixture',xp:{smithing:1},maximumXp:{smithing:1},evidence:['sourceXP']}};
 const fake=m('get-ore',{ore:1,'xp:smithing':100});v.goalPlanning!.maxSteps=10;
 assert.equal(makePlan(createMemory(identity),v,goal,[qualified,fake,final]),undefined);
});
test('a cheap currently feasible route is examined before an explosive prerequisite branch',()=>{
 const v=view();v.goalPlanning!.maxExpansions=64;
 const cyclic=m('cheap-last-step',{product:1},[{fact:'cycle',minimum:1}]),loop=m('loop',{cycle:1},[{fact:'cycle',minimum:1}]),buy=m('ready-buy',{product:1},[],{costGp:10});
 assert.equal(makePlan(createMemory(identity),v,goal,[cyclic,loop,buy])?.steps[0]?.methodId,'ready-buy');
});
test('unknown prices, PvP and unregistered cooperation never become free alternatives',()=>{
 const v=view(),methods=[m('unknown-price',{product:1},[],{costGp:NaN}),m('pvp',{product:1},[],{risk:'pvp'}),m('party',{product:1},[],{capability:'party-unimplemented'})];
 assert.equal(makePlan(createMemory(identity),v,goal,methods),undefined);
});
test('fresh dispatch recheck rejects a lost tool even after a valid preparation forecast',()=>{
 const d=new Director(createMemory(identity));const method=m('make',{product:1},[{fact:'tool',minimum:1}]);const v=view({tool:1}),decision=d.next(v,[goal],[method]);
 assert.throws(()=>d.begin(view({tool:0},1100),decision,method,'cmd'),/INVALID_OR_STALE_PLAN/);
});
