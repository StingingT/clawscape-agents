import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {emptyTrips,preparation,tripKey,observeTrip,recordTripEffect,type TripLearning} from '../../src/agency/trip-logistics.ts';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import {createMemory,Director} from '../../src/agency/director.ts';
import {emptyKnowledge} from '../../src/agency/world-model.ts';
import {observeQuietStep,retryAllowed,recordViability} from '../../src/agency/step-retry.ts';
import {verifyActionOutcome} from '../../src/action-outcome.ts';
import {inspectAgency} from '../../scripts/agency-status.ts';
import {reconcileDeathLoss} from '../../src/agency/reconciliation.ts';
const identity={agent:'test',world:'test',revision:'test'};
const item=(id:number,name:string,slot=0,count=1)=>({id,name,slot,count});
const meal=(slot=0)=>({...item(315,'Shrimps',slot),optionsWithIndex:[{opIndex:1,text:'Eat'}]});
function state(tick=10):any{return {character:'test',world:'test',worldEpoch:'e1',profileId:'test',sessionId:'session',tick,inGame:true,capacity:28,
  player:{lifeId:1,respawnCount:0,worldX:3201,worldZ:3201,level:0,hp:30,maxHp:30,animId:-1,combat:{inCombat:false,targetType:'none'}},
  inventory:[item(1351,'Bronze axe')],equipment:[],skills:[{name:'woodcutting',baseLevel:1,experience:0}],
  bank:{isOpen:false,items:[]},shop:{isOpen:false},dialog:{isOpen:false},modalOpen:false,
  nearbyLocs:[{id:1276,x:3202,z:3201,reachable:true,name:'Tree',optionsWithIndex:[{opIndex:1,text:'Chop down'}]}]};}
