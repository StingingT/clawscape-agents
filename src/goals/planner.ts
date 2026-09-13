import { existsSync, readFileSync } from 'node:fs';
import { skillLevel, type Action } from '../progression-policy';
import { isFood, itemTotal } from '../runtime-policy';
import type { Gear, GearCatalog, Method, Shop } from './catalog';
import { saveGoalJson } from './persistence';

type State = any;
export type RouteChoice = { item: Gear; method: Method; seconds: number | null; cashNeeded: number; blockers: string[]; estimated: boolean };
type Goal = { item: number; method: string; started: number; lastProgress: number; phase: string; reason: string; attempts: number; pausedAt?: number; suspendedReason?: string };
export type GoalMemory = { version: 1; namespace: string; active?: Goal; bank: any[]; bankCheckedAt: number;
  cooldowns: Record<string, number>; prices: Record<string, number>; samples: Record<string, { count: number; seconds: number }>;
  completed: { item: number; name: string; method: string; at: number }[]; uncertain?: { method: string; reason: string };
  overview?: any; lastAttempt?: { signature: string; repeats: number }; auditBlockedUntil?: number;
  supportBlocked?: { until: number; reason: string }; blockedReasons?: Record<string,string> };
const dist=(s:State,p:{x:number;z:number})=>Math.max(Math.abs(Number(s.player?.worldX)-p.x),Math.abs(Number(s.player?.worldZ)-p.z));
const funds=(items:any[])=>items.filter(i=>/^coins$/i.test(i.name)).reduce((n,i)=>n+Number(i.count),0);
const norm=(s:string)=>s.toLowerCase().replace(/[^a-z]/g,'');
const qty=(s:State,id:number)=>itemTotal([...(s.inventory??[]),...(s.equipment??[])],id);
const protectedItem=(i:any)=>isFood(i)||/axe|pickaxe|knife|hammer|needle|thread|talisman|rune|bow|arrow|sword|scimitar|shield|net|tinderbox/i.test(i.name);

export function usable(g:Gear,s:State):boolean { return g.requires.every(r=>skillLevel(s,r.skill)>=r.level); }
export function recipeReady(m:Method,s:State,bank:any[]=[]):string[] {
  const missing:string[]=[];
  if(m.skill&&skillLevel(s,m.skill)<(m.level??1))missing.push(`${m.skill} ${m.level} (now ${skillLevel(s,m.skill)})`);
  for(const i of m.inputs??[])if(qty(s,i.id)+itemTotal(bank,i.id)<i.count)missing.push(`${i.count} ${i.name}`);
  return missing;
}
export function compareMethods(item:Gear,s:State,m:GoalMemory,now=Date.now()):RouteChoice[] {
  return item.methods.map(method=>{
    const blockers:string[]=[], totalCash=funds(s.inventory??[])+funds(m.bank);
    if(method.blocker)blockers.push(method.blocker);
    if((m.cooldowns[method.id]??0)>now)blockers.push('Temporary failure cooldown');
    if(m.uncertain?.method===method.id)blockers.push('Uncertain previous transaction; inspect before retry');
    let seconds:number|null=null,cashNeeded=0;
    if(method.kind==='buy') {
      cashNeeded=m.prices[method.id]??method.priceHint??Infinity;
      if(!Number.isFinite(cashNeeded))blockers.push('Unknown price');
      // These are explicitly estimates, not measured income/XP rates. Ready
      // coins have no invented earning time; an unfunded route stays unknown.
      seconds=method.shop ? 20+dist(s,method.shop)*.7 : 20;
      if(cashNeeded+cashReserve(totalCash)>totalCash) { blockers.push('Earn or withdraw the purchase budget'); seconds=null; }
    } else if(method.kind==='craft') {
      blockers.push(...recipeReady(method,s,m.bank));
      seconds=blockers.length?null:method.recipe==='smith'?60:15;
    } else { seconds=null; }
    const sample=m.samples[method.id];
    if(sample&&seconds!==null)seconds=Math.max(seconds,sample.seconds/sample.count);
    return {item,method,seconds,cashNeeded,blockers,estimated:!sample};
  });
}
// Preserve a modest food/ammo reserve without making a 16gp starter tool
// unobtainable for a 33gp character. This is a budget policy, not a shop price.
export const cashReserve=(wealth:number)=>Math.min(100,Math.max(5,Math.floor(wealth*.15)));
export function selectUpgrade(choices:RouteChoice[],owned:Map<string,number>,stepwiseFamily?:Gear['family']):RouteChoice|undefined {
  const practical=choices.filter(c=>c.blockers.length===0&&c.seconds!==null&&c.seconds<=15*60);
  // Brawlers climb through affordable tiers instead of jumping directly to a
  // long-term Rune target.
  if(stepwiseFamily){
    const next=practical.filter(c=>c.item.family===stepwiseFamily)
      .sort((a,b)=>a.item.quality-b.item.quality||a.seconds!-b.seconds!)[0];
    if(next)return next;
  }
  // Within a two-minute detour of the quickest option, skip intermediate tiers
  // and take the strongest useful upgrade. Otherwise compare gain/time.
  const best=practical.sort((a,b)=>(b.item.quality-(owned.get(b.item.family)??0))/(b.seconds!+60)-(a.item.quality-(owned.get(a.item.family)??0))/(a.seconds!+60))[0];
  if(best)return practical.filter(c=>c.item.family===best.item.family&&c.seconds!<=best.seconds!+120)
    .sort((a,b)=>b.item.quality-a.item.quality||a.seconds!-b.seconds!)[0];
  // A funding goal is useful only for an executable, supported shop route.
  const funding=choices.filter(c=>c.method.kind==='buy'&&c.blockers.every(b=>b==='Earn or withdraw the purchase budget'))
    .sort((a,b)=>a.cashNeeded-b.cashNeeded || b.item.quality-a.item.quality);
  const cheapest=funding[0];
  // A small explicit funding window avoids a trip for every tiny tier. This
  // 200gp window is a policy budget, NOT a claimed earning-time measurement.
  return cheapest?funding.filter(c=>c.item.family===cheapest.item.family&&c.cashNeeded<=cheapest.cashNeeded+200)
    .sort((a,b)=>b.item.quality-a.item.quality||a.cashNeeded-b.cashNeeded)[0]:undefined;
}

