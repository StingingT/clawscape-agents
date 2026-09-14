import { seedBuildExperiment } from './build-fixture.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chooseDevelopment,reviewDevelopment,guardDevelopment} from '../../src/agency/development.ts';
import {createMemory} from '../../src/agency/director.ts';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import {observeQuietStep,retryAllowed,recordViability,stepKey} from '../../src/agency/step-retry.ts';
import {verifyActionOutcome} from '../../src/action-outcome.ts';
const identity={agent:'stinger',world:'test',revision:'v1'};
const state=(tick=1):any=>({inGame:true,tick,sessionId:'local-1',player:{lifeId:1,hp:30,maxHp:30,worldX:1,worldZ:1,level:0,animId:-1,combat:{inCombat:false,targetType:'none'}},
  skills:['attack','strength','defence','ranged','magic','prayer'].map(name=>({name,experience:0,baseLevel:1,level:1})),
  inventory:Array.from({length:8},(_,i)=>({id:315,name:'Shrimps',slot:i,count:1,optionsWithIndex:[{text:'Eat',opIndex:1}]})),
  equipment:[{id:841,name:'Shortbow',slot:3,count:1},{id:882,name:'Bronze arrow',slot:13,count:50}],
  combatStyle:{weaponName:'Shortbow',currentStyle:0,styles:[{index:0,trainsSkills:['ranged']},{index:1,trainsSkills:['ranged','defence']}]},
  nearbyNpcs:[{id:1,name:'Goblin',index:4,reachable:true,optionsWithIndex:[{text:'Attack',opIndex:2}]}]});
const attack={type:'interactNpc',fields:{npcIndex:4,optionIndex:2}};

test('a low-Defence ranged character chooses a reasoned pure experiment, not an immutable role',()=>{
  const d=chooseDevelopment(state(),seedBuildExperiment(createMemory(identity,{combat:2})),1000,'ranged-magic');
  assert.equal(d.id,'ranged-magic-pure');assert.deepEqual(Object.keys(d.protectedXp),['attack','strength','defence','prayer']);
  assert.ok(d.reason.includes('observed'));assert.ok(d.evidence.length);
  const s=state();s.skills.find((k:any)=>k.name==='defence').baseLevel=40;
  assert.equal(chooseDevelopment(s,seedBuildExperiment(createMemory(identity,{combat:2})),1000,'ranged-magic').id,'open-development');
});

test('mixed style and accidental protected XP are blocked before irreversible combat',()=>{
  const s=state(),d=chooseDevelopment(s,seedBuildExperiment(createMemory(identity,{combat:2})),1000,'ranged-magic');
  guardDevelopment(d,s,attack,'ranged');s.combatStyle.currentStyle=1;
  assert.throws(()=>guardDevelopment(d,s,attack,'ranged'),/DISALLOWS/);
  assert.throws(()=>guardDevelopment(d,s,{type:'setCombatStyle',fields:{style:1}},'ranged'),/DISALLOWS/);
  s.combatStyle.currentStyle=0;s.skills.find((k:any)=>k.name==='defence').experience=1;
  assert.throws(()=>guardDevelopment(d,s,attack,'ranged'),/XP_BOUNDARY/);
});

test('unknown style XP cannot silently authorize an attack',()=>{
  const s=state(),d=chooseDevelopment(s,seedBuildExperiment(createMemory(identity,{combat:2})),1000,'ranged-magic');
  s.combatStyle.styles=[];assert.throws(()=>guardDevelopment(d,s,attack,'ranged'),/CANNOT_VERIFY/);
});

test('a rune melee strategy permits planned Attack preparation and deliberately freezes default Prayer',()=>{
  const s=state();s.combatStyle.styles=[{index:0,trainsSkills:['strength']}];
  const d=chooseDevelopment(s,seedBuildExperiment(createMemory(identity,{combat:2})),1000,'melee');
  assert.equal(d.id,'rune-melee-pure');assert.equal(d.levelCaps?.attack,40);assert.ok(!Object.hasOwn(d.protectedXp,'attack'));assert.ok(Object.hasOwn(d.protectedXp,'prayer'));
  const before=state(),after=state(2);before.inventory=[{id:526,name:'Bones',slot:0,count:1,optionsWithIndex:[{text:'Bury',opIndex:1}]}];after.inventory=[];
  after.skills.find((k:any)=>k.name==='prayer').experience=4.5;
  assert.equal(verifyActionOutcome(before,after,{type:'useInventoryItem',fields:{slot:0,optionIndex:1}}).verified,true);
});

