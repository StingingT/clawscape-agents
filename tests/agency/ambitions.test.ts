import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemory, Director } from '../../src/agency/director.ts';
import { AMBITIONS, rankAmbitions, reviewAmbition, ambitionPriority } from '../../src/agency/ambitions.ts';
import { chooseDevelopment, reviewDevelopment, guardDevelopment } from '../../src/agency/development.ts';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';
import { seedBuildExperiment } from './build-fixture.ts';
import type { Memory, Opportunity } from '../../src/agency/types.ts';
const identity = { agent: 'worker', world: 'fixture', revision: 'v1' };
const state = (): any => ({ character:'worker',world:'fixture',inGame:true,tick:1,
  player:{lifeId:1,hp:30,maxHp:30,level:0,worldX:1,worldZ:1,combat:{inCombat:false}},
  skills:['attack','strength','defence','ranged','magic','prayer','smithing','crafting','mining','fishing','woodcutting'].map(name=>({name,baseLevel:1,experience:0})),
  inventory:[{slot:0,id:841,name:'Shortbow',count:1}],equipment:[{slot:3,id:1291,name:'Bronze longsword',count:1}],
  combatStyle:{currentStyle:0,weaponName:'Bronze longsword',styles:[{index:0,trainsSkills:['strength']},{index:1,trainsSkills:['defence']}]},bank:{isOpen:false}});
