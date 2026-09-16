import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';
import { observeHistoricalContext, type HistoricalWindow } from '../../src/agency/historical-context.ts';

const identity={agent:'test-player',world:'test-world',revision:'test'};
const state=(tick:number):any=>({character:identity.agent,world:identity.world,profileId:'test',worldEpoch:'old-epoch',sessionId:'old-session',
  inGame:true,tick,player:{worldX:10,worldZ:10,level:0,lifeId:1,respawnCount:0,hp:30,maxHp:30,animId:-1,
    combat:{inCombat:false,targetType:'none',lastDamageTick:-1}},inventory:[],equipment:[],skills:[],nearbyNpcs:[],
  nearbyLocs:[{id:7123,name:'Staircase',x:10,z:11,level:0,reachable:true,optionsWithIndex:[{text:'Climb-down',opIndex:1}]}],
  bank:{isOpen:true,items:[{slot:7,id:41,name:'Test material',count:5}]},shop:{isOpen:false},dialog:{isOpen:false},modalOpen:false});
const withdraw={id:'prerequisite',type:'bankWithdraw',fields:{slot:7,amount:1}};
const transition={id:'observed-transition',type:'interactLoc',fields:{x:10,z:11,locId:7123,optionIndex:1}};
const current=(tick:number):any=>{const s=state(tick);s.sessionId='new-session';s.worldEpoch='new-epoch';s.bank={isOpen:false};return s;};

