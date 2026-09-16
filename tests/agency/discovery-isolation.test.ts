import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {localFrontiers,localCell,transitionEvidence,transitionOption} from '../../src/agency/discovery.ts';
import {observeTransferIsolation,isolatedActionAllowed} from '../../src/agency/transaction-isolation.ts';
import {LiveAgency,isSelection,authorizeAction,type Receipt} from '../../src/agency/live-adapter.ts';
import {Director,createMemory} from '../../src/agency/director.ts';
import {verifyActionOutcome} from '../../src/action-outcome.ts';
import {buildCatalogue,emptyKnowledge,defaultPolicy} from '../../src/agency/world-model.ts';
import type {Method} from '../../src/agency/types.ts';
const identity={agent:'new-player',world:'local-test',revision:'rev'};
const state=(tick=1):any=>({character:identity.agent,world:identity.world,profileId:'p',worldEpoch:'e',sessionId:'session',inGame:true,tick,
 capacity:28,player:{worldX:100,worldZ:100,level:0,lifeId:1,respawnCount:0,hp:20,maxHp:20,animId:-1,isDead:false,
 combat:{inCombat:false,targetType:'none',lastDamageTick:-1}},inventory:[],equipment:[],skills:[],nearbyLocs:[],nearbyNpcs:[],
 bank:{isOpen:false,items:[]},shop:{isOpen:false,shopItems:[]},dialog:{isOpen:false,isWaiting:false},modalOpen:false,danger:{active:false}});
const loc=()=>({id:701,name:'Staircase',x:101,z:100,level:0,reachable:true,optionsWithIndex:[{opIndex:2,text:'Climb-up'}]});
const action={id:'independent-observed-step',type:'interactLoc',fields:{locId:701,x:101,z:100,optionIndex:2}};
const m:Method={id:'bounded-work',capability:'production',domain:'crafting',risk:'safe',prerequisites:[],effects:{'xp:production':1},costGp:0,lossBoundGp:0,durationMs:1000};
function transfer():Receipt {const before=state();before.bank={isOpen:true,items:[{id:995,slot:8,count:80,name:'Coins'}]};return {commandId:'old-transfer',scope:'task',methodId:'production-batch',startedAt:1000,before,
 action:{id:'old-withdrawal',type:'bankWithdraw',itemRefs:[{container:'bank',field:'slot',id:995,name:'Coins',minimum:50}],fields:{slot:8,amount:50}}};}

