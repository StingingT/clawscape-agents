import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Director,createMemory} from '../../src/agency/director.ts';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import {effectState,recordProgress,progressHealth,reversibleCycle,type ProgressLedger} from '../../src/agency/progress.ts';
import {observeQuietStep} from '../../src/agency/step-retry.ts';
import type {Goal,Pending,Outcome,Facts,Observation,Method,Opportunity} from '../../src/agency/types.ts';

const identity={agent:'unfamiliar-player',world:'test',revision:'v1'};
const budget={spendableGp:100,maxLossGp:10,maxDeaths:1,maxDurationMs:1_800_000};
const method:Method={id:'make',capability:'production',domain:'crafting',effects:{'xp:production':100},prerequisites:[],costGp:0,lossBoundGp:0,durationMs:1000,risk:'safe'};
const objective:Opportunity={id:'make',domain:'crafting',target:{fact:'xp:production',minimum:1000},reason:'Observed usable recipe',source:'collection',evidence:['own-recipe']};
const view=(facts:Facts={},at=1000):Observation=>({...identity,at,context:'same-kit',facts,budget,capabilities:['production']});
const goal=():Goal=>({...objective,key:'goal',context:'same-kit',startedAt:1000,budget,baseline:0,spentGp:0,lostGp:0,deaths:0,elapsedMs:0,attempts:0,noProgress:0});
const pending=(before:Facts,targets= [objective.target]):Pending=>({commandId:'command',goalKey:'goal',context:'same-kit',method,before,status:'pending',progressTargets:targets});
const outcome=(facts:Facts,at=2000):Outcome=>({commandId:'command',sequence:1,status:'progress',at,facts,spentGp:0,lostGp:0,deaths:0,elapsedMs:1000,evidence:['own-attributed-effect'],actionType:'bankWithdraw'});

// State changes and evidence of execution are deliberately not interchangeable
// with progress toward the selected dependency chain.
test('unrelated balance transfers do not reset the preparation watchdog or learning',()=>{
 const d=new Director(createMemory(identity));let facts:Facts={'xp:production':0,'owned:40':10,'carried:40':0};
 for(let n=1;n<=3;n++){
   const selection=d.next(view(facts,1000*n),[objective],[method]);assert.equal(selection.type,'execute');
   d.begin(view(facts,1000*n),selection,method,`fresh-id-${n}`);
   facts={...facts,'carried:40':n%2?10:0};
   d.record({...outcome(facts,1000*n+100),commandId:`fresh-id-${n}`,sequence:n,actionType:n%2?'bankWithdraw':'bankDeposit'});
 }
 assert.equal(d.memory.progress?.lastProductiveAt,undefined);
 assert.equal(d.memory.progress?.lastVerifiedAt,3100);
 assert.equal(d.memory.learningRevision??0,0);
 assert.equal(d.memory.active?.noProgress,3);
 assert.match(d.memory.active?.blocker?.reason??'',/repeated preparation/);
});

test('an actual committed prerequisite earns credit, but withdrawal redeposit and rewithdrawal cannot farm it',()=>{
 const g=goal(),target={fact:'carried:40',minimum:2};let p:ProgressLedger|undefined;
 p=recordProgress(p,g,pending({'carried:40':0},[g.target,target]),outcome({'carried:40':2},2000));
 assert.equal(p.last?.prerequisite,true);assert.equal(p.lastProductiveAt,2000);
 p=recordProgress(p,g,pending({'carried:40':2},[g.target,target]),outcome({'carried:40':0},3000));
 p=recordProgress(p,g,pending({'carried:40':0},[g.target,target]),outcome({'carried:40':2},4000));
 assert.equal(p.last?.productive,false);assert.equal(p.lastProductiveAt,2000);
});

test('a downstream verified product enables fresh input credit for the next real batch',()=>{
 const g=goal(),target={fact:'carried:40',minimum:2};let p:ProgressLedger|undefined;
 p=recordProgress(p,g,pending({'carried:40':0},[g.target,target]),outcome({'carried:40':2},2000));
 p=recordProgress(p,g,pending({'carried:40':2,'xp:production':0}),{...outcome({'carried:40':0,'xp:production':100},3000),status:'verified',actionType:'useItemOnItem'});
 assert.equal(p.last?.objective,true);
 p=recordProgress(p,g,pending({'carried:40':0,'xp:production':100},[g.target,target]),outcome({'carried:40':2,'xp:production':100},4000));
 assert.equal(p.last?.prerequisite,true);assert.equal(p.lastProductiveAt,4000);
});

test('unknown, rejected and interrupted actions cannot earn reward from coincidental positive facts',()=>{
 for(const status of ['unknown','rejected','interrupted'] as const){
   const p=recordProgress(undefined,goal(),pending({'xp:production':0}),{...outcome({'xp:production':100}),status});
   assert.equal(p.last?.productive,false);assert.equal(p.last?.learning,false);
 }
});

