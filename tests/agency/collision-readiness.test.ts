import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveNavigator, type StartupClock } from '../../agents/advanced/src/live-navigation.ts';
import { COLLISION_STARTUP_TIMEOUT_MS, collisionFailure, type CollisionDiagnostic } from '../../agents/advanced/src/collision-startup.ts';

function clock(){
  let at=1000;const pending=new Set<{at:number;run:()=>void}>();
  return {now:()=>at,schedule(run:()=>void,ms:number){const job={at:at+ms,run};pending.add(job);return ()=>{pending.delete(job);};},
    advance(ms:number){at+=ms;for(const job of [...pending].sort((a,b)=>a.at-b.at))if(job.at<=at&&pending.delete(job))job.run();},pending};
}
function setup(){
  const c=clock(),events:CollisionDiagnostic[]=[];
  const w={onmessage:null as any,onerror:null as any,onmessageerror:null as any,terminated:false,terminate(){this.terminated=true;}};
  const nav=new LiveNavigator(()=>w as any,event=>events.push(event),c satisfies StartupClock);
  return {c,w,nav,events};
}

test('slow-but-valid collision initialization remains allowed after 27 seconds and before 60 seconds',async()=>{
  const {c,w,nav,events}=setup();
  assert.equal(COLLISION_STARTUP_TIMEOUT_MS,60_000);
  const ready=nav.waitUntilReady();
  c.advance(27_000);assert.equal(w.terminated,false);assert.equal(nav.isReady(),false);
  w.onmessage({data:{kind:'collision-startup',status:'starting',stage:'initializing-pathfinding'}});
  w.onmessage({data:{ready:true,hash:'test'}});
  await ready;assert.equal(nav.isReady(),true);assert.equal(events.at(-1)?.elapsedMs,27_000);
  c.advance(60_000);assert.equal(w.terminated,false,'ready must cancel the watchdog');
  nav.close();assert.equal(c.pending.size,0);
});

test('a genuine startup hang fails at 60 seconds with stage diagnostics and cleanup',async()=>{
  const {c,w,nav,events}=setup();const ready=nav.waitUntilReady();
  const rejected=assert.rejects(ready,/COLLISION_WORKER_TIMEOUT/);
  w.onmessage({data:{kind:'collision-startup',status:'starting',stage:'importing-pathfinder'}});
  c.advance(59_999);assert.equal(w.terminated,false);
  c.advance(1);await rejected;
  assert.equal(w.terminated,true);assert.equal(nav.isReady(),false);assert.equal(c.pending.size,0);
  assert.deepEqual(events.at(-1),{component:'astra-collision-worker',status:'failed',stage:'importing-pathfinder',elapsedMs:60_000,errorCode:'COLLISION_WORKER_TIMEOUT'});
  w.onmessage({data:{ready:true}});assert.equal(nav.isReady(),false,'late ready must not revive a timed-out worker');
  await assert.rejects(nav.waitUntilReady(),/COLLISION_WORKER_TIMEOUT/);nav.close();
});

test('stage messages and repeated waiters cannot extend the absolute startup deadline',async()=>{
  const {c,w,nav}=setup();const first=assert.rejects(nav.waitUntilReady(),/COLLISION_WORKER_TIMEOUT/);
  c.advance(40_000);const second=assert.rejects(nav.waitUntilReady(),/COLLISION_WORKER_TIMEOUT/);
  w.onmessage({data:{kind:'collision-startup',status:'starting',stage:'hashing-collision-data'}});
  c.advance(20_000);await Promise.all([first,second]);assert.equal(c.pending.size,0);assert.equal(w.terminated,true);nav.close();
});

test('worker startup exceptions report a bounded code and phase, never the raw secret-bearing error',async()=>{
  const {c,w,nav,events}=setup();const ready=nav.waitUntilReady();
  const rejected=assert.rejects(ready,/COLLISION_INITIALIZATION_FAILED/);
  w.onmessage({data:{kind:'collision-startup',status:'failed',stage:'initializing-pathfinding',errorCode:'COLLISION_INITIALIZATION_FAILED',message:'token=DO_NOT_PRINT'}});
  await rejected;assert.equal(w.terminated,true);assert.equal(c.pending.size,0);
  assert.equal(JSON.stringify(events).includes('DO_NOT_PRINT'),false);nav.close();
});

test('unknown diagnostic payloads cannot inject error text or signal readiness',async()=>{
  const {w,nav,events}=setup();const ready=nav.waitUntilReady();
  const rejected=assert.rejects(ready,/COLLISION_WORKER_FAILED/);
  w.onmessage({data:{kind:'collision-startup',status:'starting',stage:'token=SECRET'}});
  assert.equal(nav.isReady(),false);
  w.onmessage({data:{kind:'collision-startup',status:'failed',stage:'importing-pathfinding',errorCode:'SECRET'}});
  await rejected;assert.equal(JSON.stringify(events).includes('SECRET'),false);nav.close();
});

test('native worker error and close cancel pending readiness without publishing raw exceptions',async()=>{
  const {w,nav,events,c}=setup();const ready=nav.waitUntilReady();const rejected=assert.rejects(ready,/COLLISION_WORKER_FAILED/);
  w.onerror({message:'private authentication value',preventDefault(){}});await rejected;
  assert.equal(JSON.stringify(events).includes('authentication value'),false);assert.equal(c.pending.size,0);nav.close();
  const next=setup();const stopped=assert.rejects(next.nav.waitUntilReady(),/NAVIGATOR_CLOSED/);next.nav.close();await stopped;
  assert.equal(next.c.pending.size,0);await assert.rejects(next.nav.waitUntilReady(),/NAVIGATOR_CLOSED/);
});

test('invalid startup limits fail immediately rather than disabling the timeout',async()=>{
  const {nav}=setup();for(const timeout of [0,-1,NaN,Infinity,60_001])await assert.rejects(nav.waitUntilReady(timeout),/TIMEOUT_INVALID/);nav.close();
});

test('error classification never returns raw exception messages',()=>{
  assert.equal(collisionFailure({code:'ERR_MODULE_NOT_FOUND',message:'token=secret'}),'COLLISION_DEPENDENCY_MISSING');
  assert.equal(collisionFailure({code:'ENOENT',message:'private path'}),'COLLISION_ASSET_READ_FAILED');
  assert.equal(collisionFailure(new Error('secret')),'COLLISION_INITIALIZATION_FAILED');
});
