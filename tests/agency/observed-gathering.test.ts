import test from 'node:test';
import assert from 'node:assert/strict';
import { observedGatheringActions, observedGatheringAffordance, observedMissingGatheringTool } from '../../src/agency/observed-gathering.ts';

const state=(items:any[],locs:any[])=>({inventory:items,equipment:[],nearbyLocs:locs});
const loc=(name:string,text:string,id:number)=>({name,id,x:id,z:10,reachable:true,distance:id,optionsWithIndex:[{opIndex:1,text}]});

test('observed mining requires a pickaxe rather than an axe',()=>{
  assert.equal(observedGatheringActions(state([{name:'Bronze axe'}],[loc('Copper rock','Mine',1)]),1).length,0);
  assert.equal(observedGatheringActions(state([{name:'Bronze pickaxe'}],[loc('Copper rock','Mine',1)]),1).length,1);
});
test('observed fishing is not hidden by an unrelated missing axe',()=>{
  const actions=observedGatheringActions(state([],[loc('Fishing spot','Fish',2)]),1);
  assert.equal(actions.length,1);assert.match(actions[0]!.id,/observed-gather-fish/);
});
test('woodcutting still requires an axe and respects the observed tree tier',()=>{
  assert.equal(observedGatheringActions(state([{name:'Bronze pickaxe'}],[loc('Oak','Chop down',3)]),1).length,0);
  assert.equal(observedGatheringActions(state([{name:'Bronze axe'}],[loc('Oak','Chop down',3)]),1).length,0);
  assert.equal(observedGatheringActions(state([{name:'Bronze axe'}],[loc('Oak','Chop down',3)]),15).length,1);
});
test('a reachable resource reports only its missing generic tool category',()=>{
  assert.deepEqual(observedMissingGatheringTool(state([{name:'Bronze pickaxe'}],[loc('Oak','Chop down',3)])),{tool:'axe',action:'chop'});
  assert.deepEqual(observedMissingGatheringTool(state([{name:'Bronze axe'}],[loc('Copper rock','Mine',3)])),{tool:'pickaxe',action:'mine'});
  assert.equal(observedMissingGatheringTool(state([],[loc('Fishing spot','Fish',3)])),undefined);
});
test('a gathering batch requires a current observed action or a current tool prerequisite',()=>{
  assert.equal(observedGatheringAffordance(state([],[]),1),false);
  assert.equal(observedGatheringAffordance(state([{name:'Bronze axe'}],[loc('Tree','Chop down',4)]),1),true);
  assert.equal(observedGatheringAffordance(state([], [loc('Copper rock','Mine',5)]),1),true);
});