test('new local probes are relative hypotheses, not known reachable routes or seeded tasks',()=>{
 const a=state(),b=state();b.player.worldX+=400;b.player.worldZ+=400;b.player.level=1;
 const one=localFrontiers(a,{}),two=localFrontiers(b,{});assert.ok(one.length>0&&one.length<=12);
 assert.equal(one.length,two.length);assert.equal(two[0]!.x-one[0]!.x,400);assert.equal(two[0]!.level,1);
 const visited=Object.fromEntries(one.map(t=>[localCell(t),'own-position']));
 for(const t of localFrontiers(a,visited)){assert.ok(!visited[localCell(t)]);visited[localCell(t)]='own-position';}
 assert.equal(localFrontiers(a,visited).length,0);
 a.danger.active=true;assert.equal(localFrontiers(a,{}).length,0);
});
test('a planner with no old executable task can choose a bounded local probe, without choosing combat',()=>{
 const s=state(),k=emptyKnowledge(),memory=createMemory(identity);const c=buildCatalogue(identity,s,k,defaultPolicy,['discovery'],memory,1000);
 const d=new Director(memory).next(c.view,c.opportunities,c.methods);assert.equal(d.type,'execute');
 if(d.type==='execute'){const t=c.tasks.get(d.step.methodId)!;assert.equal(t.localProbe,true);assert.equal(t.kind,'discovery');assert.ok(t.route);}
});
test('a probe proposal does not create arrival or learned world facts',()=>{
 const s=state(),k=emptyKnowledge();const c=buildCatalogue(identity,s,k,defaultPolicy,['discovery'],createMemory(identity),1000);
 assert.ok(c.opportunities.length);assert.deepEqual(k.localCells,undefined);
 for(const o of c.opportunities)assert.equal(c.view.facts[o.target.fact]??0,0);
});
test('climbing between floors and mapped interiors has exact observed transition evidence',()=>{
 for(const style of ['Climb-up','Climb up','CLIMB_DOWN'])for(const plane of [true,false]){
   const before=state();before.nearbyLocs=[loc()];before.nearbyLocs[0].optionsWithIndex[0].text=style;
   const after=structuredClone(before);after.tick++;if(plane)after.player.level=1;else after.player.worldZ+=6400;
   const v=verifyActionOutcome(before,after,action);assert.equal(v.verified,true,style);assert.match(v.evidence[0]!,/observed-transition/);
 }
});
test('approaching stairs, stale ticks, a different session or a life change cannot prove a traversal',()=>{
 const before=state();before.nearbyLocs=[loc()];
 for(const mutation of [(a:any)=>{a.player.worldX++},(a:any)=>{a.player.level++;a.tick=1},(a:any)=>{a.player.level++;a.sessionId='other'},(a:any)=>{a.player.level++;a.player.lifeId=2}]){
   const after=structuredClone(before);after.tick++;mutation(after);assert.deepEqual(transitionEvidence(before,after,action),[]);
 }
});
test('an object vanishing is not an opened door; an observed opposite state is',()=>{
 const before=state();before.nearbyLocs=[{...loc(),name:'Door',optionsWithIndex:[{opIndex:2,text:'Open'}]}];
 const after=structuredClone(before);after.tick++;after.nearbyLocs=[];assert.equal(verifyActionOutcome(before,after,action).uncertain,true);
 after.nearbyLocs=[{...before.nearbyLocs[0],id:702,optionsWithIndex:[{opIndex:2,text:'Close'}]}];assert.equal(verifyActionOutcome(before,after,action).verified,true);
});
test('upper-floor discovery IDs use the observed player plane when a location omits it',()=>{
 const s=state();s.player.level=1;s.nearbyLocs=[loc()];delete s.nearbyLocs[0].level;
 const c=buildCatalogue(identity,s,emptyKnowledge(),defaultPolicy,['discovery'],createMemory(identity),1000);
 assert.ok(c.opportunities.some(o=>o.id==='discover:discovered:interaction:701:101:100:1:2'));
});
test('generic reward-bearing open/use surfaces do not gain transition authority',()=>{
 assert.equal(transitionOption({...loc(),name:'Chest',optionsWithIndex:[{opIndex:2,text:'Open'}]}),undefined);
 assert.equal(transitionOption({...loc(),optionsWithIndex:[{opIndex:2,text:'Use'}]}),undefined);
});
test('unknown bank outcomes can be isolated after a fresh continuous baseline without resolving them',()=>{
 const r=transfer(),current=state(100);current.player.lifeId=2;current.player.respawnCount=1;current.sessionId='new';r.before.bank.items=[];
 let window;let result:any;for(let n=0;n<=30;n++){current.tick=100+n;result=observeTransferIsolation(r,current,10000+n*1000,'observer',window);window=result.window;}
 assert.equal(result.ready,true);assert.equal(result.itemId,995);assert.match(result.reason,/remains unresolved/);
 assert.equal(r.action.fields!.amount,50);assert.equal(r.before.player.lifeId,1);
});
test('stale, busy, damaged or incomplete observations and restarts cannot complete isolation',()=>{
 const r=transfer(),s=state(100);const first=observeTransferIsolation(r,s,10000,'a');assert.ok(first.window);
 for(const mutate of [(a:any)=>a.shop.isOpen=true,(a:any)=>a.player.animId=4,(a:any)=>a.danger.active=true,(a:any)=>delete a.equipment,(a:any)=>a.character='other']){
   const a=structuredClone(s);a.tick++;mutate(a);assert.equal(observeTransferIsolation(r,a,41000,'a',first.window).ready,false);
 }
 assert.equal(observeTransferIsolation(r,s,41000,'a',first.window).ready,false);
 s.tick++;assert.equal(observeTransferIsolation(r,s,41000,'b',first.window).ready,false);
});
test('shop transactions, reward choices and advanced executor journals are not silently isolated',()=>{
 for(const type of ['shopBuy','shopSell','clickDialogOption','interactNpc']){const r=transfer();r.action.type=type;assert.equal(observeTransferIsolation(r,state(3),99999,'a').ready,false);}
 const r=transfer();r.before._advanced={};assert.equal(observeTransferIsolation(r,state(3),99999,'a').reason,'ADVANCED_EXECUTOR_RECONCILIATION_REQUIRED');
});
test('isolated action authority blocks equivalent transfers under fresh IDs and changed slots',()=>{
 const s=state();s.nearbyLocs=[loc()];assert.equal(isolatedActionAllowed(action,s),true);
 for(const type of ['bankWithdraw','bankDeposit','shopBuy','shopSell','useInventoryItem','equip','clickDialogOption','interactNpc','useItemOnItem'])
   assert.equal(isolatedActionAllowed({id:'new-id',type,fields:{slot:9,amount:1}},s),false,type);
 assert.equal(isolatedActionAllowed({id:'probe',type:'walkTo',fields:{x:101,z:100,level:0}},s),true);
 s.nearbyLocs[0].name='Unknown reward';assert.equal(isolatedActionAllowed(action,s),false);
});
test('new transfers require a complete open bank at dispatch, including deposits',()=>{
 const s=state();s.inventory=[{slot:0,id:995,count:5,name:'Coins'}];
 const a={id:'deposit',type:'bankDeposit',fields:{slot:0,amount:-1}};
 assert.throws(()=>authorizeAction(s,a,m,0),/FRESH_COMPLETE_BANK/);
 s.bank.isOpen=true;delete s.bank.items;assert.throws(()=>authorizeAction(s,a,m,0),/FRESH_COMPLETE_BANK/);
 s.bank.items=[];assert.equal(authorizeAction(s,a,m,0),0);
});
test('bank verification uses captured identity rather than an obsolete source slot',()=>{
 const r=transfer();r.before.bank.items[0].slot=2;const after=structuredClone(r.before);after.tick++;
 after.bank.items[0].count=30;after.inventory=[{id:995,slot:0,count:50,name:'Coins'}];
 assert.equal(verifyActionOutcome(r.before,after,r.action).verified,true);
});
test('deposit all must reconcile the complete quantity, not just any balanced subset',()=>{
 const before=state();before.bank.isOpen=true;before.inventory=[{slot:0,id:995,count:10}];
 const after=structuredClone(before);after.tick++;after.inventory[0].count=5;after.bank.items=[{slot:4,id:995,count:5}];
 assert.equal(verifyActionOutcome(before,after,{type:'bankDeposit',fields:{slot:0,amount:-1}}).uncertain,true);
});
test('durable isolation preserves original intent, survives restart, permits discovery and never credits success',t=>{
 const dir=mkdtempSync(join(tmpdir(),'isolation-regression-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let now=1000;
 const file=join(dir,'agency.json'),opts={supported:['production','discovery'] as any,now:()=>now};let agency=new LiveAgency(file,identity,opts);
 const before=state();before.bank={isOpen:true,items:[{slot:8,id:995,count:80,name:'Coins'}]};
 const selected=agency.plan(before);assert.ok(isSelection(selected));if(!isSelection(selected))return;
 agency.begin(selected,transfer().action,before,'old-transfer');
 const saved=JSON.parse(readFileSync(file,'utf8'));saved.receipt.before.bank.items=[];writeFileSync(file,JSON.stringify(saved));
 agency=new LiveAgency(file,identity,opts);const after=state(100);after.player.lifeId=2;after.player.respawnCount=1;
 for(let n=0;n<=30;n++){now=10000+n*1000;after.tick=100+n;agency.record('old-transfer',after,{status:'unknown',reason:'source evidence lost',evidence:[]});const done=agency.isolatePendingTransfer(after);assert.equal(done,n===30);}
 assert.equal(agency.pending(),undefined);assert.equal(agency.summary().isolation.active,true);assert.equal(agency.summary().progressHealth.lastProductiveAt,null);
 const archive=JSON.parse(readFileSync(file,'utf8')).unresolvedTransfers[0];assert.equal(archive.receipt.action.fields.amount,50);assert.equal(archive.receipt.before.player.lifeId,1);
 assert.equal(archive.pending.status,'unknown');assert.equal(archive.status,'historically-unresolved');
 agency=new LiveAgency(file,identity,opts);now+=1000000;after.tick++;
 const next=agency.plan(after);assert.ok(isSelection(next));if(!isSelection(next))return;assert.equal(next.task.kind,'discovery');
 assert.equal(agency.eligible({...transfer().action,id:'renamed'},before),false);
 assert.throws(()=>agency.record('old-transfer',after,{status:'verified',evidence:['guessed']}),/AUTHORITATIVE/);
 const a={id:'fresh-probe',type:'walkTo',fields:next.task.route!};assert.doesNotThrow(()=>agency.begin(next,a,after,'fresh-probe-command'));
});
test('no-plan diagnostics distinguish empty capability sets from cooled or unknown-risk methods',()=>{
 const s=state(),memory=createMemory(identity),c=buildCatalogue(identity,s,emptyKnowledge(),defaultPolicy,[],memory,1000),d=new Director(memory);
 const report=d.diagnose(c.view,c.opportunities,c.methods);assert.equal(report.methods,0);
 const mm={...m,risk:'unknown' as const};const op={id:'work',domain:'crafting' as const,target:{fact:'xp:production',minimum:1},reason:'hypothesis',source:'collection' as const,evidence:['own']};
 const diag=d.diagnose({...c.view,capabilities:['production']},[op],[mm]);assert.ok(diag.candidates[0]!.methods[0]!.reasons.includes('unknown-risk'));
});

test('an already-open neighbor or unrelated door appearing cannot prove the requested door changed',()=>{
 const before=state(),requested={...loc(),name:'Door',optionsWithIndex:[{opIndex:2,text:'Open'}]};
 const neighbor={...requested,id:702,x:102,optionsWithIndex:[{opIndex:2,text:'Close'}]};
 before.nearbyLocs=[requested,neighbor];const after=structuredClone(before);after.tick++;
 assert.deepEqual(transitionEvidence(before,after,action),[]);
 after.nearbyLocs=[neighbor];assert.deepEqual(transitionEvidence(before,after,action),[]);
 before.nearbyLocs=[requested];after.nearbyLocs=[requested,neighbor];assert.deepEqual(transitionEvidence(before,after,action),[]);
});
test('a complete quiet bank view permits isolation but never transfer authority',()=>{
 const r=transfer(),s=state(100);r.before.bank.items=[];s.bank={isOpen:true,items:[{id:995,slot:1,count:30}]};s.modalOpen=true;
 let window,result:any;for(let n=0;n<=30;n++){s.tick=100+n;result=observeTransferIsolation(r,s,10000+n*1000,'a',window);window=result.window;}
 assert.equal(result.ready,true);assert.equal(isolatedActionAllowed({id:'fresh',type:'bankWithdraw',fields:{slot:1,amount:1}},s),false);
 s.bank.items[0].count=29;s.tick++;assert.equal(observeTransferIsolation(r,s,41000,'a',window).ready,false);
 delete s.bank.items;assert.equal(observeTransferIsolation(r,s,42000,'a',window).reason,'CURRENT_BANK_ACCOUNTING_INCOMPLETE');
});
