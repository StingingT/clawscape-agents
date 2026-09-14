import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BUILD_GUIDES,BUILD_SOURCES,EXCLUDED_DEFAULTS} from '../../src/agency/build-guides.ts';
import {validateBuildRules,type BuildRules} from '../../src/agency/build-rules.ts';
import {chooseDevelopment,reviewDevelopment,migrateDevelopment,guardDevelopment,guideTrainingTarget} from '../../src/agency/development.ts';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import {createMemory} from '../../src/agency/director.ts';
import {TRAINING_LEADS,inspectTrainingLeads,guidePrior} from '../../src/training/guide-leads.ts';
const identity={agent:'scout',world:'test',revision:'fixture'};
const memory=()=>createMemory(identity,{combat:2});
const state=():any=>({character:'scout',world:'test',tick:1,inGame:true,player:{lifeId:1,worldX:1,worldZ:1,level:0,hp:30,maxHp:30,combat:{inCombat:false}},
  skills:['attack','strength','defence','ranged','magic','prayer'].map(name=>({name,baseLevel:1,level:1,experience:0})),
  inventory:[{id:315,name:'Shrimps',slot:0,count:8,optionsWithIndex:[{opIndex:1,text:'Eat'}]}],
  equipment:[{id:1279,name:'Iron scimitar',slot:3,count:1}],
  combatStyle:{weaponName:'Iron scimitar',currentStyle:0,styles:[{index:0,trainsSkills:['attack']},{index:1,trainsSkills:['strength']},{index:2,trainsSkills:['attack','strength','defence']}]},
  nearbyNpcs:[{id:41,index:7,name:'Chicken',reachable:true,optionsWithIndex:[{opIndex:2,text:'Attack'}]}]});
const set=(s:any,name:string,level:number,xp=(level-1)*100)=>Object.assign(s.skills.find((k:any)=>k.name===name),{baseLevel:level,level,experience:xp});
// Explicit synthetic test curve. These values are NOT RuneScape thresholds.
const rules=():BuildRules=>({version:1,...identity,source:'fixture:audited-effect-contract',
  xpThresholds:{attack:Array.from({length:101},(_,i)=>Math.max(0,i-1)*100),prayer:Array.from({length:101},(_,i)=>Math.max(0,i-1)*100)},
  effects:{'attack:41:Iron scimitar:0':{terminal:true,maximumXp:{attack:50,hitpoints:15}},'bury:526':{terminal:true,maximumXp:{prayer:4.5}}},features:{}});
const attack={type:'interactNpc',fields:{npcIndex:7,optionIndex:2}};

test('all four researched profiles have dated source-backed descriptions and no executable command payloads',()=>{
  assert.equal(BUILD_GUIDES.length,4);
  for(const g of BUILD_GUIDES){assert.equal(g.defenceCap,1);assert.ok(g.sourceIds.every(k=>BUILD_SOURCES[k]));assert.ok(g.trainingLeadIds.length);assert.equal('coordinates' in g,false);}
  assert.ok(EXCLUDED_DEFAULTS.some(s=>s.includes('2021')));
});
test('the same role chooses melee versus ranged from different observations, not the character name',()=>{
  const a=state();assert.equal(chooseDevelopment(a,memory(),1,'ranged-magic').id,'rune-melee-pure');
  a.combatStyle={weaponName:'Shortbow',currentStyle:0,styles:[{index:0,trainsSkills:['ranged']}]};a.equipment=[{name:'Shortbow'}];
  assert.equal(chooseDevelopment(a,memory(),1,'melee').id,'ranged-magic-pure');
});

