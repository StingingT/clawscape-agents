import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bindItems,resolveItems,MissingItem,obsoleteEmptyRecipe} from '../../src/agency/item-intents.ts';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import {acquisitionActions,acquisitionSources,emptyAcquisition} from '../../src/agency/acquisition.ts';
import {parseDropScript,listedDropFiles} from '../../src/agency/drop-leads.ts';
import {combatEvents,ownKill} from '../../src/combat-evidence.ts';
const identity={agent:'test',world:'test',revision:'fixture'};
const item=(id:number,name:string,slot:number,count=1)=>({id,name,slot,count});
const state=(tick=1):any=>({character:'test',world:'test',worldEpoch:'1',inGame:true,tick,capacity:28,
 player:{lifeId:1,respawnCount:0,worldX:10,worldZ:10,level:0,hp:30,maxHp:30,animId:-1,combat:{inCombat:false,targetType:'none'}},
 inventory:[item(946,'Knife',5),item(1511,'Logs',3)],equipment:[],skills:[],combatStyle:{weaponName:'Shortbow',styles:[]},bank:{isOpen:false,items:[]},shop:{isOpen:false},dialog:{isOpen:false},modalOpen:false});
const recipe={id:'make-shafts',type:'useItemOnItem',fields:{sourceSlot:5,targetSlot:3}};
function local(t:any){const root=mkdtempSync(join(tmpdir(),'semantic-items-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return join(root,'agency.json');}

test('item identities survive moved slots and an unrelated item occupying the old slot',()=>{
 const before=state(),bound=bindItems(recipe,before),after=state(2);after.inventory=[item(946,'Knife',9),item(1511,'Logs',20),item(995,'Coins',3,10)];
 const action=resolveItems(bound,after);assert.equal(action.fields.sourceSlot,9);assert.equal(action.fields.targetSlot,20);
 assert.equal(bound.fields.targetSlot,3);assert.equal(bound.itemRefs?.[1]?.id,1511);
});
test('bank and shop rows are rebound by identity, not position, and zero-stock rows do not invalidate the snapshot',()=>{
 for(const type of ['bankWithdraw','shopBuy']){
  const before=state(),after=state(2);before.bank={isOpen:true,items:[item(52,'Arrow shaft',7,20)]};after.bank={isOpen:true,items:[item(52,'Arrow shaft',9,20)]};
  before.shop={isOpen:true,shopItems:[item(52,'Arrow shaft',7,20),item(882,'Bronze arrow',8,0)]};after.shop={isOpen:true,shopItems:[item(52,'Arrow shaft',9,20),item(882,'Bronze arrow',8,0)]};
  assert.equal(resolveItems(bindItems({type,fields:{slot:7,amount:1}},before),after).fields!.slot,9);
 }
});
test('same name cannot replace a bound item ID; no remembered action ID can create missing input',()=>{
 const bound=bindItems(recipe,state()),after=state(2);after.inventory=[item(946,'Knife',5),item(999,'Logs',3)];
 assert.throws(()=>resolveItems(bound,after),MissingItem);
 const before=state();before.inventory=before.inventory.filter((i:any)=>i.slot!==3);
 assert.throws(()=>bindItems(recipe,before),/ITEM_REFERENCE_INVALID/);
});
test('a missing input is rejected before the planner can create a new receipt',t=>{
 const file=local(t),s=state();s.inventory=s.inventory.filter((i:any)=>i.id!==1511);
 const a=new LiveAgency(file,identity,{supported:['ammunition']});const p=a.plan(s);assert.ok(isSelection(p));
 assert.throws(()=>a.begin(p,recipe,s,'bad'),/ITEM_REFERENCE_INVALID/);assert.equal(a.pending(),undefined);assert.equal(a.director.memory.pending,undefined);
});
test('old tool/empty-slot receipt can be interrupted, audited and retained as uncertain rather than replayed',t=>{
 let now=1000;const file=local(t),s=state();s.inventory=[item(946,'Knife',5),item(52,'Arrow shaft',0,165)];
 const options={supported:['ammunition'] as any,now:()=>now},a=new LiveAgency(file,identity,options),p=a.plan(s);assert.ok(isSelection(p));
 a.begin(p,{id:'legacy-placeholder',type:'wait'},s,'old');
 // Reproduce the pre-fix invalid historical file, not a newly authorized command.
 const doc=JSON.parse(readFileSync(file,'utf8'));doc.receipt.action=recipe;writeFileSync(file,JSON.stringify(doc));
 const b=new LiveAgency(file,identity,options);assert.equal(b.settleStep('old',state(2)),undefined);
 // Preserve the same observed post-state throughout the quiet window.
 const after=structuredClone(s);after.tick=3;b.settleStep('old',after);now+=30000;after.tick=4;
 const settled=b.settleStep('old',after);assert.equal(settled?.status,'interrupted');b.record('old',after,settled!);
 assert.equal(b.pending(),undefined);assert.notEqual(b.director.memory.reviews[0]?.result,'success');
 const saved=JSON.parse(readFileSync(file,'utf8'));assert.equal(saved.interruptions[0].receipt.action.fields.targetSlot,3);
 assert.equal(saved.interruptions[0].receipt.before.inventory.some((i:any)=>i.id===1511),false);
});
test('empty-slot retirement refuses real target items, incomplete inventory and transactional actions',()=>{
 const s=state(),empty=state(2);empty.inventory=[item(946,'Knife',5)];
 assert.equal(obsoleteEmptyRecipe(recipe,s,empty),false);
 assert.equal(obsoleteEmptyRecipe(recipe,{...empty,unavailable:['inventory']},empty),false);
 assert.equal(obsoleteEmptyRecipe({...recipe,type:'shopBuy'},empty,empty),false);
 assert.equal(obsoleteEmptyRecipe(recipe,{...empty,inventory:[item(999,'Quest knife',5)]},empty),false);
});
test('a missing feather becomes bank acquisition beneath the ammunition parent and resolves only when carried',async t=>{
 let now=1000;const s=state(),file=local(t);s.inventory=[item(52,'Arrow shaft',0,165)];s.bank={isOpen:true,items:[item(314,'Feather',8,100)]};
 const a=new LiveAgency(file,identity,{supported:['ammunition','acquisition'],now:()=>now});const parent=a.plan(s);assert.ok(isSelection(parent));
 a.requestItem({name:'Feather',minimum:15},s,'Prepare headless arrow inputs');const p=a.plan(s);assert.ok(isSelection(p));
 assert.equal(p.task.kind,'acquisition');assert.equal(p.decision.goal.key,parent.decision.goal.key);
 assert.ok(p.decision.goal.supportGoals?.some(n=>n.target.fact==='carried:name:feather'));
 const next=await acquisitionActions(s,p.task,{bank:()=>[],route:async()=>({status:'blocked'}),canFight:()=>false});assert.equal(next.actions[0]?.type,'bankWithdraw');
 a.begin(p,next.actions[0]!,s,'withdraw');now+=1000;const after=structuredClone(s);after.tick++;after.bank.items[0].count=85;after.inventory.push(item(314,'Feather',7,15));
 a.record('withdraw',after,{status:'verified',evidence:['exact inventory and bank delta']});
 assert.equal(a.director.memory.active?.id,'supply-ammunition');assert.equal(a.summary().acquisition?.need,undefined);
});
test('public drop leads are alternatives, not proof, and visiting a source does not acquire the item',async()=>{
 const s=state(),m=emptyAcquisition();s.nearbyNpcs=[{id:41,index:4,name:'Chicken',x:12,z:10,reachable:true,optionsWithIndex:[{opIndex:2,text:'Attack'}]}];
 m.sightings=[{key:'chicken',kind:'drop',item:{name:'unknown',minimum:1},entityId:41,entityName:'Chicken',position:{x:12,z:10,level:0},evidence:'own sighting',confidence:'observed'}];
 const drops=parseDropScript('obj_add(npc_coord, feather, 15, ^lootdrop_duration);','chicken.rs2','a'.repeat(40),'2026-09-15');
 const sources=acquisitionSources(s,[],m,{name:'Feather',minimum:15},drops,[],1000);assert.equal(sources[0]?.confidence,'unverified');
 const task:any={id:'acquire-feather',kind:'acquisition',acquisition:{need:{name:'Feather',minimum:15},source:sources[0]}};
 const denied=await acquisitionActions(s,task,{bank:()=>[],route:async()=>({status:'blocked'}),canFight:()=>false});assert.equal(denied.actions.length,0);
 const allowed=await acquisitionActions(s,task,{bank:()=>[],route:async()=>({status:'blocked'}),canFight:()=>true});assert.equal(allowed.actions[0]?.type,'interactNpc');
 assert.equal(m.lastResolution,undefined);
});
test('drop parser handles data only, excludes configurable/nested drops and does not invent probabilities',()=>{
 assert.deepEqual(listedDropFiles('const f2pDropFiles = ["chicken.rs2"]; const p2pDropFiles = ["rat.rs2","../../bad.rs2"];'),['chicken.rs2','rat.rs2']);
 const result=parseDropScript('// obj_add(npc_coord, fake, 1,x);\nobj_add(npc_coord,npc_param(death_drop),1,x);\nif($rng<32){obj_add(npc_coord,feather,15,x);} gosub(randomherb);','chicken.rs2','b'.repeat(40),'now');
 assert.equal(result.length,1);assert.equal(result[0]?.rate,null);assert.equal(result[0]?.status,'unverified');
 assert.throws(()=>parseDropScript('','../secret.rs2','main','now'),/INVALID/);
});
test('kill events may omit damage, but may not omit the attacker identity',()=>{
 const events=combatEvents([{type:'kill',tick:8,sourceType:'player',sourceIndex:11,targetType:'npc',targetIndex:3},
  {type:'kill',tick:8,targetType:'npc',targetIndex:3}]);assert.equal(events.length,1);assert.equal(ownKill(events,11,3,5,8),true);
 assert.equal(ownKill(events,12,3,5,8),false);assert.equal(ownKill(events,null,3,5,8),false);assert.equal(ownKill(events,11,3,8,9),false);
});
