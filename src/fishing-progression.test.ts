import { test,expect } from 'bun:test';
import { lobsterPreparation,validateFishing,type FishingPreparation } from './fishing-progression';
const item=(id:number,name:string,count=1,slot=0)=>({id,name,count,slot});
const pot=item(301,'Lobster pot',1,13);
const bankRoute=()=>[{id:'lobster-bank',type:'walkTo',fields:{x:3185,z:3436,level:0},waitTicks:2}];
const state=():any=>({inventory:[item(995,'Coins',13)],bank:{isOpen:false,items:[]},shop:{isOpen:false,shopItems:[]},nearbyNpcs:[{index:430,name:'Gerrant',reachable:true,optionsWithIndex:[{text:'Trade',opIndex:3}]}]});

test('Gerrant loop recovers the banked pot, preserves it, and yields if the trip is unfunded',()=>{
  const s=state(),m:FishingPreparation={};s.shop.isOpen=true;
  expect(lobsterPreparation(s,m,[pot],bankRoute).actions[0]?.id).toBe('lobster-close-shop-use-owned-pot');
  s.shop.isOpen=false;
  expect(lobsterPreparation(s,m,[pot],bankRoute).actions[0]?.type).toBe('walkTo');expect(m.bankVisit).toBe(true);
  s.bank={isOpen:true,items:[pot]};
  expect(lobsterPreparation(s,m,[pot],bankRoute).actions[0]).toMatchObject({type:'bankWithdraw',fields:{slot:13,amount:1}});
  s.inventory.push(pot);s.bank.items=[];
  expect(lobsterPreparation(s,m,[],bankRoute).actions[0]?.type).toBe('closeModal');expect(m.bankVisit).toBe(false);
  s.bank.isOpen=false;
  for(let i=0;i<5;i++)expect(lobsterPreparation(s,m,[],bankRoute).status).toBe('deferred');
  expect(m.blocker).toContain('47 more coins');
});
test('an unaffordable pot does not reopen the same shop forever',()=>{
  const s=state(),m:FishingPreparation={};s.shop={isOpen:true,shopItems:[item(301,'Lobster pot')]};
  expect(lobsterPreparation(s,m,[],bankRoute).actions[0]?.type).toBe('closeModal');
  s.shop.isOpen=false;expect(lobsterPreparation(s,m,[],bankRoute).actions).toEqual([]);
});
test('funding withdraws only the missing pot and round-trip budget',()=>{
  const s=state(),m:FishingPreparation={bankVisit:true};s.bank={isOpen:true,items:[item(995,'Coins',1000,4)]};
  expect(lobsterPreparation(s,m,[],bankRoute).actions[0]).toMatchObject({type:'bankWithdraw',fields:{slot:4,amount:67}});
});
test('a changed live price is remembered and sends preparation back for funds',()=>{
  const s=state(),m:FishingPreparation={};s.inventory=[item(995,'Coins',80)];s.shop={isOpen:true,shopItems:[{...pot,buyPrice:35}]};
  expect(lobsterPreparation(s,m,[item(995,'Coins',100)],bankRoute).actions[0]?.type).toBe('closeModal');expect(m.quote).toBe(35);
  s.shop.isOpen=false;expect(lobsterPreparation(s,m,[item(995,'Coins',100)],bankRoute).actions[0]?.type).toBe('walkTo');
});
test('missing stock cools down the shopping attempt',()=>{
  const s=state(),m:FishingPreparation={};s.inventory=[item(995,'Coins',100)];s.shop.isOpen=true;
  expect(lobsterPreparation(s,m,[],bankRoute,1000).actions[0]?.type).toBe('closeModal');s.shop.isOpen=false;
  expect(lobsterPreparation(s,m,[],bankRoute,2000).status).toBe('deferred');
});
test('a tool purchase keeps both fares and validates the fresh price and slot',()=>{
  const s=state();s.inventory=[item(995,'Coins',100)];s.shop={isOpen:true,shopItems:[{...pot,buyPrice:20}]};
  const a=lobsterPreparation(s,{},[],bankRoute).actions[0]!;expect(a.type).toBe('shopBuy');expect(validateFishing(s,a,s)).toBe(true);
  s.shop.shopItems[0].buyPrice=25;expect(validateFishing(s,a,s)).toBe(false);
});
