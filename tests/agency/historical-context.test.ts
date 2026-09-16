import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import {observeHistoricalContext,historicalTraversal,type HistoricalWindow} from '../../src/agency/historical-context.ts';
import {verifyActionOutcome} from '../../src/action-outcome.ts';
import {buildCatalogue,defaultPolicy,emptyKnowledge} from '../../src/agency/world-model.ts';
import {createMemory,Director} from '../../src/agency/director.ts';

const identity={agent:'test-player',world:'test-world',revision:'v1'};
const state=(extra:any={})=>({character:identity.agent,world:identity.world,profileId:'profile',worldEpoch:'epoch',sessionId:'session',
  inGame:true,tick:50_000,capacity:28,
  player:{worldX:10,worldZ:10,level:0,hp:20,maxHp:20,lifeId:1,respawnCount:0,isDead:false,animId:-1,
    combat:{inCombat:false,targetType:'none',lastDamageTick:-1}},
  inventory:[],equipment:[],skills:[],nearbyLocs:[],nearbyNpcs:[],groundItems:[],
  bank:{isOpen:false,items:[]},shop:{isOpen:false,shopItems:[]},dialog:{isOpen:false},modalOpen:false,
  combatStyle:{weaponName:'unarmed',styles:[]},...extra});
function raw(s:any){const r=structuredClone(s);for(const f of ['character','world','profileId','worldEpoch','sessionId'])delete r[f];return r;}
function fixture(t:any,supported:any=['production','exploration','discovery']){
  const dir=mkdtempSync(join(tmpdir(),'historical-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  let now=1000;const file=join(dir,'agency.json');
  const open=()=>new LiveAgency(file,identity,{supported,now:()=>now});
  return {file,open,agency:open(),time:(v:number)=>now=v};
}
function bankStart(a:LiveAgency,before:any,type='bankWithdraw'){
  const plan=a.plan(before);assert.ok(isSelection(plan));
  const action={id:'generic-bank-step',type,itemRefs:[{field:'slot',container:type==='bankWithdraw'?'bank' as const:'inventory' as const,id:995,name:'Coins',minimum:2}],fields:{slot:8,amount:type==='bankWithdraw'?2:-1}};
  a.begin(plan,action,before,'historical-bank');
  a.record('historical-bank',before,{status:'unknown',reason:'original bank source unavailable',evidence:[]});
  return action;
}

test('raw SDK tick reset recovers an old bank receipt only after a new continuous current-context window',t=>{
  const f=fixture(t),a=f.agency;
  const before=raw(state({bank:{isOpen:true,items:[{id:995,name:'Coins',slot:8,count:20}]}}));
  const original=bankStart(a,before);let q:any;
  for(let n=0;n<=6;n++){
    f.time(122_000+n*5000);const current=raw(state({tick:10+n}));
    a.record('historical-bank',current,{status:'unknown',reason:'original bank source unavailable',evidence:[]});
    q=a.quarantinePendingTransaction(current,'original bank source unavailable');
    if(n<6){assert.equal(q,undefined);assert.equal(a.pending()?.commandId,'historical-bank');}
  }
  assert.ok(q);assert.equal(a.pending(),undefined);assert.equal(a.summary().lastOutcome?.status,'quarantined');
  assert.deepEqual(q.originalReceipt.action,original);assert.deepEqual(q.originalReceipt.before,before);
  assert.equal(a.director.memory.learningRevision??0,0);assert.equal(a.director.memory.reviews.some(r=>r.result==='success'),false);
  const fresh=raw(state({tick:17,bank:{isOpen:true,items:[{id:995,name:'Coins',slot:8,count:20}]}}));
  assert.equal(a.eligible(original,fresh),false);a.catalogue(fresh);assert.equal(a.eligible(original,fresh),true);
  const reopened=f.open();const next=reopened.plan(raw(state({tick:18})));assert.ok(isSelection(next));
  assert.throws(()=>reopened.begin(next,original,fresh,'historical-bank'),/QUARANTINED_COMMAND_ID/);
  assert.ok(reopened.quarantinedTransaction('historical-bank')?.originalReceipt);
});

test('changed life and reset ticks can quarantine an old deposit without claiming a loss or transfer result',t=>{
  const f=fixture(t),a=f.agency;const before=state({inventory:[{id:995,name:'Coins',slot:8,count:2}],bank:{isOpen:true,items:[]}});
  bankStart(a,before,'bankDeposit');let q:any;
  for(let n=0;n<=6;n++){
    f.time(122_000+n*5000);const s=state({tick:10+n,player:{...before.player,lifeId:2,respawnCount:1}});
    a.record('historical-bank',s,{status:'unknown',evidence:[],reason:'life changed; losses and intent must be reconciled'});
    q=a.quarantinePendingTransaction(s,'life changed; losses and intent must be reconciled');
  }
  assert.ok(q);assert.equal(a.pending(),undefined);assert.equal(a.director.memory.learningRevision??0,0);
  assert.ok(q.evidence.includes('observed-life-context-change'));assert.equal(a.summary().losses.length,0);
});

test('a server epoch change is assessed from current observations, not compared as an immutable account identity',()=>{
  const before=state();let window:HistoricalWindow|undefined;let result:any;
  for(let n=0;n<=6;n++){result=observeHistoricalContext(before,state({tick:n+1,worldEpoch:'new-epoch'}),100_000+n*5000,'owner',window);window=result.window;}
  assert.equal(result.settled,true);assert.ok(result.evidence.includes('observed-server-epoch-change'));
});

test('time or a new client session alone never establishes historical finality',()=>{
  const before=state();let window:HistoricalWindow|undefined;
  for(let n=0;n<=20;n++){
    const r=observeHistoricalContext(before,state({tick:50_001+n,sessionId:'new-client'}),1_000_000+n*5000,'owner',window);
    window=r.window;assert.equal(r.settled,false);
  }
});

for(const problem of ['other-character','other-world','other-profile','disconnected','danger','moving','dialogue','partial-inventory','bad-rows','repeated-tick','long-gap','clock-rollback','new-owner'] as const)
  test('historical recovery does not bypass '+problem,()=>{
    const before=state();let window:HistoricalWindow|undefined;
    for(let n=0;n<6;n++)window=observeHistoricalContext(before,state({tick:n+1}),100_000+n*5000,'owner',window).window;
    let current=state({tick:7}),now=130_000,owner='owner';
    if(problem==='other-character')current.character='other';
    if(problem==='other-world')current.world='other';
    if(problem==='other-profile')current.profileId='other';
    if(problem==='disconnected')current.inGame=false;
    if(problem==='danger')current.danger={active:true};
    if(problem==='moving')current.player={...current.player,worldX:11};
    if(problem==='dialogue')current.dialog={isOpen:true};
    if(problem==='partial-inventory')current.inventoryComplete=false;
    if(problem==='bad-rows')current.inventory=[{id:995,slot:0,count:-1}];
    if(problem==='repeated-tick')current.tick=6;
    if(problem==='long-gap')now=200_000;
    if(problem==='clock-rollback')now=90_000;
    if(problem==='new-owner')owner='replacement';
    assert.equal(observeHistoricalContext(before,current,now,owner,window).settled,false);
  });

function traversalStart(a:LiveAgency){
  const before=state({player:{...state().player,level:1},nearbyLocs:[{id:71,name:'Ordinary staircase',x:11,z:10,level:1,reachable:true,optionsWithIndex:[{opIndex:1,text:'Climb-down'}]}]});
  const planned=a.plan(before);assert.ok(isSelection(planned));
  const action={id:'observed-traversal',type:'interactLoc',fields:{locId:71,x:11,z:10,optionIndex:1}};
  a.begin(planned,action,before,'old-traversal');a.record('old-traversal',before,{status:'unknown',evidence:[],reason:'unknown'});
  return before;
}

test('an observed ordinary traversal can end historically across a floor and tick reset without invented success',t=>{
  const f=fixture(t),a=f.agency,before=traversalStart(a);let proof:any;
  for(let n=0;n<=6;n++){
    f.time(100_000+n*5000);const current=state({tick:n+1,player:{...before.player,level:0}});
    proof=a.settleStep('old-traversal',current);
    if(n<6)assert.equal(proof,undefined);else a.record('old-traversal',current,proof);
  }
  assert.equal(proof.status,'interrupted');assert.equal(a.pending(),undefined);assert.equal(a.director.memory.active,undefined);
  assert.equal(a.director.memory.learningRevision??0,0);assert.equal(a.director.memory.reviews.some(r=>r.result==='success'),false);
  assert.equal(a.summary().historicalRetirements.at(-1)?.lossAttribution,'unknown');
  const saved=JSON.parse(readFileSync(f.file,'utf8'));saved.lastCommands=[];writeFileSync(f.file,JSON.stringify(saved));
  const b=f.open(),next=b.plan(state({tick:8}));assert.ok(isSelection(next));
  assert.throws(()=>b.begin(next,{id:'new-name',type:'wait'},state({tick:8}),'old-traversal'),/HISTORICAL_COMMAND_ID/);
  assert.doesNotThrow(()=>b.record('old-traversal',state({tick:8}),{status:'verified',evidence:['late-unrelated']}));
});

test('a changed-life traversal retains unvalued history instead of fabricating death accounting',t=>{
  const f=fixture(t),a=f.agency,before=traversalStart(a);
  for(let n=0;n<=6;n++){
    f.time(100_000+n*5000);const current=state({tick:n+1,player:{...before.player,level:0,lifeId:2,respawnCount:1}});
    const proof=a.settleStep('old-traversal',current);if(proof)a.record('old-traversal',current,proof);
  }
  assert.equal(a.pending(),undefined);assert.equal(a.summary().historicalRetirements.at(-1)?.lossAttribution,'unknown');
  assert.equal(a.summary().losses.length,0);assert.equal(a.director.memory.learningRevision??0,0);
});

test('an interrupted runtime cannot inherit another controllers partially measured historical window',t=>{
  const f=fixture(t);let a=f.agency;traversalStart(a);
  for(let n=0;n<6;n++){f.time(100_000+n*5000);assert.equal(a.settleStep('old-traversal',state({tick:n+1})),undefined);}
  a=f.open();f.time(130_000);assert.equal(a.settleStep('old-traversal',state({tick:7})),undefined);assert.ok(a.pending());
});

test('unknown choices, rewards and absent original objects cannot use ordinary traversal retirement',()=>{
  const before=state({nearbyLocs:[{id:71,name:'Reward chest',x:11,z:10,level:0,optionsWithIndex:[{opIndex:1,text:'Open'}]}]});
  for(const action of [{type:'interactLoc',fields:{locId:71,x:11,z:10,optionIndex:1}},
    {type:'interactLoc',fields:{locId:99,x:11,z:10,optionIndex:1}},{type:'clickDialogOption',fields:{optionIndex:1}},
    {type:'shopBuy',fields:{slot:0,amount:1}},{type:'bankWithdraw',fields:{slot:0,amount:1}}])assert.equal(historicalTraversal(action,before),false);
});

test('a historical marker without a measured matching window cannot clear the receipt',t=>{
  const f=fixture(t),a=f.agency;traversalStart(a);f.time(500_000);
  a.record('old-traversal',state({tick:1}),{status:'interrupted',historical:true,recovery:'investigate',evidence:['historical-context-retired']});
  assert.equal(a.pending()?.commandId,'old-traversal');assert.equal(a.summary().lastOutcome?.status,'unknown');
});

test('exhausted navigation releases its bounded survey and selects a different feasible goal',t=>{
  const f=fixture(t,['exploration']),a=f.agency,before=state();const selected=a.plan(before);assert.ok(isSelection(selected));
  const route=selected.task.route!;assert.ok(route);
  const action={id:'nav',type:'walkTo',fields:{x:route.x,z:route.z,level:route.level}};
  a.begin(selected,action,before,'failed-probe');const result={navigation:{status:'blocked',reason:'door-retry-budget',movementDispatched:false}};
  a.rememberExecution('failed-probe',result);f.time(2000);const after=state({tick:50_001});
  const checked=verifyActionOutcome(before,after,action,result);assert.equal(checked.interrupted,true);
  a.record('failed-probe',after,{status:'interrupted',evidence:checked.evidence,reason:checked.reason});
  assert.equal(a.pending(),undefined);assert.equal(a.director.memory.active,undefined);
  assert.match(a.summary().routeFailures?.[route.id]?.reason??'',/EXHAUSTED_NAVIGATION/);
  const next=a.plan(after);assert.ok(isSelection(next));assert.notEqual(next.decision.goal.id,selected.decision.goal.id);
  assert.equal(a.director.memory.reviews.at(-1)?.result,'partial');
});

test('valid partial navigation keeps its objective and does not enter exhausted-route recovery',t=>{
  const f=fixture(t,['exploration']),a=f.agency,before=state(),selected=a.plan(before);assert.ok(isSelection(selected));
  const route=selected.task.route!,action={id:'nav',type:'walkTo',fields:{x:route.x,z:route.z,level:route.level}};
  a.begin(selected,action,before,'partial');a.rememberExecution('partial',{navigation:{status:'progress',movementDispatched:true}});
  const after=state({tick:50_001,player:{...before.player,worldX:before.player.worldX+Math.sign(route.x-before.player.worldX),worldZ:before.player.worldZ+Math.sign(route.z-before.player.worldZ)}});
  f.time(2000);a.record('partial',after,{status:'verified',evidence:['verified route leg; not arrival']});
  assert.equal(a.director.memory.active?.id,selected.decision.goal.id);assert.equal(a.summary().routeFailures?.[route.id],undefined);
});

test('repeated reports of one planner refusal cannot move its recheck deadline forever',()=>{
  const memory=createMemory(identity),d=new Director(memory);
  const view:any={...identity,context:'same',at:1000,facts:{goalA:0,goalB:0},capabilities:['probe'],budget:{spendableGp:0,maxLossGp:0,maxDeaths:0,maxDurationMs:1_000_000}};
  const method=(id:string):any=>({id,capability:'probe',domain:'exploration',effects:{[id]:1},prerequisites:[],costGp:0,lossBoundGp:0,durationMs:1000,risk:'safe'});
  const goal=(id:string):any=>({id,domain:'exploration',target:{fact:id,minimum:1},source:'frontier',reason:'Observed option',evidence:['own']});
  const methods=[method('goalA'),method('goalB')],goals=[goal('goalA'),goal('goalB')];
  assert.equal(d.next(view,goals,methods).type,'execute');d.blocked(2000,'same observed refusal');
  const deadline=memory.active!.blocker!.recheckAt;
  for(let at=3000;at<32_000;at+=1000)d.blocked(at,'same observed refusal');
  assert.equal(memory.active!.blocker!.recheckAt,deadline);
  for(const at of [32_000,62_000,92_000])d.next({...view,at},goals,methods);
  assert.equal(memory.active?.id,'goalB');
});

test('exhausted discovery has an explicit bounded retry time and does not suppress normal production',()=>{
  const memory=createMemory(identity);const template:any={domain:'exploration',target:{fact:'visited:x',minimum:1},reason:'probe',evidence:['own'],source:'frontier',key:'k',context:'c',startedAt:1,budget:{spendableGp:0,maxLossGp:0,maxDeaths:0,maxDurationMs:1},baseline:0,spentGp:0,lostGp:0,deaths:0,elapsedMs:0,attempts:1,noProgress:0};
  memory.reviews=[{goal:{...template,id:'survey:local-probe:a'},at:900,result:'success',reason:'done',evidence:['own']},
    {goal:{...template,id:'survey:local-probe:b'},at:950,result:'partial',reason:'exhausted',evidence:['own']}];
  const c=buildCatalogue(identity,state(),emptyKnowledge(),defaultPolicy,['exploration','production'],memory,1000);
  assert.equal(c.discoveryRetryAt,600_900);assert.equal(c.opportunities.some(o=>o.id.startsWith('survey:local-probe:')),false);
  const decision=new Director(memory).next(c.view,c.opportunities,c.methods);assert.equal(decision.type,'execute');
  if(decision.type==='execute')assert.equal(decision.goal.id,'production-batch');
});