test('cycle detection follows effect states rather than command names or goals',()=>{
 let p:ProgressLedger|undefined;
 for(let i=0;i<4;i++){
   const g={...goal(),key:`different-goal-${i}`};
   p=recordProgress(p,g,{...pending({}),commandId:`random-${i}`},{...outcome({},2000+i),commandId:`random-${i}`,
     effectState:{before:i%2?'equipped':'unequipped',after:i%2?'unequipped':'equipped'}});
 }
 assert.equal(p?.last?.cycle,true);assert.equal(progressHealth({progress:p},2100).stalled,true);
 assert.equal(reversibleCycle(['a','b','c','a','b','c','a']),true);
 assert.equal(reversibleCycle(['a','b','c','d','e']),false);
});

test('productive batches with the same action names are not reversible cycles',()=>{
 let p:ProgressLedger|undefined;const g=goal();
 for(let n=1;n<=6;n++)p=recordProgress(p,g,pending({'xp:production':n-1}),{...outcome({'xp:production':n},n*1000),actionType:'useItemOnItem'});
 assert.equal(p?.last?.cycle,false);assert.equal(p?.noProgressActions,0);assert.equal(p?.lastProductiveAt,6000);
});

test('registered gathering XP is real progress toward a banked cargo goal; arbitrary inventory changes are not',()=>{
 const g={...goal(),target:{fact:'gathering:banked',minimum:20}};
 const m={...method,effects:{'gathering:banked':20},progressFacts:['xp:gathering']};
 const p=recordProgress(undefined,g,{...pending({'xp:gathering':0}),method:m},outcome({'xp:gathering':25},2000));
 assert.equal(p.last?.learning,true);assert.equal(p.last?.objective,false);
 const next=recordProgress(p,g,{...pending({'xp:gathering':25,'carried:40':0}),method:m},outcome({'xp:gathering':25,'carried:40':10},3000));
 assert.equal(next.last?.productive,false);assert.equal(next.lastProductiveAt,2000);
});

test('inventory slot permutations, packet ticks and NPC movement do not hide a personal state cycle',()=>{
 const a={character:'test',player:{worldX:1,worldZ:1,level:0,lifeId:1},inventory:[{id:40,slot:0,count:1},{id:41,slot:1,count:2}],nearbyNpcs:[],tick:1};
 const b={...a,tick:999,inventory:[{id:41,slot:0,count:2},{id:40,slot:1,count:1}],nearbyNpcs:[{id:1,x:999}]};
 assert.equal(effectState(a,{'owned:40':1}),effectState(b,{'owned:40':1}));
 assert.notEqual(effectState(a,{}),effectState({...b,player:{...b.player,worldX:2}},{}));
});

test('route approach credit uses best distance to the same endpoint, not oscillating waypoints',()=>{
 const g=goal();let p:ProgressLedger|undefined;
 for(const [at,before,after] of [[2000,10,8],[3000,8,10],[4000,10,8]])
   p=recordProgress(p,g,pending({}),{...outcome({},at),actionType:'walkTo',approach:{key:'endpoint',before:before!,after:after!}});
 assert.equal(p?.lastProductiveAt,2000);assert.equal(p?.last?.productive,false);
});

test('persistent health does not reset when a goal is changed or a process journal is reloaded',()=>{
 const p=recordProgress(undefined,goal(),pending({}),outcome({},2000));
 const memory=JSON.parse(JSON.stringify({progress:p,active:{...goal(),startedAt:301999}}));
 const health=progressHealth(memory,302001);
 assert.equal(health.stalled,true);assert.equal(health.lastVerifiedActionAt,2000);assert.equal(health.lastProductiveAt,null);
});

const live=(tick=1):any=>({...identity,worldEpoch:'epoch',profileId:'test',sessionId:'session',inGame:true,tick,capacity:28,
 player:{lifeId:1,respawnCount:0,hp:20,maxHp:20,worldX:10,worldZ:10,level:0,animId:-1,combat:{inCombat:false,targetType:'none',lastDamageTick:-1}},
 inventory:[],equipment:[],skills:[],bank:{isOpen:false,items:[]},shop:{isOpen:false,shopItems:[]},dialog:{isOpen:false},modalOpen:false,
 nearbyLocs:[{id:41,name:'Observed obstruction',x:11,z:10,level:0,distance:1,reachable:true,optionsWithIndex:[{opIndex:1,text:'Open'}]},
 {id:42,name:'Another observed obstruction',x:12,z:10,level:0,distance:2,reachable:true,optionsWithIndex:[{opIndex:1,text:'Open'}]}]});
