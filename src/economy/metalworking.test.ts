import { test,expect } from 'bun:test';
import { economyNext } from '../progression-policy';
import { economyTrack,canMine,miningHints,miningHintsFor,metalNext,metalDialog,validateMetal } from './metalworking';
import { loadGearCatalog } from '../goals/catalog';
const item=(id:number,name:string,count=1,slot=0)=>({id,name,count,slot});
const state=()=>({tick:10,player:{worldX:3285,worldZ:3365,level:0,hp:11,maxHp:11,animId:-1},skills:[{name:'Woodcutting',baseLevel:99},{name:'Fletching',baseLevel:99},{name:'Mining',baseLevel:1},{name:'Smithing',baseLevel:1},{name:'Attack',baseLevel:1}],inventory:[item(1265,'Bronze pickaxe'),item(2347,'Hammer',1,1),item(995,'Coins',50,2)],equipment:[],nearbyLocs:[]} as any);

test('unfunded pickaxe audit cannot block smelting carried iron when coal route fails',()=>{
  const s=state();s.skills[2].baseLevel=57;s.skills[3].baseLevel=32;
  s.inventory=[item(1271,'Adamant pickaxe'),item(2347,'Hammer',1,1),item(440,'Iron ore',9,2)];
  const m:any={bankItems:[],metal:{bar:2353,bulkPickaxeAudit:'pending'},objectives:{intent:{track:'metalworking',inputId:2353}}};
  const next=metalNext(s,m,id=>id==='economy-metal-mine-route-m51_51');
  expect(m.metal.bulkPickaxeAudit).toBe('complete');expect(m.metal.bar).toBe(2351);
  expect(next[0]?.id).toBe('economy-metal-furnace');
});
test('maxed woodworking does not force a discipline change',()=>{const s=state();expect(economyTrack(s)).toBe('woodworking');s.skills[1].baseLevel=98;expect(economyTrack(s,{objectives:{intent:{track:'metalworking'}}} as any)).toBe('metalworking');});
test('carried pickaxes depend on Mining, not Attack',()=>{const s=state();s.inventory=[item(1273,'Mithril pickaxe')];expect(canMine(s)).toBe(false);s.skills[2].baseLevel=21;expect(canMine(s)).toBe(true);});
test('catalog includes real pickaxe gates and keeps unverified underground shop disabled',()=>{const c=loadGearCatalog(),p=c.items.find(i=>i.symbol==='rune_pickaxe')!;expect(p.requires).toEqual([{skill:'mining',level:41}]);expect(p.methods.find(m=>m.kind==='buy')?.blocker).toBeTruthy();expect(p.methods.some(m=>m.kind==='craft')).toBe(false);});
test('selected mining task uses observed source-matched ore option, never just the Rocks label',()=>{const s=state(),p=miningHints().find(p=>p.id===2090)!;s.nearbyLocs=[{...p,name:'Rocks',reachable:true,distance:1,optionsWithIndex:[{text:'Mine',opIndex:1}]}];
  const m:any={objectives:{intent:{track:'metalworking'}},processing:'yew logs',product:'Yew longbow'},a=economyNext(s,m)[0]!;expect(a.type).toBe('interactLoc');expect(a.fields?.locId).toBe(2090);expect(m.processing).toBeUndefined();
  s.nearbyLocs[0].id=2096;expect(metalNext(s,{}).some(a=>a.type==='interactLoc')).toBe(false);
});
test('balanced bronze batch goes to furnace, not more trees',()=>{const s=state();s.inventory.push(item(436,'Copper ore',8,3),item(438,'Tin ore',8,4));const m:any={};const a=metalNext(s,m)[0]!;expect(m.metal.phase).toBe('smelt');expect(a.id).toBe('economy-metal-furnace');});
test('banking preserves pickaxe/hammer and resumes without redepositing withdrawn inputs',()=>{
  const s=state();s.bank={isOpen:true,items:[item(436,'Copper ore',12),item(438,'Tin ore',12,1)]};const m:any={};
  const a=metalNext(s,m)[0]!;expect(a.type).toBe('bankWithdraw');expect(a.fields?.amount).toBe(8);
  s.inventory.push(item(436,'Copper ore',8,3));s.bank.items[0].count=4;
  expect(metalNext(s,m)[0]!.fields?.slot).toBe(1);
  s.inventory.push(item(438,'Tin ore',8,4));s.bank.items[1].count=4;
  expect(metalNext(s,m)[0]!.type).toBe('closeModal');expect(m.metal.phase).toBe('smelt');
});
test('unsupported smith interface banks bars instead of guessing a button',()=>{const m:any={metal:{phase:'smith',product:'Bronze arrowheads'}};const a=metalDialog({dialog:{isOpen:true,options:[{index:4,text:'Other product'}]}},m);expect(a?.type).toBe('closeModal');expect(m.metal.phase).toBe('bank');});
test('fresh price and slot revalidation rejects a changed tool purchase',()=>{const s=state();s.shop={isOpen:true,shopItems:[{id:2347,slot:0,count:1,buyPrice:2}]};expect(validateMetal(s,{id:'economy-metal-buy-hammer',type:'shopBuy',waitTicks:2,fields:{slot:0,itemId:2347,expectedPrice:1}})).toBe(false);});
test('level 15 unlock does not abandon an already loaded bronze batch',()=>{const s=state();s.skills[2].baseLevel=15;s.skills[3].baseLevel=15;s.inventory.push(item(436,'Copper ore',8,3),item(438,'Tin ore',8,4));const m:any={metal:{phase:'smelt',ore:436}};metalNext(s,m);expect(m.metal.phase).toBe('smelt');expect(m.metal.ore).toBe(436);});
test('all axe tiers stay available while unrelated clutter goes safely to bank',()=>{const s=state();s.bank={isOpen:true,items:[]};s.inventory.push(item(1353,'Steel axe',1,3),item(9999,'Unrelated clutter',1,4));expect(metalNext(s,{})[0]).toMatchObject({type:'bankDeposit',fields:{slot:4,amount:1}});});
test('missing furnace after exact arrival produces a bounded service cooldown',()=>{const s=state();s.player.worldX=3229;s.player.worldZ=3255;s.inventory.push(item(436,'Copper ore',8,3),item(438,'Tin ore',8,4));const m:any={metal:{phase:'smelt',ore:436}};for(let i=0;i<3;i++){s.tick++;metalNext(s,m);}expect(m.metal.phase).toBe('bank');expect(m.metal.smeltBlockedUntil).toBeGreaterThan(Date.now());});
test('fresh bank slots cannot silently redirect an intended withdrawal',()=>{const a:any={id:'economy-metal-withdraw-bars',type:'bankWithdraw',fields:{slot:0,amount:1}};const before={bank:{isOpen:true,items:[item(2349,'Bronze bar')]}};const after={bank:{isOpen:true,items:[item(995,'Coins',50)]}};expect(validateMetal(after,a,before)).toBe(false);});
test('source-derived coal and rune routes are available for later smelting tiers',()=>{
  expect(miningHintsFor([2096,2097]).some(p=>p.x===3302&&p.z===3317)).toBe(true);
  expect(miningHintsFor([2106,2107]).some(p=>p.x===3059&&p.z===3885)).toBe(true);
});
test('metalworking keeps mining until the selected higher-tier bar is ready',()=>{
  const s=state();s.player.worldX=3285;s.player.worldZ=3368;s.skills[2].baseLevel=30;s.skills[3].baseLevel=31;s.inventory=[item(1269,'Steel pickaxe'),item(2347,'Hammer')];
  const m:any={objectives:{intent:{track:'metalworking',mode:'metal',inputId:2353,inputName:'Steel bar',outputId:1353,toolTargetId:1359,reason:'tool ladder'}}};
  s.nearbyLocs=[{id:2092,name:'Rocks',x:3285,z:3368,reachable:true,distance:1,optionsWithIndex:[{text:'Mine',opIndex:1}]}];
  const a=metalNext(s,m)[0]!;expect(a.type).toBe('interactLoc');expect(a.fields.locId).toBe(2092);expect(m.goal).toBe('mine-iron');
});
test('pickaxes are purchased from observed stock instead of sent to Smithing',()=>{
  const s=state();s.skills[2].baseLevel=15;s.inventory=[item(1351,'Bronze axe'),item(1265,'Bronze pickaxe'),item(2347,'Hammer'),item(995,'Coins',500,3)];
  s.shop={isOpen:true,shopItems:[{id:1267,name:'Iron pickaxe',count:1,slot:4,buyPrice:100}]};
  const a=metalNext(s,{})[0]!;expect(a.type).toBe('shopBuy');expect(a.fields.itemId).toBe(1267);expect(a.fields.expectedPrice).toBe(100);
});
test('bank withdraws a real pickaxe budget instead of reopening with pocket change',()=>{
  const s=state();s.skills[2].baseLevel=15;s.inventory=[item(1351,'Bronze axe'),item(1265,'Bronze pickaxe'),item(2347,'Hammer'),item(995,'Coins',50,3)];
  s.bank={isOpen:true,items:[item(995,'Coins',5000,8)]};
  const a=metalNext(s,{})[0]!;
  expect(a).toMatchObject({type:'bankWithdraw',fields:{slot:8,amount:650}});
});
test('hammer can be bought opportunistically from an already open shop',()=>{
  const s=state();s.inventory=[item(1351,'Bronze axe'),item(1265,'Bronze pickaxe'),item(995,'Coins',50,2)];
  s.shop={isOpen:true,shopItems:[{id:2347,name:'Hammer',count:1,slot:3,buyPrice:5}]};
  const a=metalNext(s,{})[0]!;expect(a.type).toBe('shopBuy');expect(a.fields.itemId).toBe(2347);expect(a.fields.expectedPrice).toBe(5);
});

