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