function initialize(m:Memory,s=state()){m.ambition=reviewAmbition(m,s,1000);return m;}
function success(m:Memory,domain:string,skill:string,n:number,ambitionId='combat-mastery') {
  m.reviews.push({at:2000+n,result:'success',reason:'Verified personal result',evidence:['own-result'],
    goal:{id:'train-'+skill,target:{fact:'xp:'+skill,minimum:100},domain,priority:'strategic',ambitionId,deaths:0,lostGp:0} as any});
}
test('artisan, resource, explorer, unrestricted combat and all-skill ambitions are first-class',()=>{
  for(const [prefs,id] of [[{crafting:2,gathering:1},'artisan-collector'],[{gathering:2},'resource-specialist'],
    [{exploration:2},'world-explorer'],[{combat:2},'combat-mastery'],[{combat:1,crafting:1,gathering:1,exploration:1},'all-skill-mastery'],[{},'all-skill-mastery']] as const) {
    const m=initialize(createMemory(identity,prefs));assert.equal(m.ambition?.id,id);
    const d=chooseDevelopment(state(),m,1000,'ranged-magic');assert.equal(d.id,'open-development');assert.deepEqual(d.protectedXp,{});
    assert.ok(d.alternatives?.find(a=>a.id==='open-development'&&a.eligible));
  }
});
test('temporary combat work and new weapons cannot turn a crafting-oriented agent into a pure',()=>{
  const m=initialize(createMemory(identity,{crafting:2,gathering:1}));m.active={domain:'combat',target:{fact:'xp:strength',minimum:100}} as any;
  const s=state();s.inventory.push({id:1215,name:'Dragon dagger',count:1,slot:1});
  assert.equal(chooseDevelopment(s,m,1000,'melee').id,'open-development');
  assert.equal(reviewAmbition(m,s,5000),m.ambition);
});
test('preferences, not character names, determine new ambitions',()=>{
  for(const name of ['coincrafter','stinger','astra','unseen-character']) {
    const s=state();s.character=name;
    const m=createMemory({...identity,agent:name},{crafting:2,gathering:1});
    assert.equal(reviewAmbition(m,s,1000)?.id,'artisan-collector');
  }
});
test('a live artisan chooses feasible production ahead of incidental exploration and combat',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ambition-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const a=new LiveAgency(join(dir,'state.json'),identity,{supported:['production','gathering','exploration','combat'],
    preferences:{crafting:2,gathering:1},routes:[{id:'fixture-bank',x:2,z:1,level:0,evidence:'own-lead'}],policy:{combatLossBoundGp:5}});
  const p=a.plan(state());assert.ok(isSelection(p));assert.equal(p.decision.goal.id,'production-batch');
  assert.equal(p.decision.goal.ambitionId,'artisan-collector');assert.equal(a.summary().development?.id,'open-development');
});
test('ambition and the active goal survive restart without silent role-based reassignment',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ambition-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'state.json');
  const a=new LiveAgency(file,identity,{supported:['production'],preferences:{crafting:2},now:()=>1000});
  const p=a.plan(state());assert.ok(isSelection(p));a.begin(p,{id:'observe',type:'wait'},state(),'pending');
  const b=new LiveAgency(file,identity,{supported:['production'],preferences:{combat:2},now:()=>2000});
  b.plan(state());assert.equal(b.summary().ambition?.id,'artisan-collector');assert.equal(b.pending()?.commandId,'pending');
  assert.equal(b.director.memory.active?.key,p.decision.goal.key);
});
test('all-skill mastery favours a weak supported skill but cannot enable an absent capability',()=>{
  const m=initialize(createMemory(identity,{combat:1,crafting:1,gathering:1,exploration:1}));
  const g:Opportunity={id:'train-defence',domain:'combat',target:{fact:'xp:defence',minimum:100},source:'collection',reason:'Personal mastery',evidence:['own-state']};
  const facts={'level:defence':1,'level:strength':40};
  assert.ok(ambitionPriority(m,g,facts)>ambitionPriority(m,{...g,id:'train-strength',target:{fact:'xp:strength',minimum:100}},facts));
  const result=new Director(m).next({...identity,at:1000,context:'fixture',facts,capabilities:[],budget:{spendableGp:0,maxLossGp:0,maxDeaths:0,maxDurationMs:1000}},[g],[]);
  assert.equal(result.type,'blocked');assert.equal(Object.keys(AMBITIONS).includes('all-skill-mastery'),true);
});
test('training recommendations are available without adopting any pure restrictions',()=>{
  const m=initialize(createMemory(identity,{crafting:2})),d=chooseDevelopment(state(),m,1000);
  assert.ok(d.trainingLeadIds?.includes('lumbridge-chickens'));assert.equal(d.levelCaps,undefined);
  const s=state();s.combatStyle.currentStyle=1;s.nearbyNpcs=[{index:7,id:41,reachable:true,optionsWithIndex:[{opIndex:2,text:'Attack'}]}];
  guardDevelopment(d,s,{type:'interactNpc',fields:{npcIndex:7,optionIndex:2}},'defence');
});
test('a comparative-build ambition needs multiple recorded personal trials, not equipment compatibility',()=>{
  const m=initialize(createMemory(identity,{combat:2}));const s=state();s.combatStyle.styles.push({index:2,trainsSkills:['ranged']});
  assert.equal(rankAmbitions(m,s).find(a=>a.id==='combat-build-experiment')?.eligible,false);
  for(let n=0;n<4;n++)success(m,'combat',n%2?'ranged':'strength',n);
  m.ambition=reviewAmbition(m,s,5000);assert.equal(m.ambition?.id,'combat-build-experiment');assert.ok(m.ambition?.history[0]?.reason);
  assert.notEqual(chooseDevelopment(s,m,5000).id,'open-development');
});
test('failed trials, support preparation and time do not generate a pure motive',()=>{
  const m=initialize(createMemory(identity,{combat:2}));
  for(let n=0;n<8;n++){success(m,'combat',n%2?'ranged':'strength',n);m.reviews[n]!.goal.priority='maintenance';}
  assert.equal(reviewAmbition(m,state(),999999)?.id,'combat-mastery');
});
test('broader verified achievements can justify a recorded shift toward all-skill mastery',()=>{
  const m=initialize(createMemory(identity,{combat:2}));
  for(let n=0;n<9;n++)success(m,['combat','crafting','gathering'][n%3]!,['defence','smithing','mining'][n%3]!,n);
  const a=reviewAmbition(m,state(),5000);assert.equal(a?.id,'all-skill-mastery');assert.equal(a?.history[0]?.from,'combat-mastery');
});
test('already adopted pure XP restrictions are never silently cleared by new ambitions',()=>{
  const m=seedBuildExperiment(createMemory(identity,{combat:2})),s=state(),d=chooseDevelopment(s,m,1000);
  m.ambition=initialize(createMemory(identity,{crafting:2})).ambition;
  const kept=reviewDevelopment(d,s,m,9000);assert.equal(kept.id,d.id);assert.deepEqual(kept.protectedXp,d.protectedXp);
});
