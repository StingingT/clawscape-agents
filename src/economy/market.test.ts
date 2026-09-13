import { test,expect } from 'bun:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bargain,marketMedian,peerDemand,PeerMarket,type Quote } from './market';
import { loadGearCatalog } from '../goals/catalog';
const catalog=loadGearCatalog();
const item=(id:number,name:string,count=1)=>({id,name,count,slot:0});
const state=(items:any[]=[])=>({tick:1,player:{worldX:3218,worldZ:3415,hp:20,maxHp:20,animId:-1,combat:{inCombat:false}},skills:[{name:'Ranged',baseLevel:64},{name:'Attack',baseLevel:40}],inventory:[item(995,'Coins',500),...items],equipment:[item(841,'Shortbow')],combatStyle:{weaponName:'Shortbow'},nearbyLocs:[]});
test('bargaining strictly benefits both parties and protects budget',()=>{
  expect(bargain({quantity:1,sellerOutside:40,sellerCost:30,buyerOutside:100,budget:90,handling:2})).toEqual({floor:43,ceiling:90,ask:90,counter:66,quantity:1});
  expect(bargain({quantity:1,sellerOutside:99,sellerCost:0,buyerOutside:100,budget:100,handling:2})).toBeNull();
  expect(bargain({quantity:100,sellerOutside:2,sellerCost:0,buyerOutside:4,budget:150,handling:2})).toBeNull();
  expect(bargain({quantity:1,sellerOutside:NaN,sellerCost:0,buyerOutside:100,budget:100,handling:2})).toBeNull();
});
test('a banked unstrung bow or shafts do not satisfy equipment/ammo demand',()=>{
  const d=peerDemand(state([item(68,'Yew shortbow'),item(52,'Arrow shaft',500)]),'stinger',catalog);
  expect(d.items.some(i=>i.id===857)).toBe(true);
  expect(d.items.filter(i=>i.quantity>1).map(i=>i.id).sort()).toEqual([882,884]);
  expect(d.budget).toBe(425);
  const equipped=state();equipped.equipment=[item(857,'Yew shortbow')];
  expect(peerDemand(equipped,'stinger',catalog).items.some(i=>i.id===843)).toBe(false);
});
test('self-trading, asks, stale prices and unverified sales cannot manufacture inflation',()=>{
  const q:Quote={item:1,price:30,at:100,kind:'external-sale',source:'test',verified:true,seller:'stinger',buyer:'coincrafter'};
  expect(marketMedian([q,q,q],1,200)).toBeNull();
  const external=[{...q,seller:'a',buyer:'b',price:10},{...q,seller:'c',buyer:'d',price:20},{...q,seller:'e',buyer:'f',price:90}];
  expect(marketMedian(external,1,200)).toBe(20);
  expect(marketMedian(external,1,31*60_000)).toBeNull();
  expect(marketMedian(external.map(q=>({...q,verified:false})),1,200)).toBeNull();
});
test('three independent owners negotiate without transferring items or spamming a request',()=>{
  const dir=mkdtempSync(join(tmpdir(),'clawscape-market-test-'));let now=1_000_000;
  const seller=new PeerMarket(join(dir,'test.sqlite'),'coincrafter',catalog,()=>now);
  const buyer=new PeerMarket(join(dir,'test.sqlite'),'stinger',catalog,()=>now);
  try{
    const s=state([item(843,'Oak shortbow')]);s.shop={isOpen:true,name:'General Store',shopItems:[{id:843,count:1,buyPrice:100}],playerItems:[{id:843,sellPrice:40}]} as any;
    seller.observe(s,[],now);buyer.observe(state(),[],now);seller.observe(s,[],now);
    buyer.observe(state(),[],now);seller.observe(s,[],now);
    const report=seller.overview();expect(report.transferEnabled).toBe(false);
    expect(report.deals).toHaveLength(1);expect(report.deals[0].stage).toBe('agreed-pending-safe-transfer');
    const first=buyer.next(state())!;expect(first.type).toBe('privateMessage');
    buyer.before(first);buyer.after({gameMessages:[{fromSelf:true,text:first.fields!.message}]},first);
    expect(buyer.next(state())).toBeUndefined();
    buyer.observe(state(),[],now);expect(buyer.overview().messages.filter((m:any)=>m.sender==='stinger'&&m.body.startsWith('Looking'))).toHaveLength(1);
    expect(buyer.overview().messages.some((m:any)=>m.status==='echo-verified')).toBe(true);
    now+=31*60_000;buyer.observe(state(),[],now);expect(buyer.overview().deals).toHaveLength(0);
  }finally{seller.close();buyer.close();rmSync(dir,{recursive:true,force:true});}
});
test('unknown prices do not become free inputs; stale bank supplies are not advertised',()=>{
  const dir=mkdtempSync(join(tmpdir(),'clawscape-market-test-')),now=3_000_000;
  const seller=new PeerMarket(join(dir,'test.sqlite'),'coincrafter',catalog,()=>now),buyer=new PeerMarket(join(dir,'test.sqlite'),'stinger',catalog,()=>now);
  try{seller.observe(state(),[item(843,'Oak shortbow')],1);buyer.observe(state(),[],now);seller.observe(state(),[],now);
    expect(seller.overview().deals).toHaveLength(0);expect(seller.overview().agents.find(a=>a.character==='coincrafter').bank).toEqual([]);
  }finally{seller.close();buyer.close();rmSync(dir,{recursive:true,force:true});}
});
