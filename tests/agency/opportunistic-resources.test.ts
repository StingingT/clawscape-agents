import test from 'node:test';
import assert from 'node:assert/strict';
import { incidentalCandidate, emptyIncidental, recordIncidental, incidentalBankable } from '../../src/agency/opportunistic-resources.ts';

const state=(over:any={})=>({inGame:true,tick:10,capacity:28,player:{worldX:10,worldZ:10,level:0,hp:10,isDead:false,combat:{inCombat:false}},inventory:[],equipment:[],nearbyLocs:[],groundItems:[],...over});

test('samples a nearby unknown incidental item only with comfortable spare capacity',()=>{
  const s=state({inventory:Array.from({length:20},(_,slot)=>({id:1000+slot,name:'kept '+slot,slot,count:1})),groundItems:[{id:77,name:'mystery resource',x:11,z:10,reachable:true}]});
  const a=incidentalCandidate(s,'combat');
  assert.equal(a?.type,'pickupItem');assert.equal(a?.fields?.itemId,77);
  s.inventory=Array.from({length:26},(_,slot)=>({id:1000+slot,name:'kept '+slot,slot,count:1}));
  assert.equal(incidentalCandidate(s,'combat'),undefined);
});

test('gathering protects more cargo capacity from incidental diversions',()=>{
  const inv=Array.from({length:24},(_,slot)=>({id:1000+slot,name:'kept '+slot,slot,count:1}));
  const s=state({inventory:inv,groundItems:[{id:77,name:'mystery resource',x:10,z:10,reachable:true}]});
  assert.equal(incidentalCandidate(s,'gathering')?.type,'pickupItem');
  s.inventory.push({id:2000,name:'another',slot:24,count:1});
  assert.equal(incidentalCandidate(s,'gathering'),undefined);
});

test('uses a live low-cost skill option without naming a particular item',()=>{
  const s=state({inventory:[{id:5,name:'incidental resource',slot:4,count:1,optionsWithIndex:[{opIndex:2,text:'Bury'}]}]});
  const a=incidentalCandidate(s,'combat');assert.equal(a?.type,'useInventoryItem');assert.equal(a?.fields?.slot,4);
});

test('processes a generic raw resource only at an observed adjacent heat source',()=>{
  const s=state({inventory:[{id:8,name:'Raw provision',slot:2,count:1}],nearbyLocs:[{id:9,name:'Range',x:11,z:10,reachable:true}]});
  const a=incidentalCandidate(s,'gathering');assert.equal(a?.type,'useItemOnLoc');assert.equal(a?.fields?.itemSlot,2);
});

test('verified incidental pickups become bankable without hard-coded item names',()=>{
  const m=emptyIncidental(),b=state({inventory:[]}),a=state({tick:11,inventory:[{id:77,name:'odd equipment',slot:0,count:1}]});
  recordIncidental(m,b,a,{id:'incidental-pickup-77-10-10',type:'pickupItem',fields:{itemId:77,x:10,z:10},waitTicks:2},123);
  assert.equal(incidentalBankable({id:77,name:'odd equipment'},m),true);
  assert.equal(incidentalBankable({id:77,name:'odd equipment',protected:true},m),false);
});
