import {test,expect} from 'bun:test';
import {LiveNavigator} from '../src/live-navigation.ts';
const worker=()=>({onmessage:null as any,onerror:null as any,terminated:false,terminate(){this.terminated=true;}});
test('worker startup failure rejects readiness instead of leaving a silent wait loop',async()=>{
  const w=worker(),nav=new LiveNavigator(()=>w as any);const ready=nav.waitUntilReady(100);
  w.onerror({message:'untrusted detail'});await expect(ready).rejects.toThrow('COLLISION_WORKER_FAILED');nav.close();expect(w.terminated).toBe(true);
});
test('worker ready signal enables navigation and close releases the worker',async()=>{
  const w=worker(),nav=new LiveNavigator(()=>w as any);const ready=nav.waitUntilReady(100);
  w.onmessage({data:{ready:true}});await ready;expect(nav.isReady()).toBe(true);nav.close();expect(w.terminated).toBe(true);
});
test('missing worker startup signal has a bounded timeout',async()=>{
  const w=worker(),nav=new LiveNavigator(()=>w as any);await expect(nav.waitUntilReady(5)).rejects.toThrow('COLLISION_WORKER_TIMEOUT');nav.close();
});
test('a verified collision frontier moves to its endpoint but never claims arrival',async()=>{
  const w:any=worker();
  w.postMessage=(request:any)=>queueMicrotask(()=>w.onmessage({data:{id:request.id,hash:'test',hint:request.to,
    endpoint:{x:11,z:10,plane:0},approachOnly:true,legs:[{to:{x:11,z:10,plane:0},doors:[]}]}}));
  const nav=new LiveNavigator(()=>w);w.onmessage({data:{ready:true}});await nav.waitUntilReady(100);
  const start:any={position:{x:10,z:10,plane:0},life_id:1};const target:any={x:30,z:10,plane:0};
  const first=await nav.next(start,target);expect(first.intent).toEqual({operation:'move',destination:{x:11,z:10,plane:0}});
  const frontier=await nav.next({...start,position:{x:11,z:10,plane:0}},target);
  expect(frontier.blocked).toBe('FRONTIER_REACHED');expect(frontier.arrived).toBeUndefined();nav.close();
});
