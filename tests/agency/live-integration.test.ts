import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LiveAgency,isSelection,authorizeAction,safetyAction,type Selection} from '../../src/agency/live-adapter.ts';
import {defaultPolicy,emptyKnowledge,observeFacts,capabilityContext,buildCatalogue} from '../../src/agency/world-model.ts';
import {createMemory} from '../../src/agency/director.ts';
import {verifyActionOutcome} from '../../src/action-outcome.ts';
import {agencyState,agencyCandidate,arbiterVerification,urgentDecision} from '../../agents/advanced/src/agency-bridge.ts';

const identity={agent:'test',world:'test-server',revision:'test-rules'};
const shrimp=(slot:number)=>({id:315,name:'Shrimps',slot,count:1,optionsWithIndex:[{text:'Eat',opIndex:1}]});
const s=(extra:any={})=>({inGame:true,tick:1,player:{hp:30,maxHp:30,lifeId:1,worldX:3232,worldZ:3230,level:0,combat:{inCombat:false,targetType:'none',targetIndex:-1,lastDamageTick:-1}},
  inventory:[],equipment:[],skills:[{name:'attack',level:10,baseLevel:10,experience:100},{name:'defence',level:10,baseLevel:10,experience:100},{name:'strength',level:10,baseLevel:10,experience:100}],
  combatStyle:{weaponName:'Bronze sword',currentStyle:0,styles:[{index:0,trainsSkills:['attack']},{index:1,trainsSkills:['strength']},{index:2,trainsSkills:['defence']}]},...extra});