test('crafting and resource priorities remain broad instead of drifting into a pure from one combat opportunity',()=>{
  for(const preferences of [{crafting:2,gathering:1,combat:0},{gathering:2,combat:1}]) {
    const m=createMemory(identity,preferences as any);
    const d=chooseDevelopment(state(),m,1,'broad');
    assert.equal(d.id,'open-development');assert.equal(d.name,'Broad mastery');
    assert.ok(d.reason.includes('broad skill mastery'));
    assert.ok(d.alternatives?.every(a=>a.eligible===false));
  }
});
test('broad mastery does not silently specialize after a single combat success',()=>{
  const s=state(),m=createMemory(identity,{combat:2});const d=chooseDevelopment(s,m,1,'broad');
  m.reviews=[{at:2,result:'success',reason:'one fight',evidence:['verified'],goal:{domain:'combat'} as any}];
  assert.equal(reviewDevelopment(d,s,m,3).id,'open-development');
});
test('broad mastery may reconsider specialization after sustained personal combat evidence',()=>{
  const s=state(),m=createMemory(identity,{combat:2});const d=chooseDevelopment(s,m,1,'broad');
  m.reviews=Array.from({length:5},(_,n)=>({at:n+2,result:'success',reason:'combat evidence',evidence:['verified'],goal:{domain:'combat'} as any}));
  assert.notEqual(reviewDevelopment(d,s,m,10).id,'open-development');
});
test('a two-Defence character cannot acquire a one-Defence label or have XP reset',()=>{
  const s=state();set(s,'defence',2);const before=JSON.stringify(s);
  assert.equal(chooseDevelopment(s,memory(),1,'melee').id,'open-development');assert.equal(JSON.stringify(s),before);
});
test('hybrid requires observed ownership of both weapon types',()=>{
  const s=state();s.inventory.push({id:841,name:'Shortbow',count:1});
  assert.equal(chooseDevelopment(s,memory(),1,'melee').id,'ranged-melee-pure');
});
test('a dragon item without validated requirements and access cannot authorize the dragon build',()=>{
  const s=state();s.inventory.push({id:1215,name:'Dragon dagger'});
  const d=chooseDevelopment(s,memory(),1,'melee');assert.notEqual(d.id,'dragon-weapon-pure');
  assert.equal(d.alternatives?.find(a=>a.id==='dragon-weapon-pure')?.eligible,false);
});
test('an audited and personally available dragon route is still a separate candidate, not a forced switch',()=>{
  const s=state(),r=rules();s.inventory.push({id:1215,name:'Dragon dagger'});
  for(const key of ['dragon-weapon-requirements','lost-city-access','dragon-weapon-executor'])r.features[key]={supported:true,evidence:'fixture:own-unlock'};
  assert.equal(chooseDevelopment(s,memory(),1,'melee',r).id,'dragon-weapon-pure');
});
test('rune melee prepares Attack below 40 rather than freezing it at one',()=>{
  const s=state(),r=rules(),d=chooseDevelopment(s,memory(),1,'melee',r);
  assert.equal(d.levelCaps?.attack,40);assert.equal(d.protectedXp.attack,undefined);
  assert.equal(guideTrainingTarget(d,s,'attack',r),100);guardDevelopment(d,s,attack,'attack',r);
});
test('missing server XP rules do not create an invented cap curve or silence uncapped Strength progress',()=>{
  const s=state(),d=chooseDevelopment(s,memory(),1,'melee');
  assert.equal(guideTrainingTarget(d,s,'attack'),undefined);assert.equal(guideTrainingTarget(d,s,'strength'),100);
  assert.throws(()=>guardDevelopment(d,s,attack,'attack'),/XP_BOUND_REQUIRED/);
});
test('a command cannot cross an Attack cap even when starting below it',()=>{
  const s=state(),r=rules();set(s,'attack',39,3980-100);const d=chooseDevelopment(s,memory(),1,'melee',r);
  r.effects['attack:41:Iron scimitar:0']!.maximumXp.attack=150;
  assert.throws(()=>guardDevelopment(d,s,attack,'attack',r),/CAP_WOULD/);
});
test('reaching Attack 40 stops further Attack XP and retains Strength as an option',()=>{
  const s=state(),r=rules(),d=chooseDevelopment(s,memory(),1,'melee',r);set(s,'attack',40);
  assert.throws(()=>guardDevelopment(d,s,attack,'attack',r),/DISALLOWS/);
  const reviewed=reviewDevelopment(d,s,memory(),2,r);assert.equal(reviewed.protectedXp.attack,3900);
  assert.equal(guideTrainingTarget(reviewed,s,'strength',r),100);
});
test('default Prayer is frozen, so a Bury action is not an unbounded side effect',()=>{
  const s=state(),d=chooseDevelopment(s,memory(),1,'melee');s.inventory=[{id:526,slot:0,name:'Bones',count:1,optionsWithIndex:[{opIndex:1,text:'Bury'}]}];
  assert.equal(d.levelCaps?.prayer,1);assert.throws(()=>guardDevelopment(d,s,{type:'useInventoryItem',fields:{slot:0,optionIndex:1}},'prayer'),/DISALLOWS/);
});
test('a separately supported Prayer milestone and bone effect remain bounded before dispatch',()=>{
  const s=state(),r=rules();set(s,'prayer',2);r.features={'prayer-milestone:13':{supported:true,evidence:'fixture:prayer-ui'},'prayer-executor':{supported:true,evidence:'fixture:executor'}};
  const d=chooseDevelopment(s,memory(),1,'melee',r);assert.equal(d.levelCaps?.prayer,13);
  s.inventory=[{id:526,slot:0,name:'Bones',count:1,optionsWithIndex:[{opIndex:1,text:'Bury'}]}];
  guardDevelopment(d,s,{type:'useInventoryItem',fields:{slot:0,optionIndex:1}},'prayer',r);
  set(s,'prayer',12,1299);assert.throws(()=>guardDevelopment(d,s,{type:'useInventoryItem',fields:{slot:0,optionIndex:1}},'prayer',r),/CAP_WOULD/);
});
test('mixed and unknown style XP are blocked even while a permitted skill is the selected target',()=>{
  const s=state(),d=chooseDevelopment(s,memory(),1,'melee');s.combatStyle.currentStyle=2;
  assert.throws(()=>guardDevelopment(d,s,attack,'attack'),/DISALLOWS/);
  s.combatStyle.styles=[];assert.throws(()=>guardDevelopment(d,s,attack),/CANNOT_VERIFY/);
});
test('dialogue and spell rewards cannot bypass protected XP or use an unverified guide as an effect contract',()=>{
  const s=state(),d=chooseDevelopment(s,memory(),1,'melee'),r=rules();s.dialog={id:3,isOpen:true};
  const a={type:'clickDialogOption',fields:{optionIndex:1}};
  assert.throws(()=>guardDevelopment(d,s,a),/REWARD_XP_CONTRACT/);
  r.effects['dialogue:3:1']={terminal:true,maximumXp:{defence:100}};
  assert.throws(()=>guardDevelopment(d,s,a,undefined,r),/DISALLOWS_REWARD/);
  r.effects['dialogue:3:1']={terminal:true,maximumXp:{cooking:10}};guardDevelopment(d,s,a,undefined,r);
  assert.throws(()=>guardDevelopment(d,s,{type:'castSpell',fields:{spellId:5}}),/REWARD_XP_CONTRACT/);
});
test('three bad combat trials keep caps and generate reversible alternatives',()=>{
  const s=state(),m=memory(),d=chooseDevelopment(s,m,1,'melee');
  m.reviews=Array.from({length:3},(_,n)=>({at:n+2,result:'failure',reason:'loss',evidence:['verified'],goal:{strategyId:d.id,domain:'combat',deaths:1} as any}));
  const r=reviewDevelopment(d,s,m,6);assert.equal(r.id,d.id);assert.deepEqual(r.protectedXp,d.protectedXp);assert.ok(r.review?.alternatives.length);
});
test('legacy migration retains every old restriction and never silently raises Attack',()=>{
  const s=state();set(s,'defence',3);const d:any={version:1,id:'strength-prayer-pure',chosenAt:1,focus:['strength'],protectedXp:{attack:0,defence:200},history:[],reason:'old',evidence:[]};
  const n=migrateDevelopment(d,s,2);assert.equal(n.id,'legacy-restricted');assert.equal(n.protectedXp.attack,0);assert.equal(n.protectedXp.defence,200);assert.equal(n.history.length,1);
});
test('rules from another server/revision and nonterminal effect claims cannot be loaded',()=>{
  assert.throws(()=>validateBuildRules({...rules(),world:'wrong'},identity),/IDENTITY/);
  assert.throws(()=>validateBuildRules({...rules(),effects:{x:{terminal:false,maximumXp:{attack:5}}}},identity),/EFFECT/);
});
test('startup, sources, caps and one pending intent survive a restart',t=>{
  const dir=mkdtempSync(join(tmpdir(),'build-guide-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'agency.json'),s=state();
  s.combatStyle.currentStyle=1;
  const options={supported:['combat'] as any,preferences:{combat:2},policy:{combatLossBoundGp:5},developmentHint:'melee',now:()=>1000};
  let a=new LiveAgency(file,identity,options),p=a.plan(s);assert.ok(isSelection(p));assert.equal(p.task.skill,'strength');
  a.begin(p,{...attack,id:'trial'},s,'12345678-1234-1234-1234-123456789abc');a=new LiveAgency(file,identity,options);
  assert.equal(a.pending()?.commandId,'12345678-1234-1234-1234-123456789abc');const resumed=a.plan(s);assert.ok(!isSelection(resumed));assert.equal(resumed.type,'reconcile');
  const doc=JSON.parse(readFileSync(file,'utf8'));assert.equal(doc.development.version,2);assert.equal(doc.development.levelCaps.attack,40);assert.ok(doc.development.sourceUrls.length);
});
test('no Prayer objective is offered when the selected build protects Prayer',t=>{
  const dir=mkdtempSync(join(tmpdir(),'build-prayer-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const s=state();
  s.inventory.push({id:526,slot:10,name:'Bones',optionsWithIndex:[{opIndex:1,text:'Bury'}]});
  const a=new LiveAgency(join(dir,'agency.json'),identity,{supported:['prayer','combat'],preferences:{combat:2},policy:{combatLossBoundGp:5}});
  a.plan(s);assert.equal(a.catalogue(s).opportunities.some(g=>g.id==='train-prayer'),false);
});
test('rock crabs and safespot recommendations remain unbound investigations, never invented routes',()=>{
  for(const id of ['rock-crabs','hill-giants','moss-giants']) {
    const lead=inspectTrainingLeads([id],['east-chickens'])[0]!;assert.equal(lead.status,'investigation-required');assert.ok(lead.prerequisites.length);assert.equal(lead.personalAccess,'unverified');
  }
  assert.ok(TRAINING_LEADS.every(l=>!('x' in l)&&!('xpPerHour' in l)));
});
test('guide preference vanishes with evidence and cannot authorize an unsupported site',()=>{
  assert.equal(guidePrior(['lumbridge-chickens'],'east-chickens',0),.5);
  assert.equal(guidePrior(['lumbridge-chickens'],'east-chickens',3),0);
  assert.equal(guidePrior(['rock-crabs'],'invented-rock-crab-coordinates',0),0);
});

test('an existing Prayer milestone can be retained without assuming further XP semantics',()=>{
  const s=state();set(s,'prayer',13);const d=chooseDevelopment(s,memory(),1,'melee');
  assert.equal(d.id,'rune-melee-pure');assert.equal(d.levelCaps?.prayer,13);assert.equal(d.protectedXp.prayer,1200);
});
test('an open strategy can adopt a compatible specialization after new equipment observations',()=>{
  const s=state();s.combatStyle.styles=[];const m=memory(),d=chooseDevelopment(s,m,1);
  assert.equal(d.id,'open-development');s.combatStyle={weaponName:'Shortbow',currentStyle:0,styles:[{index:0,trainsSkills:['ranged']}]};
  s.equipment=[{name:'Shortbow'}];const n=reviewDevelopment(d,s,m,2);
  assert.equal(n.id,'ranged-magic-pure');assert.equal(n.history[0]?.from,'open-development');
});
test('a pure is not adopted during an already-running combat action',()=>{
  const s=state();s.player.combat={inCombat:true};
  assert.equal(chooseDevelopment(s,memory(),1).id,'open-development');
});
test('a missing interface identity cannot match an undefined wildcard reward contract',()=>{
  const r=rules();r.effects['dialogue:undefined:1']={terminal:true,maximumXp:{cooking:10}};
  assert.throws(()=>validateBuildRules(r,identity),/EFFECT_INVALID/);
  const s=state(),d=chooseDevelopment(s,memory(),1);s.dialog={isOpen:true};
  assert.throws(()=>guardDevelopment(d,s,{type:'clickDialogOption',fields:{optionIndex:1}},undefined,r),/REWARD_XP_CONTRACT/);
});
