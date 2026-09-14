import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import {verifyActionOutcome} from '../../src/action-outcome.ts';

const state=(x=10,z=10,tick=1):any=>({inGame:true,tick,sessionId:'s',player:{worldX:x,worldZ:z,level:0,lifeId:1,animId:-1,hp:30,maxHp:30,combat:{inCombat:false}},inventory:[],equipment:[],skills:[],nearbyLocs:[]});
const move={id:'travel-to-bank',type:'walkTo',fields:{x:50,z:10,level:0},waitTicks:2};
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'route-agency-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let now=1000;const file=join(dir,'agency.json');
 const options={supported:['exploration'] as any,routes:[{id:'bank',x:50,z:10,level:0,evidence:'own observed route'}],now:()=>now};
 const identity={agent:'test',world:'test',revision:'test'};return {file,identity,options,agency:new LiveAgency(file,identity,options),time:(n:number)=>now=n};}
const verify=(b:any,a:any,result?:any)=>{const v=verifyActionOutcome(b,a,move,result);return {status:v.interrupted?'interrupted' as const:v.verified?'verified' as const:v.uncertain?'unknown' as const:'rejected' as const,evidence:v.evidence};};
test('a fence detour away from the final destination is verified movement, not arrival',()=>{
 const v=verifyActionOutcome(state(),state(9,18,4),move);assert.equal(v.verified,true);assert.match(v.evidence[0]!,/final route is not complete/);
});
test('stationary progress status alone is not evidence of movement',()=>{
 const v=verifyActionOutcome(state(),state(10,10,2),move,{navigation:{status:'progress'}});assert.equal(v.verified,false);assert.equal(v.uncertain,true);
});
test('an unchanged tick or reset cannot verify a displacement',()=>{
 for(const tick of [0,1])assert.equal(verifyActionOutcome(state(),state(11,10,tick),move).verified,false);
});
test('life, plane, or session changes never become successful movement legs',()=>{
 for(const key of ['lifeId','level']){const after=state(12,10,3);after.player[key]=2;assert.equal(verifyActionOutcome(state(),after,move).verified,false);}
 const after=state(12,10,3);after.sessionId='new';assert.equal(verifyActionOutcome(state(),after,move).verified,false);
});
test('missing coordinates never become NaN movement success',()=>{
 const after=state(12,10,3);delete after.player.worldZ;assert.equal(verifyActionOutcome(state(),after,move).verified,false);
});
test('explicit no-dispatch map preparation can finish without reporting route completion',()=>{
 const v=verifyActionOutcome(state(),state(10,10,3),move,{navigation:{status:'loading-map',movementDispatched:false}});
 assert.equal(v.verified,true);assert.match(v.evidence[0]!,/destination remains pending/);
 assert.equal(verifyActionOutcome(state(),state(10,10,3),move,{navigation:{status:'loading-map'}}).verified,false);
});
test('verified leg clears only the receipt and preserves the same route/goal across restart',t=>{
 const f=fixture(t),a=f.agency,b=state();const selected=a.plan(b);assert.ok(isSelection(selected));a.begin(selected,move,b,'leg1');f.time(2000);
 a.record('leg1',state(9,18,4),verify(b,state(9,18,4)));assert.equal(a.pending(),undefined);assert.equal(a.director.memory.reviews.length,0);
 const resumed=new LiveAgency(f.file,f.identity,f.options),next=resumed.plan(state(9,18,4));assert.ok(isSelection(next));
 assert.equal(next.decision.goal.key,selected.decision.goal.key);assert.deepEqual(resumed.routeStep(next,state(9,18,4)),move);
 resumed.begin(next,move,state(9,18,4),'leg2');f.time(3000);resumed.record('leg2',state(50,10,20),verify(state(9,18,4),state(50,10,20)));
 assert.equal(resumed.director.memory.reviews.length,1);assert.equal(resumed.director.memory.reviews[0]!.result,'success');
});
test('map-loading execution evidence survives a receipt restart',t=>{
 const f=fixture(t),a=f.agency,b=state(),sel=a.plan(b);assert.ok(isSelection(sel));a.begin(sel,move,b,'map');
 a.rememberExecution('map',{navigation:{status:'loading-map',movementDispatched:false,routes:{notPersisted:true}}});
 const r=new LiveAgency(f.file,f.identity,f.options),pending=r.pending()!;assert.equal((pending.execution?.navigation as any).routes,undefined);
 r.record('map',state(10,10,3),verify(pending.before,state(10,10,3),pending.execution));assert.equal(r.pending(),undefined);assert.equal(r.director.memory.reviews.length,0);
});
test('execution evidence must match the outstanding command',t=>{
 const f=fixture(t),p=f.agency.plan(state());assert.ok(isSelection(p));f.agency.begin(p,move,state(),'right');
 assert.throws(()=>f.agency.rememberExecution('wrong',{navigation:{status:'progress'}}),/MATCHING_INTENT/);
});
test('old stationary navigation can end as interrupted after a bounded idle settling window',t=>{
 const f=fixture(t),a=f.agency,p=a.plan(state());assert.ok(isSelection(p));a.begin(p,move,state(),'old');
 f.time(2000);assert.equal(a.settleNavigation('old',state(10,10,2)),undefined);
 f.time(33000);const v=a.settleNavigation('old',state(10,10,60));assert.equal(v?.status,'interrupted');a.record('old',state(10,10,60),v!);
 assert.equal(a.pending(),undefined);assert.equal(a.director.memory.reviews.length,0);assert.ok(a.director.memory.active);
 assert.equal(Object.values(a.director.memory.methods)[0]?.rejected,0);
});
test('stationary settling never clears a purchase, production, or dialogue receipt',t=>{
 const f=fixture(t),a=f.agency,p=a.plan(state());assert.ok(isSelection(p));a.begin(p,move,state(),'old');
 for(const type of ['shopBuy','bankWithdraw','clickDialogOption','useItemOnItem']){
  (a as any).document.receipt.action.type=type;f.time(100_000);assert.equal(a.settleNavigation('old',state(10,10,100)),undefined);assert.ok(a.pending());
 }
});
test('idle retirement requires idle, same life, and a second newer observation',t=>{
 const f=fixture(t),a=f.agency,p=a.plan(state());assert.ok(isSelection(p));a.begin(p,move,state(),'old');f.time(2000);a.settleNavigation('old',state(10,10,2));f.time(40000);
 assert.equal(a.settleNavigation('old',state(10,10,2)),undefined);
 for(const field of ['animId','lifeId']){const s=state(10,10,80);s.player[field]=7;assert.equal(a.settleNavigation('old',s),undefined);}
});
test('repeated route-leg evidence does not double count preparation or complete the goal',t=>{
 const f=fixture(t),a=f.agency,p=a.plan(state());assert.ok(isSelection(p));a.begin(p,move,state(),'same');f.time(2000);
 const v=verify(state(),state(14,10,5));a.record('same',state(14,10,5),v);const elapsed=a.director.memory.active!.elapsedMs;a.record('same',state(14,10,5),v);
 assert.equal(a.director.memory.active!.elapsedMs,elapsed);assert.equal(a.director.memory.reviews.length,0);
});
test('output and matching production XP can verify a click when the same Make-All dialogue remains open',()=>{
 const b=state();b.dialog={isOpen:true,options:[{index:2,text:'Make all headless arrows'}]};b.skills=[{name:'fletching',experience:10}];b.inventory=[{id:52,count:10},{id:314,count:10}];
 const a=structuredClone(b);a.tick++;a.skills[0].experience=20;a.inventory=[{id:53,count:10}];
 assert.equal(verifyActionOutcome(b,a,{type:'clickDialogOption',fields:{optionIndex:2}}).verified,true);
 assert.equal(verifyActionOutcome(b,a,{type:'clickDialogOption',fields:{optionIndex:9}}).verified,false);
});
test('clock alone or unrelated item changes cannot verify a production dialogue',()=>{
 const b=state();b.dialog={isOpen:true,options:[{index:2,text:'Make all arrows'}]};const a=structuredClone(b);a.tick++;a.inventory=[{id:53,count:1}];
 assert.equal(verifyActionOutcome(b,a,{type:'clickDialogOption',fields:{optionIndex:2}}).verified,false);
});