const verified={status:'verified' as const,evidence:['specific verified effect']};
function fixture(t:any,options:any={}){const dir=mkdtempSync(join(tmpdir(),'agency-integration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let now=1000;const file=join(dir,'agency.json'),config={supported:['food','equipment','bank','combat','exploration'] as any,
    policy:{...defaultPolicy,combatLossBoundGp:20},now:()=>now,...options};
  return {file,config,advance:(n=1000)=>now+=n,agency:new LiveAgency(file,identity,config)};}
function select(a:LiveAgency,state:any):Selection{const r=a.plan(state);assert.ok(isSelection(r));return r;}
const hasKit=()=>s({inventory:Array.from({length:8},(_,i)=>shrimp(i)),equipment:[{id:1277,name:'Bronze sword',slot:3,count:1}]});

test('live goal is a quantitative reserve before an executor is called, not an action flag',t=>{
  const {agency}=fixture(t,{supported:['food']});const p=select(agency,s());
  assert.equal(p.decision.goal.target.fact,'food');assert.equal(p.decision.goal.target.minimum,8);
  assert.equal(p.method.capability,'food');assert.ok(!JSON.stringify(p).includes('action:'));
});
test('one goal survives a bank step, partial food production, serialization and completion',t=>{
  const f=fixture(t,{supported:['food']});let a=f.agency;const before=s();const p=select(a,before);
  a.begin(p,{id:'open-bank',type:'talkToNpc',fields:{npcIndex:7}},before,'bank-command');
  f.advance();const bank=s({tick:2,bank:{isOpen:true,items:[]}});a.record('bank-command',bank,verified);
  assert.equal(a.director.memory.reviews.length,0);assert.equal(a.director.memory.active?.key,p.decision.goal.key);
  assert.equal(Object.values(a.director.memory.methods)[0]?.rejected,0);
  a=new LiveAgency(f.file,identity,f.config);
  for(let n=1;n<=8;n++){
    const pre=s({tick:n+2,inventory:Array.from({length:n-1},(_,i)=>shrimp(i))});const chosen=select(a,pre);
    assert.equal(chosen.decision.goal.key,p.decision.goal.key);
    a.begin(chosen,{id:'cook',type:'useItemOnItem',fields:{sourceSlot:20,targetSlot:21}},pre,'cook-'+n);
    f.advance();a.record('cook-'+n,s({tick:n+3,inventory:Array.from({length:n},(_,i)=>shrimp(i))}),verified);
  }
  assert.equal(a.director.memory.active,undefined);assert.equal(a.director.memory.reviews.length,1);
  assert.equal(a.director.memory.reviews[0]?.result,'success');
});
test('persisted journal uses the actual execution ID and original pre-state',t=>{
  const f=fixture(t,{supported:['food']}),before=s();f.agency.begin(select(f.agency,before),{id:'food',type:'wait'},before,'server-command-42');
  const disk=JSON.parse(readFileSync(f.file,'utf8'));assert.equal(disk.receipt.commandId,'server-command-42');
  assert.equal(disk.memory.pending.commandId,'server-command-42');assert.deepEqual(disk.receipt.before,before);
});
test('unknown retains receipt and does not become a rejected method',t=>{
  const f=fixture(t,{supported:['food']}),a=f.agency,before=s();a.begin(select(a,before),{id:'food',type:'wait'},before,'a');
  a.record('a',s({tick:2}),{status:'unknown',evidence:[],reason:'transport timeout'});
  assert.equal(a.pending()?.commandId,'a');assert.equal(a.director.memory.sequence,0);assert.deepEqual(a.director.memory.methods,{});
  const restarted=new LiveAgency(f.file,identity,f.config);assert.equal((restarted.plan(before) as any).type,'reconcile');
});
test('a different success cannot finalize an old pending command',t=>{
  const {agency:a}=fixture(t,{supported:['food']}),before=s();a.begin(select(a,before),{id:'food',type:'wait'},before,'old');
  assert.throws(()=>a.record('new',s({tick:2,inventory:[shrimp(0)]}),verified),/MATCHING_INTENT/);
  assert.equal(a.pending()?.commandId,'old');
});
test('pending state prevents even a precomputed plan from dispatching another action',t=>{
  const {agency:a}=fixture(t,{supported:['food']}),before=s(),p=select(a,before);a.begin(p,{id:'first',type:'wait'},before,'a');
  assert.throws(()=>a.begin(p,{id:'second',type:'wait'},before,'b'),/RECONCILE/);
});
test('duplicate outcome delivery is harmless even while a newer command is pending',t=>{
  const {agency:a,advance}=fixture(t,{supported:['food']}),before=s();a.begin(select(a,before),{id:'food',type:'wait'},before,'a');
  advance();const after=s({tick:2,inventory:[shrimp(0)]});a.record('a',after,verified);a.begin(select(a,after),{id:'food',type:'wait'},after,'b');
  a.record('a',after,verified);assert.equal(a.pending()?.commandId,'b');assert.equal(a.director.memory.sequence,1);
});
test('after-state inventory is used rather than a synthetic success attached to before-state',t=>{
  const {agency:a,advance}=fixture(t,{supported:['food']}),before=s();a.begin(select(a,before),{id:'food',type:'wait'},before,'a');
  advance();a.record('a',s({tick:2,inventory:[shrimp(0)]}),verified);
  assert.equal(Object.values(a.director.memory.methods)[0]?.productive,1);assert.equal(a.director.memory.reviews.length,0);
});
test('missing evidence remains unknown even when caller says verified',t=>{
  const {agency:a}=fixture(t,{supported:['food']}),before=s();a.begin(select(a,before),{id:'food',type:'wait'},before,'a');
  a.record('a',s({tick:2}),{status:'verified',evidence:[]});assert.ok(a.pending());
});
test('budget is observed coins less reserve, never coins plus a million',t=>{
  const {agency:a}=fixture(t,{supported:['food']});const state=s({inventory:[{id:995,name:'Coins',slot:0,count:40}]});
  assert.equal(a.catalogue(state).view.budget.spendableGp,15);
});
test('a refused purchase never creates a receipt or falls through to dispatch',t=>{
  const {agency:a}=fixture(t,{supported:['food']});const state=s({inventory:[{id:995,name:'Coins',slot:0,count:40}],shop:{isOpen:true,shopItems:[{id:303,slot:0,count:5,buyPrice:20}]}});
  const p=select(a,state);assert.throws(()=>a.begin(p,{id:'buy-net',type:'shopBuy',fields:{slot:0,amount:1}},state,'buy'),/BUDGET/);
  assert.equal(a.pending(),undefined);
});
test('actual successful payment is charged to the task and learned method',t=>{
  const {agency:a,advance}=fixture(t,{supported:['food']});const state=s({inventory:[{id:995,name:'Coins',slot:0,count:100}],shop:{isOpen:true,shopItems:[{id:303,slot:0,count:5,buyPrice:10}]}});
  a.begin(select(a,state),{id:'buy-net',type:'shopBuy',fields:{slot:0,amount:1}},state,'buy');advance();
  const after=s({tick:2,inventory:[{id:995,name:'Coins',slot:0,count:90},{id:303,name:'Small fishing net',slot:1,count:1}]});
  a.record('buy',after,verified);assert.equal(a.director.memory.active?.spentGp,10);assert.equal(Object.values(a.director.memory.methods)[0]?.spentGp,10);
});
test('NPC attack cannot hide behind a safe social or gathering label',t=>{
  const {agency:a}=fixture(t,{supported:['food']});const state=s({nearbyNpcs:[{index:7,reachable:true,optionsWithIndex:[{opIndex:2,text:'Attack'}]}]});
  const p=select(a,state);assert.throws(()=>a.begin(p,{id:'social-looking-label',type:'interactNpc',fields:{npcIndex:7,optionIndex:2}},state),/COMBAT_REQUIRES/);
});
test('combat task has actual supply prerequisites and does not use permanent initial skill caps',t=>{
  const {agency:a}=fixture(t);const catalogue=a.catalogue(hasKit());
  const defence=catalogue.methods.find(m=>m.id==='train-defence')!;
  assert.equal(defence.risk,'bounded');assert.ok(defence.prerequisites.some(p=>p.fact==='food'));
  assert.ok(catalogue.opportunities.some(g=>g.id==='train-defence'&&g.reason.includes('Defence')));
});
test('unknown loss valuation is not silently declared safe',t=>{
  const {agency:a}=fixture(t,{policy:defaultPolicy,supported:['combat']});const result=a.plan(hasKit());
  assert.equal((result as any).type,'blocked');
});
test('equipment or permanent skill changes require revalidation; walking and eating do not reset context',t=>{
  const {agency:a}=fixture(t,{supported:['food']}),state=hasKit();state.inventory=[];const p=select(a,state);
  const moved=structuredClone(state);moved.tick++;moved.player.worldX++;moved.inventory=[shrimp(1)];
  assert.equal(capabilityContext(state),capabilityContext(moved));
  moved.equipment[0].id=1281;assert.throws(()=>a.begin(p,{id:'wait',type:'wait'},moved),/CONTEXT_CHANGED/);
});
test('cross-character or world observations and saved states are rejected',t=>{
  const f=fixture(t,{supported:['food']});select(f.agency,s());
  assert.throws(()=>new LiveAgency(f.file,{...identity,agent:'other'},f.config),/IDENTITY/);
  assert.throws(()=>f.agency.plan(s({character:'other'})),/AGENT_MISMATCH/);
  assert.throws(()=>f.agency.plan(s({world:'other'})),/WORLD_MISMATCH/);
});
test('a safety intent preserves and does not overwrite a pending ordinary intent',t=>{
  const {agency:a}=fixture(t,{supported:['food']}),before=s(),p=select(a,before);a.begin(p,{id:'wait',type:'wait'},before,'ordinary');
  const hurt=s({player:{...before.player,hp:10},inventory:[shrimp(0)]});a.beginSafety({id:'eat',type:'useInventoryItem',fields:{slot:0,optionIndex:1}},hurt,'safety');
  assert.equal(a.pending()?.commandId,'ordinary');assert.equal(a.pending('safety')?.commandId,'safety');
  a.record('safety',s({player:{...before.player,hp:13}}),verified);assert.equal(a.pending()?.commandId,'ordinary');
});
test('ordinary work cannot masquerade as emergency work',t=>{
  const {agency:a}=fixture(t),state=s();state.player.hp=5;
  assert.throws(()=>a.beginSafety({id:'mine',type:'interactLoc'},state),/NOT_AN_URGENT/);
  assert.equal(safetyAction(s(),{id:'close',type:'closeModal'}),false);
});
test('banked items remain personally owned; duplicate inventory slots for separate food items are summed',()=>{
  const k=emptyKnowledge();k.bank=[{id:315,count:3}];const state=s({inventory:[shrimp(0),shrimp(1)]});
  assert.equal(observeFacts(state,k)['owned:315'],5);assert.equal(observeFacts(state,k).food,2);
});
test('all explicit player-attack operations are rejected before dispatch',t=>{
  const {agency:a}=fixture(t,{supported:['food']}),state=s(),p=select(a,state);
  assert.throws(()=>a.begin(p,{id:'pvp',type:'attackPlayer',fields:{playerIndex:1}},state),/PVP/);
});

const action=(type:string,fields:any={})=>({id:'tested-action',type,fields});
test('numeric coin ID 995 and requested item change verify a real purchase',()=>{
  const b=s({inventory:[{id:995,slot:0,count:100}],shop:{isOpen:true,shopItems:[{id:882,slot:1,count:99,buyPrice:2}]}});
  const a=s({tick:2,inventory:[{id:995,slot:0,count:90},{id:882,slot:1,count:5}]});
  assert.equal(verifyActionOutcome(b,a,action('shopBuy',{slot:1,amount:5})).verified,true);
  assert.equal(verifyActionOutcome(b,s({tick:2,inventory:b.inventory}),action('shopBuy',{slot:1,amount:5})).uncertain,true);
});
test('withdrawal resolves the BANK source slot even when the inventory has a conflicting slot',()=>{
  const b=s({bank:{isOpen:true,items:[{id:315,slot:0,count:10}]},inventory:[{id:995,slot:0,count:50}]});
  const a=s({tick:2,bank:{isOpen:true,items:[{id:315,slot:0,count:8}]},inventory:[{id:995,slot:0,count:50},{id:315,slot:1,count:2}]});
  assert.equal(verifyActionOutcome(b,a,action('bankWithdraw',{slot:0,amount:2})).verified,true);
});
test('undefined combat target indices do not produce NaN != NaN false verification',()=>{
  const b=s({nearbyNpcs:[{index:7,optionsWithIndex:[{opIndex:2,text:'Attack'}]}]});
  const a=structuredClone(b);a.tick++;
  assert.equal(verifyActionOutcome(b,a,action('interactNpc',{npcIndex:7,optionIndex:2})).verified,false);
});
test('new engagement must match the requested NPC',()=>{
  const b=s({nearbyNpcs:[{index:7,optionsWithIndex:[{opIndex:2,text:'Attack'}]}]});const a=structuredClone(b);a.tick++;
  a.player.combat={inCombat:true,targetType:'npc',targetIndex:8,lastDamageTick:-1};
  assert.equal(verifyActionOutcome(b,a,action('interactNpc',{npcIndex:7,optionIndex:2})).verified,false);
  a.player.combat.targetIndex=7;assert.equal(verifyActionOutcome(b,a,action('interactNpc',{npcIndex:7,optionIndex:2})).verified,true);
});
test('HP loss or tick advancement is not verification of an unrelated mutation',()=>{
  const b=s(),a=s({tick:2});a.player.hp=20;
  assert.equal(verifyActionOutcome(b,a,action('shopBuy',{slot:0,amount:1})).verified,false);
});
test('closing a dialogue is explicitly verified',()=>{
  assert.equal(verifyActionOutcome(s({dialog:{isOpen:true}}),s({dialog:{isOpen:false},tick:2}),action('closeModal')).verified,true);
});
test('observing a wait is distinct from satisfying a strategic goal',t=>{
  const {agency:a}=fixture(t,{supported:['food']}),before=s();a.begin(select(a,before),action('wait'),before,'wait');
  const after=s({tick:2}),v=verifyActionOutcome(before,after,action('wait'));assert.ok(v.verified);
  a.record('wait',after,{status:'verified',evidence:v.evidence});assert.equal(a.director.memory.reviews.length,0);
});

test('Astra rejects result-to-command mismatches',()=>{
  assert.throws(()=>arbiterVerification('new',{action_id:'old',status:'SUCCEEDED',evidence:['proof']} as any),/ID_MISMATCH/);
});
test('Astra preserves RUNNING, FAILED and post-dispatch cancellations as unknown',()=>{
  for(const status of ['RUNNING','FAILED','CANCELLED'])assert.equal(arbiterVerification('a',{action_id:'a',status,reason:'PREEMPTED_EFFECT_MAY_STILL_COMPLETE',evidence:[]} as any).status,'unknown');
  assert.equal(arbiterVerification('a',{action_id:'a',status:'REJECTED',reason:'SAFETY_INTERRUPT',evidence:[]} as any).status,'rejected');
});
test('Astra requires evidence for success, not merely a status label',()=>{
  assert.equal(arbiterVerification('a',{action_id:'a',status:'SUCCEEDED',evidence:[],reason:'none'} as any).status,'unknown');
});
test('Astra normalizes base skills, actual XP and separate identical food items',()=>{
  const o:any={character:'astra',world:'test',session_id:'s',profile_id:'p',seq:1,tick:1,connected:true,hp:10,max_hp:10,life_id:1,respawns:0,position:{x:1,z:1,plane:0},
    inventory:[0,1].map(slot=>({slot,id:315,name:'Shrimps',count:1,options:[{index:1,text:'Eat'}]})),equipment:[],skills:[{name:'Attack',current:15,base:10,xp:100}],bank:{open:false,items:null},shop_open:false,dialog:{open:false,waiting:false,text:'',options:[]},entities:[]};
  const facts=observeFacts(agencyState(o),emptyKnowledge());assert.equal(facts.food,2);assert.equal(facts['xp:attack'],100);assert.equal(facts['level:attack'],10);
});
test('Astra intent mapping uses actual NPC refs and observed attack indices',()=>{
  const o:any={inventory:[],entities:[{ref:'goblin:7',kind:'npc',index:7,content_id:1,position:{x:1,z:1,plane:0}}]};
  const c=agencyCandidate(o,{goal:'training:attack',reason:'test',intent:{operation:'interact',entity_ref:'goblin:7',option_index:2}});
  assert.equal(c.type,'interactNpc');assert.equal(c.fields?.npcIndex,7);assert.equal(c.fields?.optionIndex,2);
  assert.throws(()=>agencyCandidate(o,{goal:'x',reason:'x',intent:{operation:'interact',entity_ref:'missing',option_index:1}}),/REFERENCE/);
});
test('Astra urgent action is food or interface closure, never a replacement combat task',()=>{
  const o:any={hp:5,max_hp:30,inventory:[{id:315,slot:1,count:1,options:[{text:'Eat',index:1}]}],danger:{damage_margin:2},bank:{open:false},shop_open:false,dialog:{open:false}};
  assert.equal(urgentDecision(o)?.intent?.operation,'eat');o.dialog.open=true;assert.equal(urgentDecision(o)?.intent?.operation,'close_interface');
});
