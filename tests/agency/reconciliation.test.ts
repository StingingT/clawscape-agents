import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meaningfulFrontierRoute, reconcileDeathLoss } from '../../src/agency/reconciliation.ts';
import { observeQuietStep } from '../../src/agency/step-retry.ts';

const state=(tick=100)=>({
  character:'stinger',world:'clawscape',worldEpoch:'world-1',profileId:'stinger',sessionId:'session-1',inGame:true,tick,
  player:{lifeId:1,respawnCount:0,hp:20,maxHp:20,worldX:10,worldZ:10,level:0,animId:-1,combat:{inCombat:false,targetType:'none'}},
  inventory:[
    {id:52,name:'Arrow shaft',slot:0,count:10},
    {id:314,name:'Feather',slot:1,count:10},
    {id:995,name:'Coins',slot:2,count:50},
  ],
  equipment:[],skills:[{name:'fletching',experience:0,baseLevel:1}],
  bank:{isOpen:false},shop:{isOpen:false},dialog:{isOpen:false},modalOpen:false,
  nearbyNpcs:[{id:41,index:3,name:'Chicken',reachable:true,optionsWithIndex:[{opIndex:1,text:'Attack'}]}],
  nearbyLocs:[{id:100,x:10,z:11,name:'Door',reachable:true,optionsWithIndex:[{opIndex:1,text:'Open'}]}],
});

test('incidental scenery is not promoted to a frontier while services/transitions remain eligible',()=>{
  const route=(name:string,id='observed:1:1:1:0')=>({id,x:1,z:1,level:0,evidence:`own-object:1:10:${name}`});
  for(const name of ['Tree','Dead tree','Oak','Henge','Spear wall','Bush','Plant'])assert.equal(meaningfulFrontierRoute(route(name)),false,name);
  for(const name of ['Bank booth','Furnace','Door','Gate','Ladder','Cave entrance','Altar'])assert.equal(meaningfulFrontierRoute(route(name)),true,name);
  assert.equal(meaningfulFrontierRoute({id:'wizardsTower',x:1,z:1,level:0,evidence:'bundled route lead'}),true);
});

test('stable repeatable item-on-item activity can retire as interrupted only after a continuous quiet window',()=>{
  const before=state(10), action={type:'useItemOnItem',fields:{sourceSlot:0,targetSlot:1}};
  const first=observeQuietStep(action,before,state(20),1_000,'observer');
  assert.equal(first.settled,false);
  const done=observeQuietStep(action,before,state(40),31_000,'observer',first.window);
  assert.equal(done.settled,true);assert.match(done.reason,/no success or non-execution is inferred/i);
});

test('a mutation restarts observation; transactions never timeout into replay',()=>{
  const before=state(10), changed=state(40);changed.inventory[0]!.count=9;
  const item=observeQuietStep({type:'useItemOnItem',fields:{sourceSlot:0,targetSlot:1}},before,changed,40_000,'observer');
  assert.equal(item.settled,false);assert.match(item.reason,/30-second quiet window/);
  const buy=observeQuietStep({type:'shopBuy',fields:{slot:0,amount:1}},before,state(40),40_000,'observer');
  assert.equal(buy.settled,false);assert.match(buy.reason,/timeout cannot authorize replay/);
});

test('stable NPC non-effect is bounded and retryable later rather than pinning the journal forever',()=>{
  const before=state(10), action={type:'interactNpc',fields:{npcIndex:3,optionIndex:1}};
  const first=observeQuietStep(action,before,state(20),1_000,'observer');
  const done=observeQuietStep(action,before,state(40),31_000,'observer',first.window);
  assert.equal(done.settled,true);assert.match(done.reason,/interrupted/i);
});

test('death reconciliation records item deltas and only claims observed coin loss as GP',()=>{
  const before=state(10),after=state(50);
  after.player={...after.player,lifeId:2,respawnCount:1,hp:20};
  after.inventory=[{id:52,name:'Arrow shaft',slot:0,count:4},{id:995,name:'Coins',slot:2,count:20}];
  const result=reconcileDeathLoss(before,after);
  assert.equal(result.settled,true);
  assert.equal(result.lostGp,30);
  assert.deepEqual(result.itemLosses.map(i=>[i.id,i.count]),[[52,6],[314,10],[995,30]]);
  assert.ok(result.evidence.some(e=>e.includes('non-coin item losses')));
});

test('death reconciliation waits for a complete post-respawn accounting observation',()=>{
  const before=state(10),after=state(50);after.player={...after.player,lifeId:2,isDead:true,hp:0};
  assert.equal(reconcileDeathLoss(before,after).settled,false);
  delete (after as any).inventory;
  assert.equal(reconcileDeathLoss(before,after).settled,false);
});
