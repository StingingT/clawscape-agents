import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGearCatalog, type Gear, type GearCatalog, type Method } from './catalog';
import { EquipmentGoals, compareMethods, selectUpgrade, usable, recipeReady, type GoalMemory } from './planner';
import { saveGoalJson } from './persistence';
import { renameSync } from 'node:fs';

const shop={id:'shop',name:'Weapon shop',npc:'Merchant',x:100,z:100,level:0,enabled:true,source:'fixture'};
const buy=(id:number,price:number):Method=>({id:'buy:'+id,kind:'buy',shop,priceHint:price,source:'fixture'});
const gear=(id:number,quality:number,price:number):Gear=>({id,name:'Sword '+id,symbol:'sword_'+id,family:'melee',quality,requires:[{skill:'attack',level:1}],methods:[buy(id,price)],source:'fixture',tool:false});
const state=(cash=1000):any=>({tick:1,player:{name:'test',worldX:100,worldZ:100,level:0,hp:20,maxHp:20,lifeId:1,animId:-1},skills:[{name:'Attack',level:40,baseLevel:40},{name:'Smithing',level:1,baseLevel:1}],
  inventory:[{id:995,name:'Coins',count:cash,slot:0},{id:1,name:'Sword 1',count:1,slot:1,optionsWithIndex:[{text:'Wield',opIndex:2}]}],equipment:[{id:1,name:'Sword 1',count:1,slot:3}],nearbyNpcs:[],nearbyLocs:[],bank:{isOpen:false,items:[]},shop:{isOpen:false,shopItems:[]},dialog:{isOpen:false,options:[]}});
const memory=():GoalMemory=>({version:1,namespace:'test',bank:[],bankCheckedAt:1,cooldowns:{},prices:{},samples:{},completed:[]});
const withPlanner=async(fn:(p:EquipmentGoals,dir:string,c:GearCatalog)=>unknown,items=[gear(1,1,5),gear(2,3,30),gear(3,8,300)])=>{
  const dir=mkdtempSync(join(tmpdir(),'clawscape-goal-test-')),c={namespace:'test',items,shops:[shop],evidence:[]};
  try {const p=new EquipmentGoals(join(dir,'goals.json'),c,'brawler',false,()=>100_000);p.memory.bankCheckedAt=1;await fn(p,dir,c);}finally{rmSync(dir,{recursive:true,force:true});}
};
const route=async()=>({status:'ready',cost:10});