function sample(s:any,kind:string,foodUsed:number,at=1){return {key:tripKey(s,kind),at,foodUsed,seconds:60,damage:0,escaped:false,died:false,returned:true,peakUsedSlots:28,capacity:28};}
function fixture(t:any,seed?:any){const dir=mkdtempSync(join(tmpdir(),'trip-tests-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'agency.json');if(seed)writeFileSync(file,JSON.stringify(seed));return {dir,file};}
function saved(trips=emptyTrips()){return {version:2,memory:createMemory(identity),knowledge:emptyKnowledge(),lastCommands:[],trips};}
const chop={type:'interactLoc',fields:{locId:1276,x:3202,z:3201,optionIndex:1}};

test('unmeasured peaceful gathering permits zero food and reserves most inventory for cargo',()=>{
  const p=preparation(state(),'gathering',emptyTrips());assert.equal(p.foodTarget,0);assert.equal(p.cargoSlots,27);assert.equal(p.provisional,true);
});
test('tools consume slots but gathered logs do not turn into extra travel supplies',()=>{
  const s=state();s.inventory.push(item(946,'Knife',1),...Array.from({length:12},(_,i)=>item(1511,'Logs',i+2)));
  const p=preparation(s,'gathering',emptyTrips());assert.equal(p.occupiedToolSlots,2);assert.equal(p.cargoSlots,26);
});
test('a combat cold-start prior is not a fixed minimum and can fall to zero after comparable safe trips',()=>{
  const s=state(),m=emptyTrips();assert.equal(preparation(s,'combat',m).foodTarget,1);
  m.samples=[sample(s,'combat',0)];assert.equal(preparation(s,'combat',m).foodTarget,0);
});
test('recent measured use can raise a reserve and eight uneventful returns can lower it again',()=>{
  const s=state(),m:TripLearning={samples:[sample(s,'gathering',5)]};assert.equal(preparation(s,'gathering',m).foodTarget,5);
  m.samples.push(...Array.from({length:8},(_,i)=>sample(s,'gathering',0,i+2)));
  assert.equal(preparation(s,'gathering',m).foodTarget,0);
});
test('observed damage and emergency exits increase provision estimates, even without confirmed meal consumption',()=>{
  const s=state(),m:TripLearning={samples:[{...sample(s,'gathering',0),damage:18,escaped:true,returned:false}]};
  assert.ok(preparation(s,'gathering',m).foodTarget>0);
});
test('a safe history for a different region or activity does not override the current probe',()=>{
  const s=state(),m:TripLearning={samples:[sample(s,'gathering',6)]};assert.equal(preparation(s,'combat',m).foodTarget,1);
  s.player.worldX+=128;assert.equal(preparation(s,'gathering',m).samples,0);
});
test('same recipe, tools and location ignore food-slot churn in the learned context',()=>{
  const a=state(),b=state(50);b.inventory.push(meal(1));assert.equal(tripKey(a,'gathering'),tripKey(b,'gathering'));
});
test('incomplete interrupted travel is not stored as a successful zero-cost trip',()=>{
  const s=state(),m=emptyTrips();observeTrip(m,s,'gathering',1000);
  const later=state(20);later.sessionId='restarted';observeTrip(m,later,'gathering',2000);
  later.tick++;later.bank.isOpen=true;observeTrip(m,later,'gathering',3000);
  assert.equal(m.samples.length,1);assert.equal(m.samples[0]!.seconds,1,'only the new observed segment is recorded');assert.equal(m.samples[0]!.returned,false,'idle bank visit must not teach a successful zero-food work trip');
});
test('meal consumption is measured from verified Eat, not removal by banking, and command IDs are idempotent',()=>{
  const m=emptyTrips(),s=state();s.inventory.push(meal(1));s.player.hp=20;observeTrip(m,s,'gathering',1000);
  const after=state(11);after.player.hp=23;const eat={type:'useInventoryItem',fields:{slot:1,optionIndex:1}};
  recordTripEffect(m,'eat',s,after,eat,true);recordTripEffect(m,'eat',s,after,eat,true);
  assert.equal(m.active?.foodUsed,1);assert.equal(m.meals?.['315']?.uses,1);
  recordTripEffect(m,'banked-food',s,after,{type:'bankDeposit',fields:{slot:1}},true);assert.equal(m.active?.foodUsed,1);
});
test('old or cross-world responses cannot teach meal usage or cargo returns',()=>{
  const s=state(),m=emptyTrips();s.inventory.push(meal(1));s.player.hp=20;observeTrip(m,s,'gathering',1000);
  const after=state(11);after.worldEpoch='another';after.player.hp=23;
  recordTripEffect(m,'foreign',s,after,{type:'useInventoryItem',fields:{slot:1,optionIndex:1}},true);
  assert.equal(m.active?.foodUsed,0);
});
test('only newly gathered output, subsequently balanced into the bank, counts toward the cargo objective',()=>{
  const m=emptyTrips(),before=state(),gathered=state(11);gathered.inventory.push(item(1511,'Logs',1));gathered.skills[0].experience=25;
  recordTripEffect(m,'gather',before,gathered,chop,true);
  const bank=structuredClone(gathered);bank.tick++;bank.bank.isOpen=true;
  const deposited=state(13);deposited.bank={isOpen:true,items:[item(1511,'Logs',0)]};
  recordTripEffect(m,'bank',bank,deposited,{type:'bankDeposit',fields:{slot:1,amount:1}},true);
  recordTripEffect(m,'bank',bank,deposited,{type:'bankDeposit',fields:{slot:1,amount:1}},true);
  assert.equal(m.bankedCargo,1);
  // Repeating the same deposit with a new ID but no new gathering earns nothing.
  recordTripEffect(m,'redeposit',bank,{...deposited,tick:14},{type:'bankDeposit',fields:{slot:1,amount:1}},true);
  assert.equal(m.bankedCargo,1);
});
test('the live controller selects an inventory-efficient gathering batch, not an arbitrary food-three prerequisite',t=>{
  const f=fixture(t),a=new LiveAgency(f.file,identity,{supported:['food','gathering','bank'],now:()=>1000});
  const p=a.plan(state());assert.ok(isSelection(p));assert.equal(p.decision.goal.id,'gathering-batch');
  assert.equal(p.decision.goal.target.fact,'gathering:banked');assert.equal(p.decision.goal.target.minimum,27);
  assert.ok(!p.decision.goal.supportGoals?.some(s=>s.target.fact==='food'));
});
test('persisted old food-three goals are re-evaluated without rewriting pending execution receipts',t=>{
  const data=saved({samples:[sample(state(),'gathering',3),sample(state(),'exploration',3)]});const f=fixture(t,data);
  let a=new LiveAgency(f.file,identity,{supported:['food'],now:()=>1000});const p=a.plan(state());assert.ok(isSelection(p));
  a.begin(p,{id:'food',type:'wait'},state(),'still-unknown');a.record('still-unknown',state(11),{status:'unknown',evidence:[]});
  const disk=JSON.parse(readFileSync(f.file,'utf8'));disk.trips.samples=[];writeFileSync(f.file,JSON.stringify(disk));
  a=new LiveAgency(f.file,identity,{supported:['food'],now:()=>2000});a.plan(state(12));assert.equal(a.pending()?.commandId,'still-unknown');
  a.record('still-unknown',state(13),{status:'verified',evidence:['read-only wait observed']});a.plan(state(14));
  assert.equal(a.director.memory.active,undefined);assert.ok(a.director.memory.reviews.some(r=>r.result==='partial'));
});
test('obsolete scenery is retired with evidence, not success, and unrelated frontier leads are not dependencies',()=>{
  const memory=createMemory(identity),d=new Director(memory),view:any={...identity,at:1000,context:'test',facts:{},capabilities:['exploration'],budget:{spendableGp:0,maxLossGp:0,maxDeaths:0,maxDurationMs:100000}};
  const goal:any={id:'survey:observed:1281:1:1:0',domain:'exploration',target:{fact:'visited:observed:1281:1:1:0',minimum:1},reason:'old tree',evidence:['tree'],source:'frontier'};
  const method:any={id:goal.id,capability:'exploration',domain:'exploration',effects:{[goal.target.fact]:1},prerequisites:[],costGp:0,lossBoundGp:0,durationMs:1000,risk:'safe'};
  assert.equal(d.next(view,[goal],[method]).type,'execute');d.retireObsoleteSurveys(new Set(),2000);
  assert.equal(memory.active,undefined);assert.equal(memory.reviews[0]?.result,'partial');
});
test('a stable old recipe can settle despite changed historical inventory without claiming that it never executed',()=>{
  const old=state(1);old.inventory=[item(52,'Arrow shaft',0,15),item(314,'Feather',1,15)];
  const now=state(100);now.inventory=[item(53,'Headless arrow',0,15)];const action={type:'useItemOnItem',fields:{sourceSlot:0,targetSlot:1}};
  const first=observeQuietStep(action,old,now,1000,'controller');now.tick++;const done=observeQuietStep(action,old,now,31000,'controller',first.window);
  assert.equal(done.settled,true);assert.match(done.reason,/historical effects are unknown/);
  const memory=recordViability(undefined,'interrupted',31000,'same',0,[done.reason],done.reason);
  assert.equal(retryAllowed(memory,31001,'same',0),false);assert.equal(retryAllowed(memory,31001,'same',1),true);
});
test('volatile feedback metadata does not prevent quiet NPC gathering from settling',()=>{
  const before=state(1);before.nearbyNpcs=[{index:4,id:5,name:'Fishing spot',optionsWithIndex:[{opIndex:1,text:'Net'}]}];
  const action={type:'interactNpc',fields:{npcIndex:4,optionIndex:1}},now=state(100);
  const first=observeQuietStep(action,before,now,1000,'same');now.tick++;now.feedback=[{tick:101}];now.skills[0].currentLevel=0;
  const done=observeQuietStep(action,before,now,31000,'same',first.window);assert.equal(done.settled,true);
});
test('known NPC shop opening is repeatable but its actual purchase is not',()=>{
  const before=state(1);before.nearbyNpcs=[{index:4,id:5,name:'Gerrant',optionsWithIndex:[{opIndex:1,text:'Trade'}]}];
  const action={type:'interactNpc',fields:{npcIndex:4,optionIndex:1}};const first=observeQuietStep(action,before,state(100),1000,'same');
  assert.equal(observeQuietStep(action,before,state(101),31000,'same',first.window).settled,true);
  for(const type of ['shopBuy','shopSell','bankDeposit','bankWithdraw','clickDialogOption','talkToNpc'])
    assert.equal(observeQuietStep({type,fields:{slot:1}},before,state(101),999999,'same',first.window).settled,false);
});
test('busy interfaces and changes of observer cannot be timed out into recipe replay',()=>{
  const before=state(1);before.inventory=[item(946,'Knife'),item(1511,'Logs',1)];const action={type:'useItemOnItem',fields:{sourceSlot:0,targetSlot:1}};
  const first=observeQuietStep(action,before,state(100),1000,'one');
  assert.equal(observeQuietStep(action,before,state(101),31000,'two',first.window).settled,false);
  const busy=state(101);busy.modalOpen=true;assert.equal(observeQuietStep(action,before,busy,31000,'one',first.window).settled,false);
});
test('relevant newly-opened production panels are preparation, not material output success',()=>{
  const before=state(1);before.inventory=[item(946,'Knife'),item(1511,'Logs',1)];
  const after=state(2);after.interface={isOpen:true,options:[{text:'Make 10 Arrow shafts',componentId:1}]};
  const action={type:'useItemOnItem',fields:{sourceSlot:0,targetSlot:1}};
  assert.equal(verifyActionOutcome(before,after,action).verified,true);
  after.interface.options[0].text='Claim reward';assert.equal(verifyActionOutcome(before,after,action).verified,false);
});
test('a command-scoped explicit dispatch refusal is rejected rather than pinned as an unknown mutation',()=>{
  assert.equal(verifyActionOutcome(state(1),state(2),{type:'useItemOnItem'},{success:false,reason:'action_in_progress'}).uncertain,false);
});
test('epoch reset and invalid counts never qualify for automatic death reconciliation',()=>{
  const before=state(1),after=state(2);after.player.lifeId=2;after.worldEpoch='e2';assert.equal(reconcileDeathLoss(before,after).settled,false);
  after.worldEpoch='e1';after.inventory[0].count=-1;assert.equal(reconcileDeathLoss(before,after).settled,false);
});
test('a life change cannot silently settle a pending bank transaction',t=>{
  const f=fixture(t,saved({samples:[sample(state(),'exploration',1),sample(state(),'gathering',1)]}));
  const a=new LiveAgency(f.file,identity,{supported:['food'],now:()=>1000}),before=state();
  before.bank={isOpen:true,items:[{slot:1,id:315,name:'Shrimps',count:1}]};
  const p=a.plan(before);assert.ok(isSelection(p));
  a.begin(p,{id:'transfer',type:'bankWithdraw',fields:{slot:1,amount:1}},before,'bank');const after=state(20);after.player.lifeId=2;
  a.record('bank',after,{status:'unknown',evidence:[]});assert.equal(a.pending()?.commandId,'bank');
});
test('a generic transport failure is still unknown, not a claimed pre-dispatch refusal',()=>{
  assert.equal(verifyActionOutcome(state(1),state(2),{type:'useItemOnItem'},{success:false,reason:'timeout'}).uncertain,true);
});
test('repeated read-only waits cannot count as productive gathering or keep a method active forever',t=>{
  const f=fixture(t),a=new LiveAgency(f.file,identity,{supported:['gathering'],now:()=>now});let now=1000;
  const before=state(1),p=a.plan(before);assert.ok(isSelection(p));a.begin(p,{id:'wait',type:'wait'},before,'idle');
  now+=60_000;a.record('idle',state(100),{status:'verified',evidence:['read-only wait completed']});
  assert.equal(a.director.memory.reviews.length,0);const decision=a.plan(state(101));assert.ok(!isSelection(decision));assert.equal(decision.type,'blocked');
  assert.ok(a.director.memory.active,'retain the objective, not an endless current wait');
});
test('a sticky non-combat NPC target does not permanently prevent idle repeatable gathering settlement',()=>{
  const before=state(1);before.nearbyNpcs=[{index:4,id:5,name:'Fishing spot',optionsWithIndex:[{opIndex:1,text:'Net'}]}];
  const after=state(100);after.player.combat={inCombat:false,targetType:'npc',targetIndex:4};
  const action={type:'interactNpc',fields:{npcIndex:4,optionIndex:1}};
  const first=observeQuietStep(action,before,after,1000,'same');after.tick++;
  assert.equal(observeQuietStep(action,before,after,31000,'same',first.window).settled,true);
  after.player.combat.inCombat=true;
  assert.equal(observeQuietStep(action,before,after,32000,'same',first.window).settled,false);
});