const mineState=()=>{
  const s=state();s.player.worldX=3031;s.player.worldZ=9825;
  s.inventory=[item(1353,'Steel axe'),item(995,'Coins',249,1),item(1265,'Bronze pickaxe',1,2)];
  s.nearbyLocs=[{id:2091,name:'Rocks',x:3030,z:9825,level:0,reachable:true,distance:1,optionsWithIndex:[{text:'Mine',opIndex:2}]},
    {id:2095,name:'Rocks',x:3033,z:9824,level:0,reachable:true,distance:2,optionsWithIndex:[{text:'Mine',opIndex:3}]}];
  return s;
};
test('mine local cave copper without detouring for a hammer or trying locked iron',()=>{
  const s=mineState(),m:any={objectives:{intent:{track:'metalworking',inputId:2351,outputId:1349,toolTargetId:1359}}};
  const a=metalNext(s,m)[0]!;
  expect(a).toMatchObject({type:'interactLoc',fields:{locId:2091,x:3030,z:9825,optionIndex:2}});
  expect(m.metal.bar).toBe(2349);expect(m.goal).toBe('mine-copper');expect(m.selectedSite).toBe('dwarven-mine');
  expect(validateMetal(s,a)).toBe(true);s.nearbyLocs[0].optionsWithIndex[0].opIndex=4;expect(validateMetal(s,a)).toBe(false);
});
test('out-of-view cave rocks use the underground approach, not a surface mine',()=>{
  const s=mineState();s.player.worldX=2999;s.player.worldZ=9849;s.nearbyLocs=[];
  expect(metalNext(s,{})[0]).toMatchObject({type:'walkTo',fields:{x:3031,z:9825,level:0}});
});
test('eight copper switch to tin, even when cached bank supplies already exist',()=>{
  const s=mineState();s.inventory.push(item(436,'Copper ore',8,3));
  const m:any={metal:{bar:2349},bankItems:[item(436,'Copper ore',100),item(438,'Tin ore',100)]};
  expect(metalNext(s,m)[0]).toMatchObject({type:'interactLoc',fields:{locId:2095,optionIndex:3}});expect(m.goal).toBe('mine-tin');
});
test('level-up pickaxe upgrades do not interrupt a carried bronze batch',()=>{
  const s=mineState();s.skills[2].baseLevel=20;s.inventory.push(item(436,'Copper ore',8,3));
  expect(metalNext(s,{metal:{bar:2349}})[0]).toMatchObject({type:'interactLoc',fields:{locId:2095}});
});
test('completed cave batch leaves via the observed ladder without requiring a hammer',()=>{
  const s=mineState();s.inventory.push(item(436,'Copper ore',8,3),item(438,'Tin ore',8,4));
  s.nearbyLocs.push({id:1755,name:'Ladder',x:3019,z:9850,level:0,reachable:true,optionsWithIndex:[{text:'Climb-up',opIndex:2}]});
  const m:any={};expect(metalNext(s,m)[0]).toMatchObject({type:'interactLoc',fields:{locId:1755,optionIndex:2}});expect(m.metal.phase).toBe('smelt');
  s.nearbyLocs=[];expect(metalNext(s,m)[0]).toMatchObject({type:'walkTo',fields:{x:3018,z:9850}});
});
test('partly smelted bronze batch continues until its ingredients are consumed',()=>{
  const s=state();s.inventory=s.inventory.filter((i:any)=>i.id!==2347);
  s.inventory.push(item(436,'Copper ore',7,3),item(438,'Tin ore',7,4),item(2349,'Bronze bar',1,5));
  const m:any={metal:{phase:'smelt',bar:2349,ore:436}};
  expect(metalNext(s,m)[0]!.id).toBe('economy-metal-furnace');expect(m.metal.phase).toBe('smelt');
});
test('hammer shopping starts when bars are ready for smithing',()=>{
  const s=state();s.inventory=s.inventory.filter((i:any)=>i.id!==2347);s.inventory.push(item(2349,'Bronze bar',8,3));
  const m:any={metal:{phase:'smith',bar:2349}};
  expect(metalNext(s,m)[0]!.type).toBe('walkTo');expect(m.goal).toBe('obtain-smithing-hammer');
});