test('catalog reads real source recipe levels, stats and shop restrictions',()=>{
  const c=loadGearCatalog();
  const rune=c.items.find(i=>i.symbol==='rune_scimitar')!;
  expect(rune.quality).toBeGreaterThan(10);
  expect(rune.methods.find(m=>m.kind==='craft')?.level).toBe(90);
  expect(rune.methods.find(m=>m.kind==='craft')?.inputs?.[0]?.count).toBe(2);
  expect(rune.methods.some(m=>m.kind==='buy')).toBe(false);
  expect(c.items.find(i=>i.symbol==='dragonhide_chaps')?.methods.find(m=>m.kind==='craft')?.level).toBe(60);
  expect(c.shops.find(s=>s.id==='scavvos-rune-store')?.enabled).toBe(false);
  expect(c.items.find(i=>i.symbol==='mithril_axe')?.requires).toEqual([{skill:'woodcutting',level:21}]);
});
test('rich character skips cheap intermediate tiers and chooses useful best shop upgrade',()=>{
  const s=state(),m=memory(),items=[gear(2,3,30),gear(3,8,300)];
  expect(selectUpgrade(items.flatMap(i=>compareMethods(i,s,m)),new Map([['melee',1]]))?.item.id).toBe(3);
});
test('brawler advances through the next affordable melee tier before Rune',async()=>{
  const s=state(1000);const c=loadGearCatalog();
  const dir=mkdtempSync(join(tmpdir(),'clawscape-rune-goal-'));
  try {
    const goal=new EquipmentGoals(join(dir,'goals.json'),c,'brawler',false,()=>100_000);
    goal.memory.bankCheckedAt=1;
    goal.plan({...s,skills:[{name:'Attack',level:40,baseLevel:40}],equipment:[{id:1321,name:'Bronze scimitar',count:1,slot:3}]});
    expect(goal.memory.active?.item).toBe(c.items.find(i=>i.symbol==='iron_scimitar')!.id);
    expect(goal.memory.active?.method).not.toBe('milestone:rune-scimitar');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('unaffordable gear becomes a funding goal, not zero-effort gear',()=>{
  const c=compareMethods(gear(3,8,300),state(1),memory())[0]!;
  expect(c.seconds).toBeNull();expect(c.blockers).toContain('Earn or withdraw the purchase budget');
});
test('craft can beat buying when skill and materials are already available',()=>{
  const g=gear(3,8,300);g.methods[0]!.shop={...shop,x:900,z:900};
  g.methods.push({id:'craft:3',kind:'craft',recipe:'string',skill:'smithing',level:1,inputs:[{id:77,name:'bar',count:2}],source:'fixture'});
  const s=state();s.inventory.push({id:77,count:2,name:'bar'});
  expect(selectUpgrade(compareMethods(g,s,memory()),new Map())?.method.id).toBe('craft:3');
});
test('missing skill, ores/leather and unknown dangerous drops are blockers, not free routes',()=>{
  const m:Method={id:'craft:3',kind:'craft',recipe:'smith',skill:'smithing',level:90,inputs:[{id:77,name:'runite bar',count:2}],source:'fixture'};
  expect(recipeReady(m,state())).toEqual(['smithing 90 (now 1)','2 runite bar']);
  expect(usable({...gear(4,9,1),requires:[{skill:'defence',level:40}]},state())).toBe(false);
});
test('goal survives restart and unrelated movement/supply interruptions',async()=>withPlanner(async(p,dir,c)=>{
  p.plan(state());const first=p.memory.active;
  const next=new EquipmentGoals(join(dir,'goals.json'),c,'brawler',false,()=>100_001);
  const s=state();s.player.worldX=110;s.player.hp=5;
  next.plan(s);expect(next.memory.active?.item).toBe(first?.item);expect(next.memory.active?.started).toBe(first?.started);
}));
test('banked better item is withdrawn instead of buying a duplicate',async()=>withPlanner(async p=>{
  const s=state();s.bank={isOpen:true,items:[{id:3,name:'Sword 3',count:1,slot:8}]};
  const a=await p.next(s,route);expect(a?.type).toBe('bankWithdraw');expect(a?.fields?.slot).toBe(8);
  expect(p.memory.completed).toHaveLength(0);
}));
test('full bank observation precedes relying on old cached ownership',async()=>withPlanner(async p=>{
  p.memory.bankCheckedAt=0;
  const a=await p.next(state(),route);expect(a?.id).toBe('goal-bank-route');expect(p.memory.active?.phase).toBe('bank-audit');
}));
test('purchase checks live slot/price and preserves food cash',async()=>withPlanner(async p=>{
  const s=state(1000);s.shop={isOpen:true,shopItems:[{id:3,name:'Sword 3',slot:9,count:1,buyPrice:350}]};
  const a=await p.next(s,route);expect(a?.type).toBe('shopBuy');expect(a?.fields?.slot).toBe(9);expect(a?.fields?.expectedPrice).toBe(350);
  expect(p.memory.completed).toHaveLength(0);
}));
test('observed shop can sell a rune scimitar even when no catalog shop normally does',async()=>{
  const g=gear(3,8,300);g.methods=[];
  await withPlanner(async p=>{const s=state();s.shop={isOpen:true,shopItems:[{id:3,name:'Sword 3',slot:5,count:1,buyPrice:100}]};expect((await p.next(s,route))?.type).toBe('shopBuy');},[gear(1,1,5),g]);
});
test('acquired weapon is not complete until actually equipped, no repurchase',async()=>withPlanner(async p=>{
  const s=state();p.plan(s);s.inventory.push({id:3,name:'Sword 3',count:1,slot:4,optionsWithIndex:[{text:'Wield',opIndex:2}]});
  const a=await p.next(s,route);expect(a?.type).toBe('useInventoryItem');expect(p.memory.completed).toHaveLength(0);
  const after=structuredClone(s);after.equipment=[{id:3,name:'Sword 3',count:1,slot:3}];
  p.after(s,after,a!);expect(p.memory.completed.at(-1)?.item).toBe(3);
}));
test('two successful dispatches without purchase effect defer the method',async()=>withPlanner(async p=>{
  const s=state();s.shop={isOpen:true,shopItems:[{id:3,name:'Sword 3',slot:9,count:1,buyPrice:300}]};
  const a=(await p.next(s,route))!;p.after(s,s,a);p.after(s,s,a);
  expect(p.memory.active?.phase).toBe('blocked');expect(p.memory.completed).toHaveLength(0);
}));
test('blocked routes do not become arrival or an endless repeated shopping trip',async()=>withPlanner(async p=>{
  expect(await p.next(state(),async()=>({status:'blocked',reason:'partial-path'}))).toBeUndefined();
  expect(p.memory.active?.reason).toContain('partial-path');expect(p.memory.completed).toHaveLength(0);
}));
test('uncertain money/item transaction is not automatically replayed',async()=>withPlanner(async p=>{
  const s=state();s.shop={isOpen:true,shopItems:[{id:3,slot:9,count:1,buyPrice:300}]};const a=(await p.next(s,route))!;
  p.failed(a,'CLI timeout');p.plan(s);expect(p.memory.uncertain?.method).toBe(a.fields?.goalMethod);
  expect(p.memory.active?.method).not.toBe(a.fields?.goalMethod);
}));
test('stale shop slot, increased price or closed shop rejects a prepared purchase',async()=>withPlanner(async p=>{
  const s=state();s.shop={isOpen:true,shopItems:[{id:3,slot:9,count:1,buyPrice:300}]};const a=(await p.next(s,route))!;
  expect(p.validate(s,a)).toBe(true);
  s.shop.shopItems[0].buyPrice=900;expect(p.validate(s,a)).toBe(false);
  s.shop.shopItems[0].buyPrice=300;s.shop.shopItems[0].id=999;expect(p.validate(s,a)).toBe(false);
  s.shop.shopItems[0].id=3;s.shop.isOpen=false;expect(p.validate(s,a)).toBe(false);
}));
test('gathering axe is considered usable from inventory without training Attack',async()=>{
  const g={...gear(3,4,300),family:'axe' as const,tool:true,requires:[{skill:'woodcutting',level:21}]};
  const s=state();s.skills=[{name:'Attack',level:1},{name:'Woodcutting',baseLevel:71}];
  expect(usable(g,s)).toBe(true);
});
test('banked production funds economy reserve rather than accumulating unsold bows forever',async()=>{
  await withPlanner(async(p)=>{
    const s=state(96);s.bank={isOpen:true,items:[{id:66,name:'Yew longbow',count:20,slot:7}]};
    const economy=new EquipmentGoals(join((p as any).file+'-economy'),{namespace:'test',items:[],shops:[shop],evidence:[]},'economy',false,()=>100_000);
    const a=await economy.next(s,route);expect(a?.type).toBe('bankWithdraw');expect(a?.fields?.expectedItemId).toBe(66);
    expect(economy.memory.overview.capital.targetCoins).toBe(2000);
  });
});
test('insufficient spending reserve prevents purchase despite raw cash covering the item',async()=>withPlanner(async p=>{
  const s=state(300);s.shop={isOpen:true,shopItems:[{id:3,slot:9,count:1,buyPrice:300}]};
  const a=await p.next(s,route);expect(a?.type).not.toBe('shopBuy');
}));
test('short safe pickpocket funding avoids a distant tool trip, but low health refuses it',async()=>{
  const s=state(100);s.inventory=s.inventory.filter((i:any)=>i.id!==1);s.inventory.push({id:315,name:'Shrimps',count:1,slot:2,optionsWithIndex:[{text:'Eat',opIndex:1}]},{id:315,name:'Shrimps',count:1,slot:3,optionsWithIndex:[{text:'Eat',opIndex:1}]});
  s.nearbyNpcs=[{name:'Man',index:8,reachable:true,distance:2,optionsWithIndex:[{text:'Pickpocket',opIndex:3}]}];
  await withPlanner(async p=>{
    (p as any).ranged=true;p.memory.active={item:3,method:'buy:3',started:1,lastProgress:1,phase:'funding',reason:'',attempts:0};
    expect((p as any).funding(s,110)?.id).toBe('goal-funding-pickpocket');
    s.player.hp=5;p.memory.prices['support:bronze-axe']=500;
    expect((p as any).funding(s,110)).toBeUndefined();
  });
});
test('temporary Windows checkpoint lock retries without losing the previous file',async()=>withPlanner(async(p,dir)=>{
  const file=join(dir,'atomic.json');let calls=0;
  saveGoalJson(file,{goal:'rune'},(from,to)=>{if(++calls<3)throw Object.assign(new Error('scanner lock'),{code:'EPERM'});renameSync(from,to);});
  expect(calls).toBe(3);expect(JSON.parse(readFileSync(file,'utf8')).goal).toBe('rune');
}));
test('a blocked funding resource does not churn through every gear target',async()=>withPlanner(async p=>{
  const s=state(0);s.player.worldX=3169;s.player.worldZ=3420;
  s.inventory.push({id:1351,name:'Bronze axe',count:1,slot:5});
  const result=await p.next(s,route),target=p.memory.active?.item;
  expect(result).toBeUndefined();expect(p.memory.supportBlocked?.reason).toContain('service');
  p.plan(s);expect(p.memory.active?.item).toBe(target);expect(Object.keys(p.memory.cooldowns)).toHaveLength(0);
}));
test('funding can harvest observed oak once Woodcutting permits it',async()=>withPlanner(async p=>{
  const s=state(0);s.skills.push({name:'Woodcutting',baseLevel:15});s.inventory.push({id:1351,name:'Bronze axe',count:1,slot:5});
  s.nearbyLocs=[{id:1281,name:'Oak',x:101,z:100,reachable:true,distance:1,optionsWithIndex:[{text:'Chop down',opIndex:1}]}];
  expect((await p.next(s,route))?.type).toBe('interactLoc');
}));
test('profit-oriented production still sells surplus beyond the old 2000 gp milestone',async()=>withPlanner(async(p,dir)=>{
  const e=new EquipmentGoals(join(dir,'economy.json'),{namespace:'test',items:[],shops:[],evidence:[]},'economy',false,()=>100_000);
  e.setWorkIntent({track:'woodworking',outputId:66,allowLiquidation:true,reserve:{66:1}});
  const s=state(5000);s.bank={isOpen:true,items:[{id:66,name:'Yew longbow',count:2,slot:7}]};
  const a=await e.next(s,route);expect(a?.type).toBe('bankWithdraw');expect(a?.fields?.amount).toBe(1);expect(e.memory.overview.capital.targetCoins).toBeNull();
}));
test('a finished batch input commitment suppresses a premature shop detour',async()=>withPlanner(async(p,dir)=>{
  const e=new EquipmentGoals(join(dir,'economy.json'),{namespace:'test',items:[],shops:[],evidence:[]},'economy',false,()=>100_000);
  e.setWorkIntent({track:'woodworking',outputId:66,allowLiquidation:false});const s=state(5000);s.bank={isOpen:true,items:[{id:66,name:'Yew longbow',count:20,slot:7}]};expect(await e.next(s,route)).toBeUndefined();
}));
test('maxed woodcutting continues to value a carried axe upgrade for a wood task',async()=>withPlanner(async(p,dir)=>{
  const c=loadGearCatalog(),e=new EquipmentGoals(join(dir,'economy.json'),c,'economy',false,()=>100_000),s=state(5000);
  s.skills.push({name:'Woodcutting',baseLevel:99},{name:'Fletching',baseLevel:99},{name:'Mining',baseLevel:1});
  s.bank={isOpen:true,items:[{id:1359,name:'Rune axe',count:1,slot:7}]};e.setWorkIntent({track:'woodworking'});expect(e.plan(s).target).toBe('Rune axe');
}));