export class EquipmentGoals {
  private workIntent:{track:'woodworking'|'metalworking';outputId?:number;reserve?:Record<number,number>;prices?:Record<number,{price:number;at:number}>;allowLiquidation?:boolean}|undefined;
  setWorkIntent(intent:typeof this.workIntent){this.workIntent=intent;}
  memory:GoalMemory;
  private catalog:GearCatalog;
  constructor(private file:string,catalog:GearCatalog,private role:string,private ranged:boolean,private now=()=>Date.now()) {
    this.catalog=catalog;
    let old:any;try {if(existsSync(file))old=JSON.parse(readFileSync(file,'utf8'));}catch{}
    this.memory=old?.version===1&&old.namespace===catalog.namespace?old:{version:1,namespace:catalog.namespace,bank:[],bankCheckedAt:0,cooldowns:{},prices:{},samples:{},completed:[]};
  }
  save(){saveGoalJson(this.file,this.memory);}
  seedBank(items:any[]){if(!this.memory.bankCheckedAt&&!this.memory.bank.length)this.memory.bank=items;}
  private families(s:State){return this.role==='defender'?['melee','shield','body'].filter(f=>!this.catalog.items.some(g=>g.family===f&&usable(g,s)&&qty(s,g.id)>0)):this.role==='economy'?(this.workIntent?.track==='metalworking'?['axe','pickaxe']:['axe']):this.ranged?['bow','legs','hands']:['melee'];}
  private item(){return this.catalog.items.find(i=>i.id===this.memory.active?.item);}
  private method(){return this.item()?.methods.find(m=>m.id===this.memory.active?.method);}
  crafting(){return this.memory.active?.phase==='craft';}
  interrupt(reason:string){const a=this.memory.active;if(a){a.pausedAt??=this.now();a.suspendedReason=reason;this.save();}}
  private action(id:string,type:string,fields:any={},waitTicks=2):Action {
    return {id:'goal-'+id,type,fields:{...fields,goalMethod:this.memory.active?.method??'bank-audit'},waitTicks};
  }
  private finish(s:State) {
    const g=this.item(),a=this.memory.active;
    if(!g||!a)return;
    if(g.tool?qty(s,g.id)>0:itemTotal(s.equipment??[],g.id)>0) {
      this.memory.completed.push({item:g.id,name:g.name,method:a.method,at:this.now()});this.memory.completed=this.memory.completed.slice(-100);
      const sample=this.memory.samples[a.method]??={count:0,seconds:0};sample.count++;sample.seconds+=(this.now()-a.started)/1000;
      delete this.memory.active; delete this.memory.lastAttempt;
    }
  }
  plan(s:State) {
    if(s.bank?.isOpen) {this.memory.bank=s.bank.items??[];this.memory.bankCheckedAt=this.now();}
    this.finish(s);
    const hasTieredMeleeKit=[...(s.equipment??[]),...(s.inventory??[])].some((i:any)=>/bronze|iron|steel|black|mithril|adamant|rune|wooden shield/i.test(String(i.name)));
    const stepwiseFamily=this.role==='brawler'&&!this.ranged&&hasTieredMeleeKit?'melee':undefined;
    // Migrate the old direct-Rune milestone into the normal equipment planner.
    if(this.memory.active?.method==='milestone:rune-scimitar')delete this.memory.active;
    if(stepwiseFamily&&this.memory.active){
      const equippedQuality=Math.max(0,...this.catalog.items.filter(i=>i.family===stepwiseFamily&&itemTotal(s.equipment??[],i.id)>0).map(i=>i.quality));
      const heldQuality=Math.max(0,...this.catalog.items.filter(i=>i.family===stepwiseFamily&&itemTotal([...(s.inventory??[]),...(s.equipment??[])],i.id)>0).map(i=>i.quality));
      const activeItem=this.item();
      if(activeItem&&activeItem.family===stepwiseFamily&&(activeItem.quality<=equippedQuality||activeItem.quality<heldQuality))delete this.memory.active;
    }
    // A live stocked shop can supply an item absent from its historical stock.
    // This authorizes a purchase here only; no imaginary merchant/travel route.
    if(s.shop?.isOpen)for(const stock of s.shop.shopItems??[]) {
      const item=this.catalog.items.find(i=>i.id===stock.id);
      if(!item||!(stock.count>0)||!(stock.buyPrice>0)||!Number.isFinite(stock.buyPrice))continue;
      const key='observed-buy:'+stock.id;
      if(!item.methods.some(m=>m.id===key))item.methods.push({id:key,kind:'buy',priceHint:stock.buyPrice,source:'live shop observation',
        shop:{id:key,name:'Observed open shop',npc:'(?!)',x:s.player.worldX,z:s.player.worldZ,level:s.player.level,enabled:true,source:'live shop observation'}});
      this.memory.prices[key]=stock.buyPrice;
    }
    const families=this.families(s), owned=new Map<string,number>();
    for(const i of this.catalog.items)if(usable(i,s)&&qty(s,i.id)>0)owned.set(i.family,Math.max(owned.get(i.family)??0,i.quality));
    const options=this.catalog.items.filter(i=>families.includes(i.family)&&usable(i,s)&&i.quality>(owned.get(i.family)??0));
    const choices=options.flatMap(i=>compareMethods(i,s,this.memory,this.now()));
    const active=this.memory.active;
    if(active) {
      const item=this.item(),method=this.method();
      const current=choices.find(c=>c.method.id===active.method);
      // Persist the goal through safety, supply and funding interruptions. A
      // newly acquired higher-tier item can make the old goal obsolete.
      const possessionRoute=/^(owned|bank):/.test(active.method);
      if(!item||!families.includes(item.family)||!method&&!possessionRoute||!usable(item,s)||item.quality<(owned.get(item.family)??0)||
        (this.memory.cooldowns[active.method]??0)>this.now()||this.memory.uncertain?.method===active.method)delete this.memory.active;
      else if(qty(s,item.id)===0&&current?.blockers.some(b=>b!=='Earn or withdraw the purchase budget'))delete this.memory.active;
      else if(current&&qty(s,item.id)===0&&this.now()-active.started>30_000) {
        const better=selectUpgrade(choices.filter(c=>c.item.family===item.family),owned);
        if(better&&better.item.quality>item.quality*1.2&&better.blockers.length===0&&better.seconds!==null&&better.seconds<=(current.seconds??900)+120)delete this.memory.active;
      }
    }
    if(!this.memory.active) {
      // Bank and carried upgrades beat buying duplicates. Carried equipment is
      // unfinished until it is observed equipped; tools need only be carried.
      const held=this.catalog.items.filter(i=>families.includes(i.family)&&usable(i,s)&&qty(s,i.id)>0&&!i.tool&&itemTotal(s.equipment??[],i.id)===0)
        .filter(i=>i.quality>Math.max(0,...this.catalog.items.filter(g=>g.family===i.family&&itemTotal(s.equipment??[],g.id)>0).map(g=>g.quality)))
        .sort((a,b)=>b.quality-a.quality)[0];
      const stored=options.filter(i=>itemTotal(this.memory.bank,i.id)>0).sort((a,b)=>b.quality-a.quality)[0];
      const choice=selectUpgrade(choices,owned,stepwiseFamily),item=held??stored??choice?.item;
      if(item) this.memory.active={item:item.id,method:held?'owned:'+item.id:stored?'bank:'+item.id:choice!.method.id,
        started:this.now(),lastProgress:this.now(),phase:'plan',reason:'',attempts:0};
    }
    const target=this.item();
    this.memory.overview={updatedAt:new Date(this.now()).toISOString(),target:target?.name??null,goal:this.memory.active,
      longTerm:this.catalog.items.filter(i=>families.includes(i.family)&&usable(i,s)).sort((a,b)=>b.quality-a.quality).slice(0,4).map(i=>({name:i.name,family:i.family,requires:i.requires})),
      alternatives:choices.map(c=>({item:c.item.name,method:c.method.id,kind:c.method.kind,seconds:c.seconds,estimated:c.estimated,cashNeeded:Number.isFinite(c.cashNeeded)?c.cashNeeded:null,blockers:c.blockers,prerequisites:c.method.prerequisites,source:c.method.source})),
      cash:{carried:funds(s.inventory??[]),banked:funds(this.memory.bank),bankObservedAt:this.memory.bankCheckedAt||null},
      capital:this.role==='economy'?{targetCoins:this.workIntent?null:2000,observedCoins:funds(s.inventory??[])+funds(this.memory.bank),
        complete:this.workIntent?this.workIntent.allowLiquidation===false||![...(s.inventory??[]),...this.memory.bank].some(i=>([48,50,54,56,58,60,62,64,66,68,70,72].includes(i.id)||i.id===this.workIntent!.outputId)&&i.count>(this.workIntent!.reserve?.[i.id]??0)):funds(s.inventory??[])+funds(this.memory.bank)>=2000,
        reason:this.workIntent?'Sell useful surplus to grow net wealth; retain materials assigned to a verified goal':'Turn banked products into a liquid upgrade reserve before another production batch'}:undefined,
      status:target?'working':'deferred-or-current-kit-sufficient',note:'Unknown effort is not zero. Unsupported mining/training/tanning/dragon trips remain prerequisites, not dispatched actions.'};
    this.save();return this.memory.overview;
  }
  private bank(s:State):Action {
    const booth=s.nearbyLocs?.filter((l:any)=>/bank booth|bank chest/i.test(l.name)&&l.reachable&&l.optionsWithIndex?.some((o:any)=>/^use-quickly$|^bank$/i.test(o.text)))
      .sort((a:any,b:any)=>a.distance-b.distance)[0];
    if(booth)return this.action('open-bank','interactLoc',{x:booth.x,z:booth.z,locId:booth.id,optionIndex:booth.optionsWithIndex.find((o:any)=>/^use-quickly$|^bank$/i.test(o.text)).opIndex});
    const banks=[{x:3185,z:3436,level:0},{x:3094,z:3491,level:0}].sort((a,b)=>dist(s,a)-dist(s,b));
    return this.action('bank-route','walkTo',banks[0]);
  }
  private shop(s:State,shop:Shop):Action {
    const npc=s.nearbyNpcs?.filter((n:any)=>new RegExp('^('+shop.npc+')$','i').test(n.name)&&n.reachable&&Math.max(Math.abs(n.x-shop.x),Math.abs(n.z-shop.z))<=8)
      .sort((a:any,b:any)=>a.distance-b.distance).find((n:any)=>n.optionsWithIndex?.some((o:any)=>/^trade$/i.test(o.text)));
    if(npc)return this.action('trade-'+shop.id,'interactNpc',{npcIndex:npc.index,optionIndex:npc.optionsWithIndex.find((o:any)=>/^trade$/i.test(o.text)).opIndex});
    return this.action('shop-route-'+shop.id,'walkTo',{x:shop.x,z:shop.z,level:shop.level,reason:'Find and verify '+shop.name});
  }
  async next(s:State,assess:(from:any,to:any)=>Promise<any>):Promise<Action|undefined> {
    this.plan(s);
    const g=this.item(),a=this.memory.active,m=this.method();
    if(a?.method==='milestone:rune-scimitar'){
      a.phase='milestone';a.reason='Rune scimitar target: build capital or Smithing/quest prerequisites; skip intermediate weapon purchases';this.save();return;
    }
    if(this.memory.supportBlocked&&this.memory.supportBlocked.until>this.now()) {
      if(a){a.phase='waiting-prerequisite';a.reason=this.memory.supportBlocked.reason;}
      this.save();return;
    }
    if(a?.pausedAt!==undefined){a.lastProgress+=this.now()-a.pausedAt;delete a.pausedAt;delete a.suspendedReason;}
    if(a&&a.phase!=='plan'&&this.now()-a.lastProgress>180_000){this.defer('No verified goal progress for three minutes');return;}
    if(!g||!a) {
      if(this.role!=='economy')return;
      const capital=this.capital(s);this.save();
      if(capital?.type==='walkTo') {
        const to=capital.fields!,checked=await assess({x:s.player.worldX,z:s.player.worldZ,level:s.player.level},{x:to.x,z:to.z,level:to.level??0});
        if(checked.status!=='ready')return;
      }
      return capital;
    }
    const inv=s.inventory??[];
    const held=inv.find((i:any)=>i.id===g.id), equipped=itemTotal(s.equipment??[],g.id)>0;
    let action:Action|undefined;
    if(held&&!equipped&&!g.tool) {
      if(s.bank?.isOpen||s.shop?.isOpen)action=this.action('close-to-equip','closeModal');
      else {const op=held.optionsWithIndex?.find((o:any)=>/^wield$|^wear$/i.test(o.text));if(op)action=this.action('equip-'+g.id,'useInventoryItem',{slot:held.slot,optionIndex:op.opIndex,expectedItemId:g.id});}
      a.phase='equip';a.reason='Verify the actual equipped item, not dispatch success';
    } else if(!this.memory.bankCheckedAt&&(this.memory.auditBlockedUntil??0)<=this.now()&&!s.shop?.isOpen) {
      a.phase='bank-audit';a.reason='Inspect owned gear, ingredients and funds before buying duplicates';action=this.bank(s);
    } else if(s.bank?.isOpen) {
      const stored=s.bank.items.find((i:any)=>i.id===g.id);
      const missing=m?.inputs?.find(i=>qty(s,i.id)<i.count&&itemTotal(s.bank.items,i.id)>0);
      const cash=s.bank.items.find((i:any)=>/^coins$/i.test(i.name));
      const budget=(this.memory.prices[a.method]??m?.priceHint??0)+cashReserve(funds(inv)+funds(s.bank.items));
      if(inv.length>=28) { const spare=inv.find((i:any)=>!protectedItem(i)&&!/^coins$/i.test(i.name));if(spare)action=this.action('deposit-space','bankDeposit',{slot:spare.slot,amount:spare.count}); }
      else if(stored)action=this.action('withdraw-kit','bankWithdraw',{slot:stored.slot,amount:1,expectedItemId:stored.id});
      else if(missing)action=this.action('withdraw-input','bankWithdraw',{slot:s.bank.items.find((i:any)=>i.id===missing.id).slot,amount:Math.min(missing.count-qty(s,missing.id),itemTotal(s.bank.items,missing.id)),expectedItemId:missing.id});
      else if(cash&&funds(inv)<budget)action=this.action('withdraw-fund','bankWithdraw',{slot:cash.slot,amount:Math.min(cash.count,Math.ceil(budget-funds(inv))),expectedItemId:cash.id});
      else action=this.action('close-bank','closeModal');
      a.phase='bank-withdrawal';a.reason='Use existing possessions before earning or crafting more';
    } else if(a.method.startsWith('bank:'))action=this.bank(s);
    else if(m?.kind==='buy') {
      const budget=this.memory.prices[m.id]??m.priceHint??Infinity;
      if(s.shop?.isOpen) {
        const stock=s.shop.shopItems?.find((i:any)=>i.id===g.id&&i.count>0&&Number.isFinite(i.buyPrice)&&i.buyPrice>0);
        if(stock) {
          this.memory.prices[m.id]=stock.buyPrice;
          if(stock.buyPrice<=funds(inv)-cashReserve(funds(inv)))action=this.action('buy-'+g.id,'shopBuy',{slot:stock.slot,amount:1,itemId:g.id,expectedPrice:stock.buyPrice});
          else action=this.action('close-to-fund','closeModal');
        } else if(a.phase==='funding')action=this.funding(s,budget);
        else {this.defer('Shop has no observed affordable target stock');action=this.action('close-unavailable-shop','closeModal');}
      } else if(funds(inv)<budget+cashReserve(funds(inv))) {
        a.phase='funding';a.reason=`Build ${budget} gp plus supply reserve for ${g.name}`;
        action=funds(this.memory.bank)>0&&this.now()-this.memory.bankCheckedAt<600_000?this.bank(s):this.funding(s,budget);
      } else {a.phase='shopping';a.reason='Buy using current stock and price, not the guide price';action=this.shop(s,m.shop!);}
    } else if(m?.kind==='craft') {
      const missing=recipeReady(m,s);
      a.phase='craft';a.reason='Use owned materials; verify finished item and skill XP';
      if(missing.length)action=this.bank(s);
      else if(s.dialog?.isOpen) {
        const label=s.dialog.options?.find((o:any)=>norm(o.text).includes(norm(g.name))&&Number.isInteger(o.index));
        if(label)action=this.action('craft-product','clickDialogOption',{optionIndex:label.index});
        else {this.defer('Recipe interface lacks an observed product option');action=this.action('close-unknown-recipe','closeModal');}
      } else if(m.recipe==='smith') {
        const anvil=s.nearbyLocs?.find((l:any)=>/^anvil$/i.test(l.name)&&(l.reachable||l.distance<=2));
        action=anvil?this.action('smith-input','useItemOnLoc',{itemSlot:inv.find((i:any)=>i.id===m.inputs![0]!.id).slot,x:anvil.x,z:anvil.z,locId:anvil.id})
          :this.action('anvil-route','walkTo',{x:3187,z:3425,level:0});
      } else {
        const first=m.recipe==='leather'?m.inputs![1]!:m.inputs![0]!,second=m.recipe==='leather'?m.inputs![0]!:m.inputs![1]!;
        action=this.action('craft-input','useItemOnItem',{sourceSlot:inv.find((i:any)=>i.id===first.id).slot,targetSlot:inv.find((i:any)=>i.id===second.id).slot});
      }
    }
    if(action?.type==='walkTo') {
      const dest=action.fields!,check=await assess({x:s.player.worldX,z:s.player.worldZ,level:s.player.level},{x:dest.x,z:dest.z,level:dest.level??0});
      if(check.status==='loading-map')return this.action('map-loading','wait',{},2);
      if(check.status!=='ready') {this.routeBlocked(a,'Route blocked: '+check.reason);return;}
      // At the hint but no service was found: bounded discovery, never arrival=success.
      if(dist(s,{x:dest.x,z:dest.z})===0) {this.routeBlocked(a,'Arrived at hint but service was not observed');return;}
    }
    if(action)a.attempts++;
    this.save();return action;
  }
  private capital(s:State):Action|undefined {
    if(this.workIntent?.allowLiquidation===false)return;
    const inv=s.inventory??[], wealth=funds(inv)+funds(this.memory.bank), target=2000;
    if(this.memory.overview)this.memory.overview.capital={targetCoins:target,observedCoins:wealth,complete:wealth>=target,
      reason:'Convert banked production into a modest liquid upgrade reserve; this is a budget milestone, not an assumed item price'};
    if(wealth>=target&&!this.workIntent||this.memory.uncertain||(this.memory.cooldowns['capital']??0)>this.now())return;
    const reserve=(id:number)=>this.workIntent?.reserve?.[id]??0;
    const eligible=(i:any)=>[48,50,54,56,58,60,62,64,66,68,70,72].includes(i.id)||i.id===this.workIntent?.outputId;
    const sale=(i:any)=>eligible(i)&&itemTotal(inv,i.id)>reserve(i.id);
    const storedSale=(i:any)=>eligible(i)&&i.count>reserve(i.id);
    // Raw resources need a worthwhile batch, not one-log shop round trips.
    if(this.workIntent&&[1511,1515,1519,1521].includes(this.workIntent.outputId??0)&&!s.shop?.isOpen){
      const carried=itemTotal(inv,this.workIntent.outputId!);
      if(carried>0&&carried<16||carried===0&&!this.memory.bank.some(i=>storedSale(i)&&i.count>=16))return;
    }
    const estimate=(i:any)=>{const q=this.workIntent?.prices?.[i.id];return q&&this.now()-q.at<30*60_000?q.price:0;};
    if(this.workIntent&&this.memory.overview)this.memory.overview.capital={targetCoins:null,observedCoins:wealth,complete:!inv.some(sale)&&!this.memory.bank.some(storedSale),reason:'Sell surplus output for ongoing net wealth; no fixed wealth or skill-level finish line'};
    if(s.bank?.isOpen) {
      if(inv.some(sale))return this.action('capital-close-bank','closeModal');
      const stored=s.bank.items.filter(storedSale).sort((a:any,b:any)=>estimate(b)-estimate(a)||b.count-a.count)[0];
      if(stored&&inv.length<28)return this.action('capital-withdraw','bankWithdraw',{slot:stored.slot,amount:Math.min(20,28-inv.length,stored.count-reserve(stored.id)),expectedItemId:stored.id});
      return;
    }
    if(s.shop?.isOpen) {
      const item=inv.find(sale),offer=s.shop.playerItems?.find((i:any)=>i.id===item?.id&&i.sellPrice>0);
      if(item&&offer)return this.action('capital-sale','shopSell',{slot:item.slot,amount:1,itemId:item.id,expectedPrice:offer.sellPrice});
      return this.action('capital-close-shop','closeModal');
    }
    if(inv.some(sale))return this.shop(s,{id:'capital-general',name:'Varrock General Store',npc:'Shop keeper|Shop assistant',x:3218,z:3415,level:0,enabled:true,source:'wiki/shops/varrock-general-store.md'});
    if(this.memory.bank.some(storedSale)||!this.memory.bankCheckedAt)return this.bank(s);
    return;
  }
  validate(s:State,a:Action):boolean {
    if(!a.id.startsWith('goal-'))return true;
    if(a.type==='shopBuy') {
      const row=s.shop?.shopItems?.find((i:any)=>i.slot===a.fields?.slot&&i.id===a.fields?.itemId&&i.count>=a.fields?.amount);
      return s.shop?.isOpen===true&&!!row&&row.buyPrice===a.fields?.expectedPrice&&funds(s.inventory??[])>=row.buyPrice*a.fields!.amount+cashReserve(funds(s.inventory??[]));
    }
    if(a.type==='shopSell')return s.shop?.isOpen===true&&s.inventory?.some((i:any)=>i.slot===a.fields?.slot&&i.id===a.fields?.itemId&&i.count>=a.fields?.amount)&&
      s.shop.playerItems?.some((i:any)=>i.id===a.fields?.itemId&&i.sellPrice===a.fields?.expectedPrice&&i.sellPrice>0);
    if(a.fields?.expectedItemId!==undefined) {
      const source=a.type==='bankWithdraw'?s.bank?.items:s.inventory;
      return (a.type!=='bankWithdraw'||s.bank?.isOpen===true)&&source?.some((i:any)=>i.slot===a.fields?.slot&&i.id===a.fields?.expectedItemId);
    }
    return true;
  }
  private funding(s:State,budget:number):Action|undefined {
    const inv=s.inventory??[];
    const axe=[...inv,...(s.equipment??[])].find((i:any)=>/^(bronze|iron|steel|black|mithril|adamant|rune) axe$/i.test(i.name));
    const sale=(i:any)=>/^(logs|oak logs|willow logs|yew logs|cowhide)$/i.test(i.name)||[48,50,54,56,58,60,62,64,66,68,70,72].includes(i.id);
    if(s.shop?.isOpen) {
      if(!axe) {
        const quoted=s.shop.shopItems?.find((i:any)=>/^bronze axe$/i.test(i.name)&&i.count>0&&Number.isFinite(i.buyPrice)&&i.buyPrice>0);
        if(quoted)this.memory.prices['support:bronze-axe']=quoted.buyPrice;
        const tool=s.shop.shopItems?.find((i:any)=>/^bronze axe$/i.test(i.name)&&i.count>0&&Number.isFinite(i.buyPrice)&&i.buyPrice>0&&i.buyPrice<=funds(inv)-cashReserve(funds(inv)));
        if(tool)return this.action('buy-funding-axe','shopBuy',{slot:tool.slot,amount:1,itemId:tool.id,expectedPrice:tool.buyPrice});
      }
      const item=inv.find(sale),offer=s.shop.playerItems?.find((i:any)=>i.id===item?.id&&Number(i.sellPrice)>0);
      if(item&&offer)return this.action('sell-funding','shopSell',{slot:item.slot,amount:1,itemId:item.id,expectedPrice:offer.sellPrice});
      return this.action('close-funded-shop','closeModal');
    }
    const valueItems=inv.filter(sale);
    if(valueItems.length>=6||inv.length>=28&&valueItems.length) return this.shop(s,{id:'funding-general',name:'Varrock General Store',npc:'Shop keeper|Shop assistant',x:3218,z:3415,level:0,enabled:true,source:'wiki/shops/varrock-general-store.md'});
    const loot=s.groundItems?.filter((i:any)=>i.reachable&&i.distance<=5&&(/^coins$/i.test(i.name)||sale(i))).sort((a:any,b:any)=>a.distance-b.distance)[0];
    if(loot&&inv.length<28)return this.action('funding-loot','pickupItem',{x:loot.x,z:loot.z,itemId:loot.id});
    // For a small shortfall, a nearby known beginner pickpocket target can be
    // cheaper than a cross-world tool trip. Never do this without recovery food.
    const shortfall=budget+cashReserve(funds(inv))-funds(inv);
    if(this.ranged&&!axe&&shortfall>0&&shortfall<=50&&Number(s.player.hp)>=Number(s.player.maxHp)*.85&&inv.filter(isFood).length>=2) {
      const mark=s.nearbyNpcs?.find((n:any)=>/^(man|woman)$/i.test(n.name)&&n.reachable&&n.distance<=5&&n.optionsWithIndex?.some((o:any)=>/^pickpocket$/i.test(o.text)));
      if(mark)return this.action('funding-pickpocket','interactNpc',{npcIndex:mark.index,optionIndex:mark.optionsWithIndex.find((o:any)=>/^pickpocket$/i.test(o.text)).opIndex},4);
    }
    if(!axe&&funds(inv)>=(this.memory.prices['support:bronze-axe']??16)+cashReserve(funds(inv)))return this.shop(s,this.catalog.shops.find(p=>p.id==='bobs-brilliant-axes')!);
    if(axe&&inv.length<28) {
      const trees=s.nearbyLocs?.filter((l:any)=>(/^tree$/i.test(l.name)||/^oak$/i.test(l.name)&&skillLevel(s,'woodcutting')>=15)&&l.reachable&&l.distance<=16&&l.optionsWithIndex?.some((o:any)=>/^chop/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance);
      const tree=trees?.[0];
      if(tree)return Number(s.player?.animId)>=0?this.action('funding-harvest-wait','wait'):
        this.action('funding-chop','interactLoc',{x:tree.x,z:tree.z,locId:tree.id,optionIndex:tree.optionsWithIndex.find((o:any)=>/^chop/i.test(o.text)).opIndex},5);
      return this.action('funding-trees-route','walkTo',{x:3169,z:3420,level:0});
    }
    this.memory.active!.reason=`Funding blocked: ${budget} gp needed; obtain a gathering axe or verified loot/sale income first`;
    return; // Existing safe supply/training work may proceed; keep the goal visible.
  }
  private routeBlocked(a:Goal,reason:string) {
    if(['funding','bank-audit','bank-withdrawal'].includes(a.phase)) {
      this.memory.supportBlocked={until:this.now()+60_000,reason};
      a.phase='waiting-prerequisite';a.reason=reason;this.save();
    } else this.defer(reason);
  }
  defer(reason:string){const a=this.memory.active;if(a){this.memory.cooldowns[a.method]=this.now()+300_000;(this.memory.blockedReasons??={})[a.method]=reason;if(a.phase==='bank-audit')this.memory.auditBlockedUntil=this.now()+300_000;a.reason=reason;a.phase='blocked';}else this.memory.cooldowns['capital']=this.now()+300_000;this.save();}
  failed(action:Action,message:string){
    if(!action.id.startsWith('goal-'))return;
    if(/unavailable|timeout|timed out/i.test(message)&&['shopBuy','shopSell','bankDeposit','bankWithdraw','useItemOnItem','useItemOnLoc'].includes(action.type)) {
      this.memory.uncertain={method:String(action.fields?.goalMethod),reason:'Transaction outcome unknown; not automatically replayed'};
    }
    this.defer(message);
  }
  after(before:State,after:State,action:Action) {
    if(!action.id.startsWith('goal-'))return;
    let progress=before.player?.worldX!==after.player?.worldX||before.player?.worldZ!==after.player?.worldZ||
      JSON.stringify(before.inventory)!==JSON.stringify(after.inventory)||JSON.stringify(before.equipment)!==JSON.stringify(after.equipment)||
      before.bank?.isOpen!==after.bank?.isOpen||before.shop?.isOpen!==after.shop?.isOpen||JSON.stringify(before.dialog)!==JSON.stringify(after.dialog);
    if(action.type==='shopBuy')progress=qty(after,Number(action.fields?.itemId))>qty(before,Number(action.fields?.itemId))&&funds(after.inventory)<funds(before.inventory);
    if(action.type==='shopSell')progress=qty(after,Number(action.fields?.itemId))<qty(before,Number(action.fields?.itemId))&&funds(after.inventory)>funds(before.inventory);
    if(progress) {if(this.memory.active)this.memory.active.lastProgress=this.now();delete this.memory.lastAttempt;}
    else if(action.type!=='wait'&&!action.id.includes('funding-chop')) {
      const signature=action.id+':'+before.player?.worldX+':'+before.player?.worldZ;
      const repeats=this.memory.lastAttempt?.signature===signature?this.memory.lastAttempt.repeats+1:1;
      this.memory.lastAttempt={signature,repeats};if(repeats>=2)this.defer('Two attempts without the intended effect');
    }
    this.finish(after);this.save();
  }
}
