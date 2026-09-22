import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshObservedLocAction,observedDiscoveryTransition,productiveProductionCandidates,safeResourceDialogOption,taskMustCloseInheritedBank,taskOwnsBankExecutor} from '../../src/agency/actionability.ts';

test('idle production waits are not executable work',()=>{
  const waiting=[{type:'wait'}];
  assert.deepEqual(productiveProductionCandidates({player:{animId:-1}},waiting),[]);
  assert.deepEqual(productiveProductionCandidates({player:{animId:1248}},waiting),waiting);
});

test('concrete production actions outrank a passive wait',()=>{
  const actions=[{type:'wait'},{type:'useItemOnItem'}];
  assert.deepEqual(productiveProductionCandidates({player:{animId:1248}},actions),[{type:'useItemOnItem'}]);
});

test('only tasks with explicit bank lifecycles bypass generic banking',()=>{
  assert.equal(taskOwnsBankExecutor('production'),true);
  assert.equal(taskOwnsBankExecutor('food'),false);
  assert.equal(taskOwnsBankExecutor('equipment'),false);
  assert.equal(taskOwnsBankExecutor('ammunition'),false);
  assert.equal(taskOwnsBankExecutor('bank'),false);
  assert.equal(taskOwnsBankExecutor('gathering'),false);
  assert.equal(taskOwnsBankExecutor('exploration'),false);
  assert.equal(taskOwnsBankExecutor('discovery'),false);
  assert.equal(taskMustCloseInheritedBank({kind:'gathering'}),false);
  assert.equal(taskMustCloseInheritedBank({kind:'exploration'}),true);
  assert.equal(taskMustCloseInheritedBank({kind:'discovery'}),true);
  assert.equal(taskMustCloseInheritedBank({kind:'combat'}),true);
});

test('an adjacent observed transition remains executable when its footprint is collision-unreachable',()=>{
  const state={player:{worldX:10,worldZ:10,level:0},nearbyLocs:[
    {id:41,x:11,z:10,level:0,reachable:false,optionsWithIndex:[{opIndex:1,text:'Open'}]},
    {id:42,x:13,z:10,level:0,reachable:false,optionsWithIndex:[{opIndex:1,text:'Open'}]},
  ]};
  assert.equal(observedDiscoveryTransition(state,'discover:discovered:interaction:41:11:10:0:1')?.id,41);
  assert.equal(observedDiscoveryTransition(state,'discover:discovered:interaction:42:13:10:0:1'),undefined);
});

test('a vanished or unreachable location action is discarded before dispatch',()=>{
  const action={type:'interactLoc',fields:{locId:7,x:11,z:10,optionIndex:1}};
  assert.equal(freshObservedLocAction({player:{worldX:0,worldZ:0,level:0},nearbyLocs:[]},action),false);
  assert.equal(freshObservedLocAction({player:{worldX:0,worldZ:0,level:0},nearbyLocs:[{id:7,x:11,z:10,level:0,reachable:false,optionsWithIndex:[{opIndex:1,text:'Mine'}]}]},action),false);
  assert.equal(freshObservedLocAction({player:{worldX:10,worldZ:10,level:0},nearbyLocs:[{id:7,x:11,z:10,level:0,reachable:false,optionsWithIndex:[{opIndex:1,text:'Mine'}]}]},action),true);
});

test('only one observed collection verb is safe to continue through a dialog',()=>{
  assert.equal(safeResourceDialogOption([{index:2,text:'Mine'}]),2);
  assert.equal(safeResourceDialogOption([{index:2,text:'Mine'},{index:3,text:'Continue'}]),undefined);
  assert.equal(safeResourceDialogOption([{index:2,text:'Claim reward'}]),undefined);
});
