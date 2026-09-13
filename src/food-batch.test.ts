import {test, expect} from 'bun:test';
import {advanceFoodBatch, bankFood, loweDoor, type FoodBatch} from './food-batch';
import {combatDisposition} from './progression-policy';
test('one fish does not finish gathering; full bag cooks, then banks', () => {
  let batch: FoodBatch = {phase:'gather',startedAt:1};
  const raw = {name:'Raw shrimps'};
  expect(advanceFoodBatch(batch,[raw]).phase).toBe('gather');
  batch=JSON.parse(JSON.stringify(batch)); // restart restores unfinished phase
  expect(advanceFoodBatch(batch,Array(28).fill(raw)).phase).toBe('cook');
  expect(advanceFoodBatch(batch,[raw,{name:'Shrimps'}]).phase).toBe('cook');
  expect(advanceFoodBatch(batch,[{name:'Shrimps'}]).phase).toBe('bank');
});
test('bank food does not need inventory Eat options',()=>expect(bankFood({name:'Lobster',count:50})).toBe(true));
test('Lowe recovery opens only the observed closed shop door',()=>{
  const s:any={nearbyNpcs:[{name:'Lowe',reachable:false}],nearbyLocs:[{id:1530,name:'Door',x:3234,z:3426,level:0,reachable:true,optionsWithIndex:[{text:'Open',opIndex:1}]}]};
  expect(loweDoor(s)[0].fields.locId).toBe(1530);
  s.nearbyLocs[0].optionsWithIndex[0].text='Close';expect(loweDoor(s)).toEqual([]);
});
test('measured small damage permits low-percent HP; dangerous margin still retreats',()=>{
  const s:any={player:{hp:20,maxHp:81,combatLevel:65,combat:{inCombat:true,targetType:'npc',targetIndex:1}},nearbyNpcs:[{index:1,name:'Goblin',combatLevel:2,optionsWithIndex:[{text:'Attack'}]}],inventory:[]};
  expect(combatDisposition(s,false,false,2)).toBe('engaged');
  s.player.hp=5;expect(combatDisposition(s,false,false,2)).toBe('recover');
});
