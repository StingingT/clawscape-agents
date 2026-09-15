import type { Action } from './progression-policy';

export type FishingPreparation = { bankVisit?: boolean; quote?: number; retryAt?: number; blocker?: string };
type Result = { status: 'ready' | 'deferred' | 'action'; actions: Action[] };
const count=(items:any[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+Number(i.count),0);
const act=(id:string,type:string,fields:any={}):Result=>({status:'action',actions:[{id:'lobster-'+id,type,fields,waitTicks:2}]});
const defer=(m:FishingPreparation,reason:string):Result=>{m.blocker=reason;return {status:'deferred',actions:[]};};

// Preparation is a transaction with a recoverable blocker, not repeated
// shop visits. A banked tool is used before buying a duplicate.
export function lobsterPreparation(s:any,m:FishingPreparation,bankMemory:any[],goBank:()=>Action[],now=Date.now()):Result {
  const inv=s.inventory??[],bank=s.bank?.isOpen?s.bank.items??[]:bankMemory;
  const hasPot=count(inv,301)>0,storedPot=bank.find(i=>i.id===301&&i.count>0);
  const coins=count(inv,995),bankCash=count(bank,995);
  const fare=60; // Retain both the outbound and return fare.
  const required=fare+(hasPot||storedPot?0:m.quote??20);
  if(s.bank?.isOpen){
    if(!hasPot&&storedPot&&inv.length<28)return act('withdraw-owned-pot','bankWithdraw',{slot:storedPot.slot,amount:1});
    const cash=bank.find((i:any)=>i.id===995&&i.count>0);
    if(coins<required&&cash&&(inv.length<28||coins>0))return act('withdraw-trip-funds','bankWithdraw',{slot:cash.slot,amount:Math.min(required-coins,cash.count)});
    m.bankVisit=false;
    if(coins<required)m.blocker=`Lobster trip needs ${required-coins} more coins; continue other progression until funded`;
    return act('close-preparation-bank','closeModal');
  }
  if(!hasPot&&storedPot){
    m.bankVisit=true;
    if(s.shop?.isOpen)return act('close-shop-use-owned-pot','closeModal');
    return {status:'action',actions:goBank()};
  }
  if(coins<required){
    if(s.shop?.isOpen)return act('close-unaffordable-shop','closeModal');
    if(bankCash>0){m.bankVisit=true;return {status:'action',actions:goBank()};}
    return defer(m,`Lobster trip needs ${required-coins} more coins; bank has no known cash. Continue gear/training goals`);
  }
  if(!hasPot){
    if((m.retryAt??0)>now)return defer(m,'Fishing-shop stock unavailable; retry after cooldown');
    if(s.shop?.isOpen){
      const pot=s.shop.shopItems?.find((i:any)=>i.id===301&&i.count>0&&i.buyPrice>0);
      if(!pot){m.retryAt=now+300_000;return act('close-empty-shop','closeModal');}
      m.quote=pot.buyPrice;
      if(coins<pot.buyPrice+fare)return act('close-unaffordable-shop','closeModal');
      if(inv.length>=28){m.bankVisit=true;return act('close-full-inventory','closeModal');}
      return act('buy-pot','shopBuy',{slot:pot.slot,amount:1,itemId:pot.id,expectedPrice:pot.buyPrice});
    }
    const g=s.nearbyNpcs?.find((n:any)=>/^gerrant$/i.test(n.name)&&n.reachable===true);
    const trade=g?.optionsWithIndex?.find((o:any)=>/^trade$/i.test(o.text));
    if(g&&trade)return act('trade-gerrant','interactNpc',{npcIndex:g.index,optionIndex:trade.opIndex});
    return act('travel-gerrant','walkTo',{x:3014,z:3224,level:0});
  }
  if(s.shop?.isOpen)return act('close-equipped-shop','closeModal');
  delete m.blocker;return {status:'ready',actions:[]};
}

export function validateFishing(s:any,a:Action,before:any):boolean {
  if(!a.id.startsWith('lobster-'))return true;
  if(a.type==='bankWithdraw'){
    const intended=(a as any).itemRefs?.find((r:any)=>r.field==='slot'&&r.container==='bank')??before.bank?.items?.find((i:any)=>i.slot===a.fields?.slot);
    return !!intended&&s.bank?.isOpen===true&&s.bank.items?.some((i:any)=>i.slot===a.fields?.slot&&i.id===intended.id&&i.count>=a.fields.amount);
  }
  if(a.type==='shopBuy')return s.shop?.isOpen===true&&s.shop.shopItems?.some((i:any)=>i.slot===a.fields.slot&&i.id===301&&i.count>0&&i.buyPrice===a.fields.expectedPrice)&&count(s.inventory??[],995)>=a.fields.expectedPrice+60;
  return true;
}
