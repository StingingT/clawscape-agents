import { test,expect } from 'bun:test';
import { usefulXp,outcomeReward } from './outcomes';
import { loadGearCatalog } from './catalog';
const catalog=loadGearCatalog();
const s=(level=98,xp=100)=>({skills:[{name:'Strength',baseLevel:level,experience:xp}],inventory:[],equipment:[],player:{lifeId:1}} as any);
test('XP beyond a capped skill is not greater strength',()=>{expect(usefulXp(s(99),s(99,1000),'brawler',false)).toBe(0);expect(usefulXp(s(98),s(99,1000),'brawler',false)).toBe(9);});
test('banks and mass-produced shafts are not cash income',()=>{const before=s(),after=s();after.inventory=[{id:52,name:'Arrow shaft',count:1000}];expect(outcomeReward(before,after,{type:'useItemOnItem'},'economy',false,catalog)).toBe(0);expect(outcomeReward(before,after,{type:'bankWithdraw'},'economy',false,catalog)).toBe(0);});
test('an actual usable equipment upgrade still improves the objective at capped XP',()=>{const before=s(99),after=s(99);before.skills.push({name:'Attack',baseLevel:40});after.skills.push({name:'Attack',baseLevel:40});before.equipment=[{id:1277,name:'Bronze sword',count:1}];after.equipment=[{id:1333,name:'Rune scimitar',count:1}];expect(outcomeReward(before,after,{type:'useInventoryItem'},'brawler',false,catalog)).toBeGreaterThan(0);});
