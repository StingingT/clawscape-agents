import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LiveNavigator} from '../src/live-navigation.ts';
import type {CollisionDiagnostic} from '../src/collision-startup.ts';

/** The real worker imports only these temporary local stubs. No game/CLI credentials. */
async function withWorker(init:string,check:(nav:LiveNavigator,events:CollisionDiagnostic[])=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'collision-worker-'));
  const original=process.env.CLAWSCAPE_UPSTREAM;
  mkdirSync(join(dir,'sdk'),{recursive:true});mkdirSync(join(dir,'server/vendor/rsmod-pathfinder'),{recursive:true});
  writeFileSync(join(dir,'sdk/collision-data.json'),'{}');
  writeFileSync(join(dir,'sdk/pathfinding.ts'),init);
  writeFileSync(join(dir,'server/vendor/rsmod-pathfinder/rsmod-pathfinder.js'),'export function changeLoc() {}');
  process.env.CLAWSCAPE_UPSTREAM=dir;
  const events:CollisionDiagnostic[]=[];
  const nav=new LiveNavigator(undefined,e=>events.push(e));
  try{await check(nav,events);}finally{
    nav.close();
    if(original===undefined)delete process.env.CLAWSCAPE_UPSTREAM;else process.env.CLAWSCAPE_UPSTREAM=original;
    rmSync(dir,{recursive:true,force:true});
  }
}

test('real worker emits import, initialization and hash phases before readiness',async()=>{
  await withWorker('export async function initPathfinding(){ await new Promise(r=>setTimeout(r,40)); }',async(nav,events)=>{
    await nav.waitUntilReady(2_000);
    expect(nav.isReady()).toBe(true);
    expect(events.map(e=>e.stage)).toEqual(['starting','resolving-upstream','loading-contracts','importing-pathfinding',
      'importing-pathfinder','initializing-pathfinding','hashing-collision-data','applying-hazards','ready']);
  });
});

test('real worker initialization failure is reported before timeout without raw error text',async()=>{
  await withWorker("export function initPathfinding(){ throw new Error('DO_NOT_PRINT_SECRET'); }",async(nav,events)=>{
    await expect(nav.waitUntilReady(2_000)).rejects.toThrow('COLLISION_INITIALIZATION_FAILED');
    expect(events.at(-1)?.stage).toBe('initializing-pathfinding');
    expect(events.at(-1)?.status).toBe('failed');
    expect(JSON.stringify(events)).not.toContain('DO_NOT_PRINT_SECRET');
    expect(nav.isReady()).toBe(false);
  });
});
