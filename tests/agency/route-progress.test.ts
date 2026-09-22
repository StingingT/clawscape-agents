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

test('a failed survey can yield to bounded local discovery while preserving the reversible route refusal',t=>{
 const f=fixture(t),a=f.agency,b=state();const selected=a.plan(b);assert.ok(isSelection(selected));
 const route=selected.task.route!;a.deferSurvey(route,b,'No verified approach: partial-path');
 assert.equal(a.director.memory.active,undefined);assert.equal(a.director.memory.reviews[0]?.result,'partial');
 const next=a.plan(state());assert.ok(isSelection(next));assert.match(next.task.route?.id??'',/^local-probe:/);assert.notEqual(next.task.route?.id,route.id);
 const refusal=a.summary().routeFailures?.[route.id];assert.ok(refusal);assert.match(refusal.reason,/partial-path/);
 const restarted=new LiveAgency(f.file,f.identity,f.options);const resumed=restarted.plan(state());assert.ok(isSelection(resumed));assert.match(resumed.task.route?.id??'',/^local-probe:/);
 f.time(31*60_000);const later=restarted.plan(state(10,10,30));assert.ok(isSelection(later),'cooldown is temporary, not permanent blacklisting');
});

test('an exhausted navigation approach retires a non-survey parent instead of retaining it idle',t=>{
 const f=fixture(t),a=f.agency,before=state(),selected=a.plan(before);assert.ok(isSelection(selected));
 // Model a normal production/preparation goal whose concrete travel approach
 // cannot be completed. The test deliberately does not name a character,
 // location, item, or fallback activity.
 (a as any).director.memory.active.id='ordinary-preparation';
 (a as any).director.memory.active.domain='crafting';
 const action={id:'approach',type:'walkTo',fields:{x:50,z:10,level:0}};
 a.begin(selected,action,before,'ordinary-partial');
 a.rememberExecution('ordinary-partial',{navigation:{status:'blocked',reason:'partial-path',movementDispatched:false}});
 f.time(2000);a.record('ordinary-partial',state(10,10,2),{status:'interrupted',evidence:['navigation blocked before movement dispatch']});
 assert.equal(a.pending(),undefined);assert.equal(a.director.memory.active,undefined);
 assert.equal(a.director.memory.reviews.at(-1)?.result,'partial');
 assert.match(a.director.memory.reviews.at(-1)?.reason??'',/EXHAUSTED_NAVIGATION: partial-path/);
 const stats=Object.values(a.director.memory.methods).find((s:any)=>s.viability==='temporarily-poor') as any;
 assert.ok(stats?.cooldownUntil>1_000,'only the failed method/context is temporarily cooled down');
});

test('an unverified survey receives one persisted fresh observation before it is deferred again',t=>{
 const f=fixture(t),a=f.agency,b=state();const selected=a.plan(b);assert.ok(isSelection(selected));const route=selected.task.route!;
 assert.equal(a.needsSurveyObservation(route,b),true);
 a.begin(selected,{id:'observe-survey',type:'scanNearbyLocs',fields:{surveyRouteId:route.id,radius:12}},b,'scan');
 f.time(2000);a.record('scan',state(10,10,2),{status:'verified',evidence:['read-only scan completed']});
 (a as any).director.memory.learningRevision=((a as any).director.memory.learningRevision??0)+1;
 assert.equal(a.needsSurveyObservation(route,state(10,10,3)),false,'the same route/context cannot scan indefinitely');
 a.deferSurvey(route,state(10,10,3),'No verified survey approach');
 assert.equal(a.needsSurveyObservation(route,state(10,10,4)),true,'a future retry gets one new observation');
 const reloaded=new LiveAgency(f.file,f.identity,f.options);
 assert.equal(reloaded.needsSurveyObservation(route,state(10,10,5)),true,'the retry boundary survives restart');
});

test('a survey-owned scan without a packet metadata field is still remembered',t=>{
 const f=fixture(t),a=f.agency,b=state(),selected=a.plan(b);assert.ok(isSelection(selected));const route=selected.task.route!;
 // `surveyRouteId` is controller evidence and must not be sent to the CLI.
 // Receipt method ownership is enough to keep this one scan bounded.
 a.begin(selected,{id:'observe-transition',type:'scanNearbyLocs',fields:{radius:8}},b,'scan');
 f.time(2000);a.record('scan',state(10,10,2),{status:'verified',evidence:['read-only scan completed']});
 assert.equal(a.needsSurveyObservation(route,state(10,10,3)),false);
});

test('a concrete survey refusal is retained rather than overwritten by a generic executor message',t=>{
 const f=fixture(t),a=f.agency,b=state();const selected=a.plan(b);assert.ok(isSelection(selected));const route=selected.task.route!;
 a.deferSurvey(route,b,'No verified survey approach: unverified-collision-coverage');
 const first=a.summary().routeFailures?.[route.id];assert.ok(first);
 // The outer executor sees the goal is already retired and must not call deferSurvey again.
 assert.notEqual(a.summary().goal?.id,selected.task.id);
 assert.match(a.summary().routeFailures?.[route.id]?.reason??'',/unverified-collision-coverage/);
  assert.equal(a.summary().routeFailures?.[route.id]?.attempts,first.attempts);
});

test('a selected method with no concrete executor step is temporarily excluded before replanning',t=>{
 const f=fixture(t),a=f.agency,b=state(),selected=a.plan(b);assert.ok(isSelection(selected));
 a.deferCurrent(b,'Selected task has no feasible current executor step.',true,selected.method.id);
 const next=a.plan(state());
 assert.ok(isSelection(next),'a distinct feasible local plan should be selected');
 assert.notEqual(next.method.id,selected.method.id,'the exact non-executable method must cool down');
 const stats=Object.values(a.director.memory.methods).find((s:any)=>s.viability==='temporarily-poor') as any;
 assert.ok(stats?.cooldownUntil>1_000);
});

test('distinct no-executor plans enter a restart-safe bounded capability episode',t=>{
 const f=fixture(t),a=f.agency,b=state();
 for(const id of ['survey:bank','gathering:wood','production:bow']) (a as any).recordExecutorFailure(b,id);
 const blocked=a.plan(b);assert.equal(blocked.type,'blocked');assert.match(blocked.reason,/EXECUTOR_CAPABILITY_EPISODE/);
 assert.equal(a.summary().executorEpisode.failures.length,3);
 const restarted=new LiveAgency(f.file,f.identity,f.options),again=restarted.plan(b);
 assert.equal(again.type,'blocked','restart must not erase the executor diagnostic');
 (restarted as any).director.memory.learningRevision++;
 const reopened=restarted.plan(state(10,10,2));assert.notEqual(reopened.type,'blocked');
 assert.equal(restarted.summary().executorEpisode,undefined,'new learned capability reopens planning');
});

test('a due executor episode expires into a fresh planning pass without a state mutation',t=>{
 const f=fixture(t),a=f.agency,b=state();
 for(const id of ['survey:bank','gathering:wood','production:bow']) (a as any).recordExecutorFailure(b,id);
 assert.equal(a.plan(b).type,'blocked');
 f.time(1_000+2*60_000+1);
 const reopened=a.plan(state(10,10,2));
 if(reopened.type==='blocked')assert.doesNotMatch(reopened.reason,/EXECUTOR_CAPABILITY_EPISODE/);
 assert.equal(a.summary().executorEpisode,undefined);
});