function fixture(t:any,action:any=withdraw,editBefore?:(s:any)=>void) {
  const dir=mkdtempSync(join(tmpdir(),'historical-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  let now=1000;const file=join(dir,'agency.json');
  const options={supported:['production','exploration','discovery'] as any,now:()=>now};
  const agency=new LiveAgency(file,identity,options),before=state(50_000);editBefore?.(before);
  const selected=agency.plan(before);assert.ok(isSelection(selected));
  agency.begin(selected,action,before,'old-command');agency.record('old-command',before,{status:'unknown',reason:'outcome unknown',evidence:[]});
  const original=structuredClone(agency.pending()!.before);
  return {agency,file,options,original,setNow:(v:number)=>now=v};
}
function observeSeries(a:LiveAgency,setNow:(v:number)=>void,make:(tick:number)=>any=current,start=200_000) {
  let result;
  for(let n=0;n<=3;n++){setNow(start+n*10_000);result=a.quarantinePendingTransaction(make(10+n),'original bank source unavailable');}
  return result;
}

test('a restarted low-tick bank receipt needs a CURRENT quiet window, then permits unrelated replanning',t=>{
  const f=fixture(t);f.setNow(200_000);
  assert.equal(f.agency.quarantinePendingTransaction(current(10),'original bank source unavailable'),undefined);
  assert.ok(f.agency.pending()?.historicalWindow);assert.equal(f.agency.summary().lastOutcome?.status,'unknown');
  for(let n=1;n<3;n++){f.setNow(200_000+n*10_000);assert.equal(f.agency.quarantinePendingTransaction(current(10+n),'original bank source unavailable'),undefined);}
  f.setNow(230_000);const q=f.agency.quarantinePendingTransaction(current(13),'original bank source unavailable');
  assert.ok(q);assert.equal(q.active,true);assert.deepEqual((q.originalReceipt as any).before,f.original);
  assert.equal(f.agency.pending(),undefined);assert.equal(f.agency.director.memory.pending,undefined);
  assert.equal(f.agency.director.memory.learningRevision??0,0);assert.equal(f.agency.summary().progressHealth.lastProductiveAt,null);
  assert.equal(f.agency.summary().lastOutcome?.status,'quarantined');assert.ok(isSelection(f.agency.plan(current(14))));
});

test('a historical life-changed deposit with reset ticks is accounted administratively, not as a successful deposit or death valuation',t=>{
  const action={id:'store-output',type:'bankDeposit',fields:{slot:0,amount:-1}};
  const f=fixture(t,action,s=>{s.inventory=[{slot:0,id:41,name:'Test material',count:2}];});
  const make=(tick:number)=>{const s=current(tick);s.player.lifeId=2;s.player.respawnCount=1;return s;};
  assert.ok(observeSeries(f.agency,f.setNow,make));
  assert.equal(f.agency.pending(),undefined);assert.equal(f.agency.summary().losses.length,0);
  assert.equal(f.agency.director.memory.reviews.at(-1)?.result,'partial');
  assert.equal(f.agency.director.memory.reviews.at(-1)?.goal.deaths,0);
  assert.deepEqual((f.agency.quarantinedTransaction('old-command')!.originalReceipt as any).before,f.original);
});

test('an observed transition across a floor/reset releases only its old command and does not learn a fictitious success',t=>{
  const f=fixture(t,transition,s=>{s.player.level=1;s.nearbyLocs[0].level=1;});
  const make=(tick:number)=>{const s=current(tick);s.player.level=0;return s;};
  assert.ok(observeSeries(f.agency,f.setNow,make));
  const q=f.agency.quarantinedTransaction('old-command')!;
  assert.equal(q.active,false);assert.ok(q.evidence.includes('historical-navigation-context'));
  assert.equal(f.agency.pending(),undefined);assert.equal(f.agency.director.memory.learningRevision??0,0);
  assert.deepEqual((q.originalReceipt as any).before,f.original);
  assert.equal(Object.keys(JSON.parse(readFileSync(f.file,'utf8')).knowledge.discovered).length,0);
});

test('original command IDs remain banned after fresh bank accounting, restart and bounded recent-command eviction',t=>{
  const f=fixture(t);assert.ok(observeSeries(f.agency,f.setNow));
  const fresh=current(14);fresh.bank={isOpen:true,complete:true,items:[{slot:7,id:41,name:'Test material',count:5}]};
  assert.equal(f.agency.eligible(withdraw,fresh),false);
  // The quarantine observation itself never releases its accounting barrier.
  const same={...fresh,tick:13};f.agency.catalogue(same);assert.equal(f.agency.quarantinedTransaction('old-command')!.active,true);
  f.agency.catalogue(fresh);assert.equal(f.agency.quarantinedTransaction('old-command')!.active,false);
  const doc=JSON.parse(readFileSync(f.file,'utf8'));doc.lastCommands=[];writeFileSync(f.file,JSON.stringify(doc));
  const reloaded=new LiveAgency(f.file,identity,f.options),plan=reloaded.plan(current(15));assert.ok(isSelection(plan));
  assert.throws(()=>reloaded.begin(plan,{id:'new',type:'walkTo',fields:{x:13,z:10,level:0}},current(15),'old-command'),/QUARANTINED_COMMAND_ID_CANNOT_BE_REUSED/);
  assert.doesNotThrow(()=>reloaded.record('old-command',fresh,{status:'verified',evidence:['late-old-event']}));
  assert.equal(reloaded.summary().lastOutcome?.status,'quarantined');assert.equal(reloaded.director.memory.learningRevision??0,0);
});

test('timeout, local session UUID change, and caller reason alone cannot prove historical loss',()=>{
  const before=state(10),after=state(11);after.sessionId='new-session';
  assert.equal(observeHistoricalContext(withdraw,before,after,1000,200000,'owner').settled,false);
  assert.equal(observeHistoricalContext(withdraw,before,after,1000,200000,'owner').window,undefined);
});

test('current danger, active choices, incomplete accounting and changed owners cannot inherit a historical window',()=>{
  const before=state(50000);
  const first=observeHistoricalContext(withdraw,before,current(10),1000,200000,'owner');assert.ok(first.window);
  const mutations=[(s:any)=>s.character='other',(s:any)=>s.world='other',(s:any)=>s.profileId='other',
    (s:any)=>s.inGame=false,(s:any)=>s.player.isDead=true,(s:any)=>s.player.hp=0,
    (s:any)=>s.player.combat.inCombat=true,(s:any)=>s.player.combat.lastDamageTick=s.tick,
    (s:any)=>s.player.animId=3,(s:any)=>s.danger={active:true},(s:any)=>s.manualControl=true,
    (s:any)=>s.dialog.isOpen=true,(s:any)=>s.inventoryComplete=false,(s:any)=>delete s.equipment,
    (s:any)=>s.inventory=[{slot:0,id:41,count:-1}],(s:any)=>s.inventory=[{slot:0,id:41,count:1},{slot:0,id:42,count:1}]];
  for(const mutate of mutations){const s=current(11);mutate(s);const r=observeHistoricalContext(withdraw,before,s,1000,230000,'owner',first.window);assert.equal(r.settled,false);assert.equal(r.window,undefined);}
});

test('a new observer, changed current context, repeated tick, clock rollback or long gap resets historical quiescence',()=>{
  const before=state(50000);let w:HistoricalWindow|undefined;
  for(let n=0;n<3;n++)w=observeHistoricalContext(withdraw,before,current(10+n),1000,200000+n*10000,'owner',w).window;
  assert.ok(w);
  for(const [s,at,owner] of [[current(12),230000,'owner'],[current(13),219000,'owner'],[current(13),240001,'owner'],[current(13),230000,'new-owner'],[{...current(13),sessionId:'another-current-session'},230000,'owner']] as const){
    const r=observeHistoricalContext(withdraw,before,s,1000,at,owner,w);assert.equal(r.settled,false);assert.equal(r.window?.samples,1);
  }
});

test('an unknown original menu or irreversible operation is never converted to a historical navigation experiment',()=>{
  const before=state(50000),after=current(10);before.nearbyLocs=[];
  assert.equal(observeHistoricalContext(transition,before,after,1000,200000,'owner').window,undefined);
  for(const type of ['shopBuy','shopSell','clickDialogOption','talkToNpc','useInventoryItem','useItemOnItem'])
    assert.equal(observeHistoricalContext({type,fields:{}},state(50000),after,1000,200000,'owner').window,undefined);
  for(const name of ['Chest','Coffin','Altar','Lever']){const s=state(50000);s.nearbyLocs[0].name=name;s.nearbyLocs[0].optionsWithIndex[0].text='Open';assert.equal(observeHistoricalContext(transition,s,after,1000,200000,'owner').window,undefined);}
});