function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'causal-progress-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 let now=1000;const file=join(dir,'agency.json');
 const agency=new LiveAgency(file,identity,{supported:['discovery'],now:()=>now});
 return {agency,file,time:(n:number)=>now=n};
}

test('an unknown local interaction receives bounded investigation then a different discovered approach, never replay or success',t=>{
 const f=fixture(t),a=f.agency,b=live(),selected=a.plan(b);assert.ok(isSelection(selected));
 a.begin(selected,{id:'observation-selected',type:'interactLoc',fields:{locId:41,x:11,z:10,optionIndex:1}},b,'original');
 a.record('original',live(2),{status:'unknown',evidence:[],reason:'No attributable effect'});
 f.time(2000);assert.equal(a.settleStep('original',live(3)),undefined);
 assert.equal(a.pending()?.commandId,'original');assert.ok(a.pending()?.investigation);
 f.time(32001);const settled=a.settleStep('original',live(40));assert.equal(settled?.status,'interrupted');
 a.record('original',live(40),settled!);
 assert.equal(a.pending(),undefined);assert.equal(a.director.memory.reviews.at(-1)?.result,'partial');
 assert.equal(a.director.memory.learningRevision??0,0);
 assert.equal(JSON.parse(readFileSync(f.file,'utf8')).interruptions[0].receipt.commandId,'original');
 const next=a.plan(live(41));assert.ok(isSelection(next));assert.notEqual(next.task.id,selected.task.id);
 assert.match(next.task.id,/:42:12:10:0:1$/);
});

test('restarting alone cannot bypass the quiet investigation of an old interaction',t=>{
 const {agency:a,time}=fixture(t),b=live(),selected=a.plan(b);assert.ok(isSelection(selected));
 a.begin(selected,{id:'observed',type:'interactLoc',fields:{locId:41,x:11,z:10,optionIndex:1}},b,'old');
 time(5000);assert.equal(a.retireRestartPending('task',live(2),live(3),'restart'),false);
 assert.equal(a.pending()?.commandId,'old');assert.equal(a.director.memory.reviews.length,0);
});

test('quiet investigation does not retire transactions or unclassified reward/choice interactions',()=>{
 for(const type of ['bankDeposit','bankWithdraw','shopBuy','shopSell','clickDialogOption','talkToNpc']){
   assert.equal(observeQuietStep({type,fields:{optionIndex:1}},live(),live(90),100000,'observer').settled,false);
 }
 const b=live();b.nearbyLocs[0].name='Reward chest';
 const action={type:'interactLoc',fields:{locId:41,x:11,z:10,optionIndex:1}};
 assert.equal(observeQuietStep(action,b,{...b,tick:90},100000,'observer').settled,false);
});

test('fresh danger, active dialogue, repeated ticks and world changes prevent quiet retirement',()=>{
 const b=live(),action={type:'interactLoc',fields:{locId:41,x:11,z:10,optionIndex:1}};
 const window=observeQuietStep(action,b,live(2),2000,'observer').window;
 for(const change of [(s:any)=>s.danger={active:true},(s:any)=>s.dialog.isOpen=true,
   (s:any)=>s.tick=2,(s:any)=>s.worldEpoch='other',(s:any)=>s.player.combat.lastDamageTick=40]){
   const s=live(40);change(s);assert.equal(observeQuietStep(action,b,s,32001,'observer',window).settled,false);
 }
});

test('a stale bank-opening interaction can yield to the fresh observed interface without retrying a transfer',()=>{
 const b=live();b.bank={isOpen:true,items:[{id:40,slot:0,count:3}]};
 b.nearbyNpcs=[{index:5,id:91,name:'Observed storage service',optionsWithIndex:[{opIndex:2,text:'Bank'}]}];
 const action={type:'interactNpc',fields:{npcIndex:5,optionIndex:2}};
 const first={...b,tick:2},last={...b,tick:40};
 const window=observeQuietStep(action,b,first,2000,'observer').window;assert.ok(window);
 assert.equal(observeQuietStep(action,b,last,32001,'observer',window).settled,true);
 assert.equal(observeQuietStep({type:'bankWithdraw',fields:{slot:0,amount:1}},b,last,32001,'observer',window).settled,false);
});

test('productive-progress deadline cannot clear an unresolved command',t=>{
 const {agency:a,time}=fixture(t),b=live(),selected=a.plan(b);assert.ok(isSelection(selected));
 a.begin(selected,{id:'old',type:'interactLoc',fields:{locId:41,x:11,z:10,optionIndex:1}},b,'old');
 a.record('old',live(2),{status:'unknown',evidence:[]});time(800000);
 assert.equal(a.checkProgress(live(90)),false);assert.equal(a.pending()?.commandId,'old');
 assert.equal(a.summary().progressHealth.stalled,true);
});
