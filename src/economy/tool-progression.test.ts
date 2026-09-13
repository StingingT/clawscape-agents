import { test, expect } from 'bun:test';
import { bestToolTier, TOOL_TIERS, toolPlan } from './tool-progression';

const item=(id:number,name:string,count=1)=>({id,name,count});
const state=(woodcutting=71,mining=1,smithing=1)=>({skills:[
  {name:'Woodcutting',baseLevel:woodcutting},{name:'Mining',baseLevel:mining},{name:'Smithing',baseLevel:smithing},
],inventory:[item(1351,'Bronze axe'),item(1265,'Bronze pickaxe')]});

test('CoinCrafter declares Rune axe as the long-term target when Yew is available',()=>{
  const plan=toolPlan(state())!;
  expect(plan.finalAxe.axeId).toBe(1359);
  expect(plan.stage.barId).toBe(2349);
  expect(plan.reason).toContain('Smithing 16');
});

test('Smithing milestones advance from training bars to the next axe',()=>{
  const s=state(71,15,16);s.inventory[0]=item(1351,'Bronze axe');
  expect(toolPlan(s)!.stage).toMatchObject({axeId:1349,barId:2351,smithing:16});
  s.inventory[1]=item(1349,'Iron axe');s.skills[2].baseLevel=31;
  expect(toolPlan(s)!.stage).toMatchObject({axeId:1353,barId:2353,smithing:31});
});

test('Pickaxe tier is measured independently and does not invent smithing recipes',()=>{
  const s=state(20,41,1);s.inventory=[];
  expect(bestToolTier(s.inventory,'pickaxe')).toBe(0);
  expect(TOOL_TIERS.find(t=>t.pickaxeId===1275)?.tier).toBe(6);
  expect(toolPlan(s)!.needsMetalworking).toBe(true);
});
