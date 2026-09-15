import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseIncidentalGroundItem,incidentalBankable} from '../../src/agency/incidental.ts';

const state=()=>({capacity:28,inventory:Array.from({length:10},(_,slot)=>({id:1000+slot,name:'held '+slot,slot,count:1})),equipment:[],groundItems:[] as any[]});

test('a useful incidental ground resource can become support without naming a particular drop',()=>{
  const s=state();s.groundItems=[{id:200,name:'Unfamiliar material',count:3,x:10,z:11,reachable:true}];
  const c=chooseIncidentalGroundItem(s,100,{});assert.ok(c);assert.equal(c.need.id,200);assert.equal(c.need.minimum,3);
  assert.match(c.reason,/primary objective/);assert.ok(!/chicken|bone|feather/i.test(c.reason));
});

test('worse or duplicate equipment can still be carried for storage when capacity is cheap',()=>{
  const s=state();s.equipment=[{id:900,name:'Higher tier sword'}];s.groundItems=[{id:201,name:'Lower tier sword',count:1,x:10,z:11,reachable:true}];
  const c=chooseIncidentalGroundItem(s,100,{});assert.equal(c?.need.id,201);assert.ok(c!.score>=3);
});

test('incidental collection yields to inventory efficiency and cooldowns',()=>{
  const s=state();s.inventory=Array.from({length:25},(_,slot)=>({id:1000+slot,name:'held '+slot,slot,count:1}));
  s.groundItems=[{id:202,name:'Interesting item',count:1,x:1,z:1,reachable:true}];assert.equal(chooseIncidentalGroundItem(s,100,{}),undefined);
  s.inventory=s.inventory.slice(0,10);assert.equal(chooseIncidentalGroundItem(s,100,{'ground:202:1:1':200}),undefined);
});

test('items deliberately collected incidentally can later be banked generically',()=>{
  assert.equal(incidentalBankable({id:44,name:'Anything'},{'44':123}),true);
  assert.equal(incidentalBankable({id:45,name:'Anything'},{'44':123}),false);
});
