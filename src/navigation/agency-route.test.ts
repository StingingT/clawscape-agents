import { test,expect } from 'bun:test';
import { mkdtempSync,rmSync } from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Navigator} from './controller';
import {LiveAgency,isSelection} from '../agency/live-adapter';
import {verifyActionOutcome} from '../action-outcome';

test('real Navigator legs advance a single agency route, including a detour away from the destination',async()=>{
 const root=mkdtempSync(join(tmpdir(),'actual-nav-'));
 let clock=1000,queued:any=null,moves=0;
 const state:any={inGame:true,tick:1,player:{worldX:10,worldZ:10,level:0,lifeId:1,respawnCount:0,hp:30,maxHp:30,animId:-1,combat:{inCombat:false,lastDamageTick:-1}},inventory:[],equipment:[],skills:[]};
 const destination={x:30,z:10,level:0};
 const port={state:async()=>structuredClone(state),act:async(type:string,f:any)=>{expect(type).toBe('walkTo');queued=f;moves++;return {success:true};},
  wait:async(ticks:number)=>{state.tick+=ticks;clock+=1000;if(queued){state.player.worldX=queued.x;state.player.worldZ=queued.z;queued=null;}return structuredClone(state);}};
 const navigator=new Navigator(port,join(root,'nav.json'),async()=>({legs:[{target:{x:9,z:18,level:0},doors:[]},{target:{x:20,z:18,level:0},doors:[]},{target:destination,doors:[]}]}));
 const identity={agent:'test',world:'test',revision:'v1'},options={supported:['exploration'] as any,routes:[{id:'site',...destination,evidence:'own observed route'}],now:()=>clock};
 let agency=new LiveAgency(join(root,'agency.json'),identity,options),goalKey:string|undefined;
 try{
  for(let n=0;n<3;n++){
   const before=structuredClone(state),selection=agency.plan(before);expect(isSelection(selection)).toBe(true);if(!isSelection(selection))throw Error('no plan');
   goalKey??=selection.decision.goal.key;expect(selection.decision.goal.key).toBe(goalKey);
   const action=agency.routeStep(selection,before)??{id:'route',type:'walkTo',fields:destination};
   const id=agency.begin(selection,action,before,'leg'+n);const result=await navigator.step(destination,before);agency.rememberExecution(id,result);
   const verified=verifyActionOutcome(before,result.state,action,result);expect(verified.verified).toBe(true);
   agency.record(id,result.state,{status:'verified',evidence:verified.evidence});expect(agency.pending()).toBeUndefined();
   if(n<2){expect(agency.director.memory.reviews.length).toBe(0);agency=new LiveAgency(join(root,'agency.json'),identity,options);}
  }
  expect(moves).toBe(3);expect(agency.director.memory.reviews.length).toBe(1);expect(agency.director.memory.reviews[0]!.result).toBe('success');
 }finally{navigator.close();rmSync(root,{recursive:true,force:true});}
});

test('the actual navigator marks a map wait as no movement dispatch',async()=>{
 const root=mkdtempSync(join(tmpdir(),'actual-map-'));let moves=0;
 const state:any={tick:1,player:{worldX:10,worldZ:10,level:0,lifeId:1,hp:10,maxHp:10,combat:{inCombat:false,lastDamageTick:-1}},inventory:[],skills:[]};
 const navigator=new Navigator({state:async()=>state,act:async()=>{moves++;return{};},wait:async()=>({...state,tick:3})},join(root,'nav.json'),async()=>({legs:[]}));
 try{(navigator as any).ready=false;const r=await navigator.step({x:20,z:10,level:0},state);expect(moves).toBe(0);expect(r.navigation.movementDispatched).toBe(false);
 expect(verifyActionOutcome(state,r.state,{type:'walkTo',fields:{x:20,z:10,level:0}},r).verified).toBe(true);
 }finally{navigator.close();rmSync(root,{recursive:true,force:true});}
});
