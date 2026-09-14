import { test, expect } from 'bun:test';
import { combatDisposition, shouldHeal, chooseLocalTargets, meleeTrainingSkill, economyNext, selectWoodSite, fletchingRecipe, productionDialog, axeRank, nearbyAmmoRecovery, quiverRefill, isFletchedOutput } from './progression-policy';
const item = (name:string,slot=0,count=1,id=slot+100) => ({name,slot,count,id});
const food = {...item('Shrimps'),optionsWithIndex:[{text:'Eat',opIndex:1}]};
function state() { return {tick:100,player:{worldX:3285,worldZ:3365,level:0,hp:24,maxHp:41,combat:{inCombat:false,lastDamageTick:-1}},skills:[{name:'Woodcutting',baseLevel:71},{name:'Fletching',baseLevel:1}],inventory:[food],equipment:[],nearbyLocs:[],nearbyNpcs:[]} as any; }
function fight() { const s=state(); s.player.combat={inCombat:true,targetType:'npc',targetIndex:3,lastDamageTick:99};s.nearbyNpcs=[{index:3,name:'Giant spider',combatLevel:2,optionsWithIndex:[{text:'Attack',opIndex:2}]}];return s; }
test('heal the old 40-60 percent dead zone',()=>expect(shouldHeal(state())).toBe(true));
test('healthy ordinary combat continues instead of retreating',()=>expect(combatDisposition(fight())).toBe('engaged'));
test('unverified Wilderness monster is passed instead of triggering a full retreat',()=>{const s=fight();s.nearbyNpcs=[{index:3,name:'Ghost',combatLevel:19,optionsWithIndex:[{text:'Attack',opIndex:2}]}];expect(combatDisposition(s)).toBe('quiet');});
test('economy character escapes attackers',()=>expect(combatDisposition(fight(),true)).toBe('recover'));
test('dangerous health or missing food does not hold combat',()=>{const s=fight();s.player.hp=4;expect(combatDisposition(s)).toBe('recover');s.player.hp=30;s.inventory=[];expect(combatDisposition(s)).toBe('recover');});
test('old damage does not interrupt peaceful tasks',()=>{const s=state();s.player.combat.lastDamageTick=80;expect(combatDisposition(s)).toBe('quiet');});
test('ranged holding requires compatible ammunition',()=>{const s=fight();s.combatStyle={weaponName:'Shortbow'};s.equipment=[item('Steel arrow')];expect(combatDisposition(s,false,true)).toBe('recover');s.equipment=[item('Iron arrow')];expect(combatDisposition(s,false,true)).toBe('engaged');});
test('nearest local target beats distant namesakes',()=>expect(chooseLocalTargets([{name:'Giant spider',distance:15},{name:'Goblin',distance:2},{name:'Giant spider',distance:7}])[0].name).toBe('Goblin'));
test('legacy balancing helper has no fixed Strength-40 gate',()=>{expect(meleeTrainingSkill(16,56)).toBe('attack');expect(meleeTrainingSkill(16,25)).toBe('attack');expect(meleeTrainingSkill(60,56)).toBe('strength');});
test('pickaxes and battleaxes cannot satisfy woodcutting tool requirement',()=>{expect(axeRank('Bronze pickaxe')).toBe(0);expect(axeRank('Steel battleaxe')).toBe(0);});
test('woodcutting 71 alone does not make yew efficient for fletching 1',()=>expect(selectWoodSite(state()).name).toBe('edgeville-willow'));
test('willow endpoint is the proven east approach, outside the tree footprint',()=>expect(selectWoodSite(state())).toMatchObject({x:3113,z:3487}));
test('blocked willow route selects another prepared economy site instead of bank deadwait',()=>{
  const s=state(); s.player.worldX=3185;s.player.worldZ=3436;
  s.inventory=[item('Bronze axe'),item('Bronze pickaxe',1),item('Knife',2)];
  const m:any={}; const a=economyNext(s,m,id=>id==='economy-site-edgeville-willow')[0];
  expect(a.id).toBe('economy-site-varrock-oak'); expect(a.fields).toMatchObject({x:3170,z:3420}); expect(m.selectedSite).toBe('varrock-oak');
});
test('bank route blocker allows a different bank without treating proximity as service completion',()=>{
  const s=state(); const a=economyNext(s,{bankItems:[item('Coins',0,25)]},id=>id==='economy-bank-varrock-west')[0];
  expect(a.id).toBe('economy-bank-edgeville');
});
test('two unavailable bank services produce a persistent cooldown, not bank-to-bank hopping',()=>{
  const s=state(),m:any={bankItems:[item('Coins',0,25)]};s.player.worldX=3185;s.player.worldZ=3436;
  expect(economyNext(s,m)[0].id).toBe('economy-bank-edgeville');
  s.player.worldX=3094;s.player.worldZ=3491;
  expect(economyNext(s,m)[0].id).toBe('economy-bank-alternatives-blocked');
  expect(m.bankCooldowns['varrock-west']).toBeGreaterThan(Date.now());
});
test('empty resource observation eventually cools site and selects a feasible fallback',()=>{
  const s=state();s.player.worldX=3113;s.player.worldZ=3487;s.inventory=[item('Bronze axe'),item('Bronze pickaxe',1),item('Knife',2)];
  const m:any={};for(let i=0;i<3;i++){s.tick++;economyNext(s,m);}
  expect(m.siteCooldowns['edgeville-willow']).toBeGreaterThan(Date.now());
  expect(economyNext(s,m)[0].id).toBe('economy-site-varrock-oak');
});
test('use bank-side yews once products and axe are ready',()=>{const s=state();s.skills[1].baseLevel=65;s.inventory.push(item('Steel axe'));expect(selectWoodSite(s).name).toBe('edgeville-yew');});
test('all 2004 fletching gates respected',()=>{expect(fletchingRecipe('Logs',1)).toBe('Arrow Shafts');expect(fletchingRecipe('Willow logs',34)).toBe(null);expect(fletchingRecipe('Willow logs',35)).toBe('Willow Short Bow');expect(fletchingRecipe('Yew logs',70)).toBe('Yew Long Bow');});
test('choose observed product index, not Make X button',()=>expect(productionDialog([{text:'Make X',index:0},{text:'Arrow Shafts',index:11}], 'Arrow Shafts')?.index).toBe(11));
test('lost tools route to bank funds, not an unusable mine',()=>{const s=state();const a=economyNext(s,{bankItems:[item('Coins',0,25)]})[0];expect(a.id).toBe('economy-bank-varrock-west');});
test('bank withdrawal reserves a tool budget',()=>{const s=state();s.bank={isOpen:true,items:[item('Coins',0,25)]};expect(economyNext(s,{})[0].fields?.amount).toBe(25);});
test('buy axe and leave enough for pickaxe',()=>{const s=state();s.inventory=[item('Coins',0,25)];s.shop={isOpen:true,shopItems:[{...item('Bronze axe',0),buyPrice:16},{...item('Bronze pickaxe',1),buyPrice:1}]};expect(economyNext(s,{})[0].fields?.slot).toBe(0);s.inventory.push(item('Bronze axe',1));s.inventory[0].count=9;expect(economyNext(s,{})[0].fields?.slot).toBe(1);});
test('free knife pickup requires actual nearby reachable item',()=>{const s=state();s.inventory=[item('Bronze axe'),item('Bronze pickaxe',1)];s.groundItems=[{...item('Knife',2,1,946),x:3224,z:3202,reachable:true}];expect(economyNext(s,{})[0].type).toBe('walkTo');s.player.worldX=3224;s.player.worldZ=3202;expect(economyNext(s,{})[0].type).toBe('pickupItem');});
test('banked useful logs are processed before another chopping trip',()=>{const s=state();s.inventory=[item('Bronze axe'),item('Bronze pickaxe',1),item('Knife',2)];s.bank={isOpen:true,items:[item('Willow logs',0,26),item('Logs',1,110)]};const m:any={};const a=economyNext(s,m)[0];expect(a.fields?.slot).toBe(1);expect(m.product).toBe('Arrow Shafts');});
test('full logs inventory deposits while keeping tools',()=>{const s=state();s.inventory=[item('Bronze axe'),item('Knife',1),item('Logs',2)];s.bank={isOpen:true,items:[]};expect(economyNext(s,{})[0].fields?.slot).toBe(2);});
test('processing uses knife on log, not nonexistent inventory Fletch',()=>{const s=state();s.inventory=[item('Bronze axe'),item('Bronze pickaxe',1),item('Knife',2),item('Logs',3)];const a=economyNext(s,{processing:'logs'})[0];expect(a.type).toBe('useItemOnItem');expect(a.fields).toEqual({sourceSlot:2,targetSlot:3});});
test('recover reachable compatible arrows between fights only',()=>{const s=state();s.combatStyle={weaponName:'Shortbow'};s.groundItems=[{...item('Iron arrow',0,3,884),reachable:true,distance:2,x:3233,z:3295}];expect(nearbyAmmoRecovery(s)[0].fields?.itemId).toBe(884);s.player.combat.inCombat=true;expect(nearbyAmmoRecovery(s)).toEqual([]);s.player.combat.inCombat=false;s.groundItems[0].reachable=false;expect(nearbyAmmoRecovery(s)).toEqual([]);});
test('Make 10 belongs to the chosen product, not the first group',()=>expect(productionDialog([{index:2,text:'Make 10',componentId:8887},{index:4,text:'15 Arrow Shafts',componentId:8889},{index:6,text:'Make 10',componentId:8891},{index:8,text:'Short Bow',componentId:8893}], 'Short Bow')?.index).toBe(6));
test('do not reopen the chooser while production animates',()=>{const s=state();s.inventory=[item('Bronze axe'),item('Bronze pickaxe',1),item('Knife',2),item('Logs',3)];s.player.animId=1248;expect(economyNext(s,{processing:'logs'})[0].id).toBe('economy-continue-production');});
test('unstrung display names match finished bows but IDs distinguish them',()=>{expect(isFletchedOutput(item('Longbow',0,1,48))).toBe(true);expect(isFletchedOutput(item('Longbow',0,1,839))).toBe(false);expect(isFletchedOutput(item('Shortbow',0,1,841))).toBe(false);});
test('deposit all matching unstrung bows, retain usable starter bow',()=>{const s=state();s.inventory=[item('Shortbow',0,1,841),item('Longbow',1,1,48),item('Longbow',2,1,48)];s.bank={isOpen:true,items:[]};expect(economyNext(s,{})[0].fields).toEqual({slot:1,amount:2});});
test('a withdrawn sale batch closes the bank instead of being deposited again',()=>{const s=state();s.inventory=[item('Longbow',1,2,48)];s.bank={isOpen:true,items:[]};expect(economyNext(s,{selling:true})[0].id).toBe('economy-close-interface');});
test('refill an empty quiver during combat rather than retreat forever',()=>{const s=fight();s.player.hp=40;s.combatStyle={weaponName:'Shortbow'};s.inventory=[{...item('Iron arrow',12,19,884),optionsWithIndex:[{text:'Wield',opIndex:2}]}];expect(quiverRefill(s)[0].fields?.slot).toBe(12);s.equipment=[item('Iron arrow',13,10,884)];expect(quiverRefill(s)).toEqual([]);});