test('missing supplies, route failures and time alone cannot erase a pure experiment',()=>{
  const m=seedBuildExperiment(createMemory(identity,{combat:2})),s=state(),d=chooseDevelopment(s,m,1000,'ranged-magic');
  m.reviews=Array.from({length:10},(_,i)=>({at:2000+i,goal:{strategyId:d.id,domain:'combat',deaths:0,lostGp:0} as any,
    result:'partial',reason:'Missing food',evidence:[]}));
  assert.equal(reviewDevelopment(d,s,m,100_000),d);
});

test('three costly trials request alternatives without automatically removing a pure boundary',()=>{
  const m=seedBuildExperiment(createMemory(identity,{combat:2})),s=state(),d=chooseDevelopment(s,m,1000,'ranged-magic');
  s.combatStyle.styles.push({index:2,trainsSkills:['defence']});
  m.reviews=Array.from({length:3},(_,i)=>({at:2000+i,goal:{id:'train-ranged',strategyId:d.id,domain:'combat',deaths:1,lostGp:5} as any,
    result:'failure',reason:'Verified loss',evidence:['death-event']}));
  const changed=reviewDevelopment(d,s,m,5000);assert.equal(changed.id,d.id);assert.deepEqual(changed.protectedXp,d.protectedXp);
  assert.equal(changed.history.length,0);assert.equal(changed.review?.evidence.length,3);assert.ok(changed.review?.alternatives.length);
});

test('pure strategy and parent-linked food preparation survive a restart and changed role suggestion',t=>{
  const dir=mkdtempSync(join(tmpdir(),'pure-live-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'agency.json');
  const options={supported:['food','combat'] as any,policy:{combatLossBoundGp:5},preferences:{combat:2},developmentHint:'ranged-magic',now:()=>1000};
  let a=new LiveAgency(file,identity,options);const s=state();s.inventory=[];
  seedBuildExperiment(a.director.memory);const p=a.plan(s);assert.ok(isSelection(p));assert.equal(p.decision.goal.id,'train-ranged');assert.equal(p.task.kind,'food');
  assert.ok(p.decision.step.supportGoalId);a=new LiveAgency(file,identity,{...options,developmentHint:'melee'});
  const next=a.plan(s);assert.ok(isSelection(next));assert.equal(next.decision.goal.key,p.decision.goal.key);
  assert.equal(a.summary().development?.id,'ranged-magic-pure');
});

test('uncertain steps re-enter consideration after time, capability change or actual learning',()=>{
  const v=recordViability(undefined,'interrupted',1000,'old',5,['idle evidence'],'interrupted');
  assert.equal(v.state,'uncertain');assert.equal(retryAllowed(v,2000,'old',5),false);
  assert.equal(retryAllowed(v,v.retryAt,'old',5),true);assert.equal(retryAllowed(v,2000,'better-kit',5),true);
  assert.equal(retryAllowed(v,2000,'old',6),true);assert.equal(retryAllowed(v,900,'better-kit',6),false);
});

test('ephemeral IDs do not let an equivalent step bypass its retry memory',()=>{
  const a:any={id:'first',type:'walkTo',fields:{x:40,z:40}},b={...a,id:'second'};
  assert.equal(stepKey(a,state()),stepKey(b,state()));
});

test('transient closure can be interrupted with evidence, but transactions and dialogue cannot expire',()=>{
  const before=state(),after=state(2);before.dialog={isOpen:true};after.dialog={isOpen:false};
  const action={type:'closeModal'};
  const first=observeQuietStep(action,before,after,1000,'observer');assert.equal(first.settled,false);
  after.tick=3;const last=observeQuietStep(action,before,after,31000,'observer',first.window);assert.equal(last.settled,true);
  for(const type of ['shopBuy','bankWithdraw','bankDeposit','clickDialogOption','talkToNpc','pickupItem','useItemOnItem','interactNpc','interactLoc'])
    assert.equal(observeQuietStep({type},before,after,1000000,'observer',first.window).settled,false);
});

test('a restart, replayed tick, activity, or a long observation gap resets transient settlement',()=>{
  const before=state(),after=state(2),action={type:'walkTo',fields:{x:40,z:40}};
  const first=observeQuietStep(action,before,after,1000,'one');
  assert.equal(observeQuietStep(action,before,after,31000,'one',first.window).settled,false);
  after.tick=3;assert.equal(observeQuietStep(action,before,after,31000,'two',first.window).settled,false);
  assert.equal(observeQuietStep(action,before,after,100000,'one',first.window).settled,false);
  after.player.animId=1;assert.equal(observeQuietStep(action,before,after,31000,'one',first.window).settled,false);
});
