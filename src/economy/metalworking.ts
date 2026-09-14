import { upstreamRoot } from '../runtime-paths.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mapEntries } from '../training/catalog';
import { bankAt, shopAt, skillLevel, isFletchedOutput, type Action, type EconomyMemory } from '../progression-policy';
import { TOOL_TIERS, bestToolTier, toolPlan, type ToolTier } from './tool-progression';
import {unsafeMiningNeighbour} from './defence';

export type MetalMemory = { phase?:'gather'|'smelt'|'smith'|'bank'; loading?:boolean; ore?:number; bar?:number; product?:string; productId?:number; toolTargetId?:number; smithBlockedUntil?:number; smeltBlockedUntil?:number; missing?:number; lastTick?:number; cooldownUntil?:number; servicePolls?:number; serviceTick?:number; bulkPickaxeAudit?:'pending'|'funded'|'complete' };
export const economyTrack=(_s:any,m?:EconomyMemory)=>m?.objectives?.intent?.track??'woodworking';
const total=(items:any[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+Number(i.count),0);
const pickLevels:Record<string,number>={bronze:1,iron:1,steel:6,mithril:21,adamant:31,rune:41};
export const canMine=(s:any)=>[...(s.inventory??[]),...(s.equipment??[])].some(i=>{
  const metal=/^(bronze|iron|steel|mithril|adamant|rune) pickaxe$/i.exec(i.name)?.[1]?.toLowerCase();
  return metal && skillLevel(s,'mining')>=pickLevels[metal]!;
});
// Source-derived ground-floor resource IDs/locations. All display as "Rocks";
// depleted rocks and arbitrary name matches must never be treated as ore.
let rockHints:any[]|undefined;
export function miningHints(){
  if(!rockHints){const map='m51_52';rockHints=mapEntries(readFileSync(resolve(upstreamRoot(),'server/content/maps/'+map+'.jm2'),'utf8'),map,'LOC')
    .filter(p=>p.level===0&&p.x>=3280&&p.x<=3292&&p.z>=3360&&p.z<=3372&&[2090,2091,2092,2093,2094,2095].includes(p.id));}
  return rockHints;
}
const miningRouteHints = [
  { ids:[2090,2091,2092,2093,2094,2095], x:3285, z:3365, map:'m51_52' },
  // Source ore cluster, with a walkable approach between (not on) the rocks.
  { ids:[2090,2091,2092,2093,2094,2095], x:3031, z:9825, map:'m47_153' },
  { ids:[2096,2097], x:3302, z:3317, map:'m51_51' },
  { ids:[2102,2103], x:3304, z:3305, map:'m51_51' },
  { ids:[2104,2105], x:3300, z:3318, map:'m51_51' },
  { ids:[2106,2107], x:3059, z:3885, map:'m47_60' },
] as const;
export function miningHintsFor(ids:number[]) {
  return miningRouteHints.flatMap(site => {
    if (!site.ids.some(id => ids.includes(id))) return [];
    const contents=readFileSync(resolve(upstreamRoot(),`server/content/maps/${site.map}.jm2`),'utf8');
    return mapEntries(contents,site.map,'LOC').filter(p=>p.level===0&&ids.includes(p.id));
  });
}
const inDwarvenMine=(s:any)=>Number(s.player?.level)===0&&s.player.worldX>=2944&&s.player.worldX<3072&&s.player.worldZ>=9792&&s.player.worldZ<9856;
export function miningRouteHint(ids:number[],s?:any) {
  return miningRouteHints.find(site=>site.ids.some(id=>ids.includes(id))&&(s?inDwarvenMine(s)===(site.map==='m47_153'):site.map!=='m47_153'));
}
const action=(id:string,type:string,fields:any={},waitTicks=2):Action=>({id:'economy-metal-'+id,type,fields,waitTicks});
const walk=(id:string,x:number,z:number)=>action(id,'walkTo',{x,z,level:0});
const close=()=>action('close','closeModal',{},1);
const product=(s:any,bar:number,preferred?:ToolTier)=>preferred&&preferred.barId===bar&&skillLevel(s,'smithing')>=preferred.smithing
  ?{name:preferred.axeName,id:preferred.axeId}
  :bar===2349
  ? skillLevel(s,'smithing')>=5?{name:'Bronze arrowheads',id:39}:{name:'Bronze dagger',id:1205}
  : skillLevel(s,'smithing')>=20?{name:'Iron arrowheads',id:40}:{name:'Iron dagger',id:1203};
const BAR_RECIPES:Record<number,{primary:number;secondary?:number;secondaryCount:number;level:number}>= {
  2349:{primary:436,secondary:438,secondaryCount:1,level:1},
  2351:{primary:440,secondaryCount:0,level:15},
  2353:{primary:440,secondary:453,secondaryCount:2,level:30},
  2359:{primary:447,secondary:453,secondaryCount:4,level:50},
  2361:{primary:449,secondary:453,secondaryCount:6,level:70},
  2363:{primary:451,secondary:453,secondaryCount:8,level:85},
};
const oreLocIds:Record<number,number[]>={436:[2090,2091],438:[2094,2095],440:[2092,2093],453:[2096,2097],447:[2102,2103],449:[2104,2105],451:[2106,2107]};
const oreLevels:Record<number,number>={436:1,438:1,440:15,453:30,447:55,449:70,451:85};

function leaveDwarvenMine(s:any):Action[] {
  // This ladder, not arbitrary nearby stairs, returns to the verified entrance.
  const exit=s.nearbyLocs?.find((l:any)=>l.id===1755&&l.x===3019&&l.z===9850&&l.reachable===true);
  const option=exit?.optionsWithIndex?.find((o:any)=>/^climb[- ]up$/i.test(o.text));
  if(option)return [action('dwarven-mine-exit','interactLoc',{x:exit.x,z:exit.z,locId:exit.id,optionIndex:option.opIndex},3)];
  // The ladder's own tile is blocked. Approach beside it before observing it.
  if(s.player.worldX!==3018||s.player.worldZ!==9850)return [walk('dwarven-mine-exit-approach',3018,9850)];
  return [action('scan-dwarven-mine-exit','scanNearbyLocs',{radius:16},3)];
}

export function metalDialog(s:any,m:EconomyMemory):Action|undefined {
  const mm=m.metal;if(mm?.phase!=='smith'||!mm.product||!s.dialog?.isOpen||s.dialog.isWaiting)return;
  const options=s.dialog.options??[];
  if(options.some((o:any)=>/continue|congratulations/i.test(o.text)))return;
  const norm=(x:string)=>x.toLowerCase().replace(/[^a-z]/g,'');
  const chosen=options.find((o:any)=>Number.isInteger(o.index)&&norm(o.text).includes(norm(mm.product!)));
  if(chosen)return action('smith-product','clickDialogOption',{optionIndex:chosen.index},5);
  mm.smithBlockedUntil=Date.now()+5*60_000;mm.phase='bank';m.reason='Smithing product not exposed by the observed interface; bank bars and continue safe smelting';return close();
}

// A bounded staged metal supply chain. The source-backed route hints are
// deliberately narrow: higher coal and rare-ore routes are only used when the
// matching map anchor and live mine option are both observed.
export function metalNext(s:any,m:EconomyMemory,blocked:(id:string)=>boolean=()=>false):Action[]{
  const mm=m.metal??={},inv=s.inventory??[],bank=s.bank?.isOpen?s.bank.items??[]:m.bankItems??[];
  const count=(id:number)=>total(inv,id),all=(id:number)=>count(id)+total(bank,id);
  // An unfunded optional shopping audit must not prevent work with an
  // already usable pickaxe. Reconsider upgrades when income is available.
  if(mm.bulkPickaxeAudit==='pending' && canMine(s) && all(995)===0) mm.bulkPickaxeAudit='complete';
  const intent=m.objectives?.intent;
  const stageTool=TOOL_TIERS.find(t=>t.axeId===intent?.outputId);
  const targetTool=TOOL_TIERS.find(t=>t.axeId===intent?.toolTargetId);
  const currentAxeTier=bestToolTier([...inv,...bank],'axe');
  const stageAxe=stageTool&&currentAxeTier<stageTool.tier?stageTool:undefined;
  const plan=toolPlan(s,bank);
  const carriedPickTier=bestToolTier([...(s.inventory??[]),...(s.equipment??[])],'pickaxe');
  const legacyBar=skillLevel(s,'mining')>=15&&skillLevel(s,'smithing')>=15?2351:2349;
  const requestedBar=stageTool?.barId??(intent?.inputId&&BAR_RECIPES[intent.inputId]?intent.inputId:legacyBar);
  const usableRecipe=(id:number)=>{const r=BAR_RECIPES[id]!;return skillLevel(s,'smithing')>=r.level&&skillLevel(s,'mining')>=Math.max(oreLevels[r.primary]!,r.secondary?oreLevels[r.secondary]!:1);};
  // A future equipment goal cannot skip ore/smelting prerequisites. Keep an
  // already loaded batch through level-ups and controller restarts.
  const loadedBar=mm.bar??(mm.ore===436?2349:undefined);
  const loadedRecipe=loadedBar&&BAR_RECIPES[loadedBar];
  let targetBar=loadedRecipe&&(count(loadedRecipe.primary)>0||count(loadedBar!)>0||loadedRecipe.secondary&&count(loadedRecipe.secondary)>0)
    ?loadedBar!:usableRecipe(requestedBar)?requestedBar:legacyBar;
  // If the coal route is temporarily unavailable, use the carried iron for
  // a feasible iron-smelting batch instead of repeatedly travelling to bank
  // and returning with the same unfinished steel requirement.
  if(targetBar===2353 && count(453)===0 && blocked('economy-metal-mine-route-m51_51') && usableRecipe(2351)) targetBar=2351;
  mm.bar=targetBar;
  const barRecipe=BAR_RECIPES[targetBar]!;
  mm.toolTargetId=targetTool?.axeId;
  const bankAction=()=>inDwarvenMine(s)?leaveDwarvenMine(s):bankAt(s,undefined,blocked,m.bankCooldowns??={});
  const service=(name:'furnace'|'anvil',x:number,z:number)=>{
    if(inDwarvenMine(s))return leaveDwarvenMine(s);
    if(Math.max(Math.abs(s.player.worldX-x),Math.abs(s.player.worldZ-z))===0){
      if(mm.serviceTick!==s.tick){mm.serviceTick=s.tick;mm.servicePolls=(mm.servicePolls??0)+1;}
      if((mm.servicePolls??0)>=3){mm[name==='furnace'?'smeltBlockedUntil':'smithBlockedUntil']=Date.now()+300_000;mm.phase='bank';mm.servicePolls=0;m.reason='Arrived at '+name+' hint but no usable service was observed; bank inputs and defer';return bankAction();}
      return [action('inspect-'+name,'wait',{},3)];
    }
    mm.servicePolls=0;return [walk(name,x,z)];
  };
  delete m.processing;delete m.product;delete m.harvest;delete m.selling;
  m.selectedSite=inDwarvenMine(s)?'dwarven-mine':'varrock-southeast-mine';m.goal='mining-smithing-supply-chain';
  m.reason=m.objectives?.intent?.reason??'Develop a useful mining/smithing supply chain; the task is selected by its outcome, not by maxing another skill.';
  if(targetBar!==requestedBar)m.reason='Gather copper and tin, then smelt bronze to unlock the next metal tier; retain the long-term tool goal.';
  const useful=(i:any)=>isFletchedOutput(i)||/^(.*logs|logs|.*ore|.*bar|.*arrowheads|.*dagger|.*axe|uncut .*)$/i.test(i.name);
  if(s.bank?.isOpen){
    m.bankItems=bank;
    // A requested bulk tool run is deliberately transactional: withdraw the
    // complete liquid balance once, visit Nurmof, then let the normal bank
    // policy secure whatever remains. This avoids repeatedly reopening the
    // bank with pocket change while still allowing the agent to test every
    // future pickaxe the shop exposes.
    if(mm.bulkPickaxeAudit==='funded')return [close()];
    if(mm.bulkPickaxeAudit==='pending'){
      const cash=bank.find((i:any)=>i.id===995&&Number(i.count)>0);
      if(cash)return [action('withdraw-all-pickaxe-funds','bankWithdraw',{slot:cash.slot,amount:Number(cash.count)})];
      mm.bulkPickaxeAudit='funded';return [close()];
    }
    const keepAxe=(i:any)=>TOOL_TIERS.some(t=>t.axeId===i.id);
    // Carry one mining tool: the best pickaxe currently in the inventory.
    // Older pickaxes are banked to keep the mining trip usable and the
    // inventory uncluttered; future upgrades can be withdrawn when needed.
    const carriedPickaxes=inv.filter((i:any)=>/pickaxe$/i.test(String(i.name)));
    const bestCarriedPickTier=Math.max(0,...carriedPickaxes.map((i:any)=>bestToolTier([i],'pickaxe')));
    const keepPickaxe=(i:any)=>/pickaxe$/i.test(String(i.name))&&bestToolTier([i],'pickaxe')===bestCarriedPickTier;
    const keep=(i:any)=>i.id===995||i.id===2347||keepPickaxe(i)||keepAxe(i)||i.optionsWithIndex?.some((o:any)=>/^eat$/i.test(o.text));
    const deposit=!mm.loading&&inv.find((i:any)=>!keep(i)&&(useful(i)||!keep(i)));
    if(deposit)return [action('deposit-'+deposit.id,'bankDeposit',{slot:deposit.slot,amount:count(deposit.id)})];
    const pick=plan?.desiredPickaxe;
    const bankPick=pick&&bank.find((i:any)=>i.id===pick.pickaxeId&&i.count>0);
    if(pick&&carriedPickTier<pick.tier&&bankPick&&inv.length<28)return [action('withdraw-pickaxe-upgrade','bankWithdraw',{slot:bankPick.slot,amount:1})];
    if(!canMine(s)){
      const tool=bank.find((i:any)=>canMine({...s,inventory:[i],equipment:[]}));
      if(tool&&inv.length<28)return [action('withdraw-pick','bankWithdraw',{slot:tool.slot,amount:1})];
    }
    if(!count(2347)){
      const hammer=bank.find((i:any)=>i.id===2347);if(hammer&&inv.length<28)return [action('withdraw-hammer','bankWithdraw',{slot:hammer.slot,amount:1})];
    }
    const coins=bank.find((i:any)=>i.id===995);
    // Tool upgrades are bought from the observed shop.  Keep enough cash on
    // hand for the next pickaxe, otherwise a character with a full bank will
    // repeatedly close/reopen the bank with only a few coins carried.
    const needsPickaxeCash=!!(pick&&carriedPickTier<pick.tier&&!bankPick);
    if(count(995)<700&&coins&&(!count(2347)||!canMine(s)||needsPickaxeCash))return [action('withdraw-tool-cash','bankWithdraw',{slot:coins.slot,amount:Math.min(700-count(995),coins.count)})];
    // Do not immediately redeposit the cash reserved for an observed pickaxe
    // purchase; doing so creates a withdraw/deposit loop at the bank.
    if(count(995)>250&&!needsPickaxeCash){const c=inv.find((i:any)=>i.id===995);return [action('secure-gold','bankDeposit',{slot:c.slot,amount:count(995)-250})];}
    if(!mm.loading){
      const bar=bank.find((i:any)=>i.id===targetBar&&i.count>0&&skillLevel(s,'smithing')>=barRecipe.level);
      if(bar&&(mm.smithBlockedUntil??0)<=Date.now()&&inv.length<28){mm.loading=true;mm.phase='smith';return [action('withdraw-bars','bankWithdraw',{slot:bar.slot,amount:Math.min(12,28-inv.length,bar.count)})];}
      if((mm.smeltBlockedUntil??0)<=Date.now()&&all(barRecipe.primary)>0&&(!barRecipe.secondary||all(barRecipe.secondary)>=(barRecipe.secondaryCount))&&28-inv.length>=2){mm.loading=true;mm.phase='smelt';mm.ore=barRecipe.primary;}
    }
    if(mm.loading&&mm.phase==='smelt'){
      // Load a bounded smelting batch one ingredient at a time. Never
      // redeposit the primary while fetching its required coal/tin partner.
      const batch=8, primaryNeed=batch, secondaryNeed=batch*barRecipe.secondaryCount;
      const id=count(barRecipe.primary)<primaryNeed?barRecipe.primary:barRecipe.secondary&&count(barRecipe.secondary)<secondaryNeed?barRecipe.secondary:undefined;
      const row=id===undefined?undefined:bank.find((i:any)=>i.id===id);
      if(row)return [action('withdraw-smelting-input','bankWithdraw',{slot:row.slot,amount:Math.min((id===barRecipe.primary?primaryNeed:secondaryNeed)-count(row.id),row.count,28-inv.length)})];
    }
    if(!mm.loading)mm.phase='gather';return [close()];
  }
  delete mm.loading;
  if(!canMine(s)){
    m.goal='obtain-mining-tool';
    if(bank.some((i:any)=>canMine({...s,inventory:[i],equipment:[]}))||count(995)<6)return bankAction();
    if(s.shop?.isOpen){
      const stock=s.shop.shopItems?.filter((i:any)=>/pickaxe$/i.test(i.name)&&i.count>0&&i.buyPrice>0&&i.buyPrice<=count(995)-5)
        .filter((i:any)=>{const tier=TOOL_TIERS.find(t=>t.pickaxeName.toLowerCase()===String(i.name).toLowerCase());return !tier||skillLevel(s,'mining')>=tier.mining;})
        .sort((a:any,b:any)=>Number(b.buyPrice)-Number(a.buyPrice));
      const pick=stock?.[0];
      return pick?[action('buy-pickaxe','shopBuy',{slot:pick.slot,amount:1,itemId:pick.id,expectedPrice:pick.buyPrice})]:[close()];
    }
    // After climbing down, the entrance coordinates are on the surface map.
    // Continue to the observed underground shop instead of asking navigation
    // to cross the disconnected floor boundary in reverse.
    if(Number(s.player?.worldZ)>9000)return shopAt(s,/^nurmof$/i,{x:2998,z:9844,level:0});
    // Nurmof is in the underground Dwarven Mine. Walk to the verified
    // Falador trapdoor first, then use its observed climb-down action; a
    // direct walk to z=9844 is a disconnected-map partial path.
    const entrance = s.nearbyLocs?.find((l:any)=>/trapdoor/i.test(String(l.name))&&l.reachable===true&&l.optionsWithIndex?.some((o:any)=>/^(open|climb-down|climb down)$/i.test(o.text)));
    if(entrance){
      const option=entrance.optionsWithIndex.find((o:any)=>/^(climb-down|climb down|open)$/i.test(o.text));
      if(option)return [action('dwarven-mine-entrance','interactLoc',{x:entrance.x,z:entrance.z,locId:entrance.id,optionIndex:option.opIndex,reason:'enter the verified Dwarven Mine route to Nurmof'},3)];
    }
    const d=Math.hypot(Number(s.player?.worldX)-3018,Number(s.player?.worldZ)-3450);
    if(d>8)return [walk('dwarven-mine-entrance',3018,3450)];
    return [action('scan-dwarven-mine-entrance','scanNearbyLocs',{radius:16,reason:'find the verified Falador Dwarven Mine trapdoor'},3)];
  }
  const carryingBatch=inv.some((i:any)=>oreLevels[i.id]!==undefined||BAR_RECIPES[i.id]);
  // When the verified pickaxe shop is already open, prefetch the next usable
  // tier (and one level ahead) if it is affordable.  This keeps progression
  // supplies in the bank instead of forcing a new underground shop trip after
  // every Mining level.
  if(s.shop?.isOpen&&!carryingBatch){
    // The bulk audit starts at the bank. If a restart finds CoinCrafter in
    // Nurmof's shop before the audit has been funded, leave the shop and
    // return through the verified mine exit instead of closing/reopening the
    // same shop forever.
    if(mm.bulkPickaxeAudit==='pending')return [close()];
    const owned=(id:number)=>total([...inv,...bank],id)>0;
    if(mm.bulkPickaxeAudit==='funded'){
      const bulk=s.shop.shopItems?.filter((i:any)=>i.count>0&&i.buyPrice>0&&i.buyPrice<=count(995)-5&&/pickaxe$/i.test(i.name))
        .map((i:any)=>({item:i,tier:TOOL_TIERS.find(t=>t.pickaxeId===i.id)}))
        .filter((x:any)=>x.tier&&x.tier.tier>bestToolTier([...inv,...bank],'pickaxe')&&!owned(x.tier.pickaxeId))
        .sort((a:any,b:any)=>a.tier.tier-b.tier.tier)[0];
      if(bulk)return [action('bulk-buy-pickaxe','shopBuy',{slot:bulk.item.slot,amount:1,itemId:bulk.item.id,expectedPrice:bulk.item.buyPrice})];
      mm.bulkPickaxeAudit='complete';m.reason='Bulk pickaxe audit complete; bank the remaining gold and resume mining/smithing';return [close()];
    }
    const prefetch=s.shop.shopItems?.filter((i:any)=>i.count>0&&i.buyPrice>0&&i.buyPrice<=count(995)-5&&/pickaxe$/i.test(i.name))
      .map((i:any)=>({item:i,tier:TOOL_TIERS.find(t=>t.pickaxeName.toLowerCase()===String(i.name).toLowerCase())}))
      .filter((x:any)=>x.tier&&x.tier.mining<=skillLevel(s,'mining')+1&&!owned(x.tier.pickaxeId)&&x.tier.tier>bestToolTier([...inv,...bank],'pickaxe'))
      .sort((a:any,b:any)=>a.tier.tier-b.tier.tier)[0];
      if(prefetch)return [action('prefetch-pickaxe','shopBuy',{slot:prefetch.item.slot,amount:1,itemId:prefetch.item.id,expectedPrice:prefetch.item.buyPrice})];
  }
  if(mm.bulkPickaxeAudit==='pending')return bankAction();
  if(plan?.desiredPickaxe&&carriedPickTier<plan.desiredPickaxe.tier&&!carryingBatch){
    m.goal='buy-'+plan.desiredPickaxe.pickaxeName.toLowerCase().replaceAll(' ','-');
    m.reason=`Buy ${plan.desiredPickaxe.pickaxeName} from an observed pickaxe shop before mining ${plan.desiredPickaxe.metal}`;
    if(s.shop?.isOpen){
      const stock=s.shop.shopItems?.filter((i:any)=>/pickaxe$/i.test(i.name)&&i.count>0&&i.buyPrice>0&&i.buyPrice<=count(995)-5)
        .filter((i:any)=>{const tier=TOOL_TIERS.find(t=>t.pickaxeName.toLowerCase()===String(i.name).toLowerCase());return tier&&tier.tier>=plan.desiredPickaxe.tier&&skillLevel(s,'mining')>=tier.mining;})
        .sort((a:any,b:any)=>Number(b.buyPrice)-Number(a.buyPrice));
      const pick=stock?.[0];
      if(pick)return [action('buy-pickaxe-upgrade','shopBuy',{slot:pick.slot,amount:1,itemId:pick.id,expectedPrice:pick.buyPrice})];
      return [close()];
    }
    if(count(995)<700&&total(bank,995)>0)return bankAction();
    // The shop is underground; a direct surface-to-shop route crosses a
    // disconnected floor and is rejected by collision navigation.
    if(Number(s.player?.worldZ)<=9000){
      const entrance=s.nearbyLocs?.find((l:any)=>/trapdoor/i.test(String(l.name))&&l.reachable===true&&l.optionsWithIndex?.some((o:any)=>/^(open|climb-down|climb down)$/i.test(o.text)));
      if(entrance){
        const option=entrance.optionsWithIndex.find((o:any)=>/^(climb-down|climb down|open)$/i.test(o.text));
        if(option)return [action('dwarven-mine-entrance','interactLoc',{x:entrance.x,z:entrance.z,locId:entrance.id,optionIndex:option.opIndex,reason:'enter the verified Dwarven Mine route to Nurmof'},3)];
      }
      const d=Math.hypot(Number(s.player?.worldX)-3018,Number(s.player?.worldZ)-3450);
      if(d>8)return [walk('dwarven-mine-entrance',3018,3450)];
      return [action('scan-dwarven-mine-entrance','scanNearbyLocs',{radius:16,reason:'find the verified Falador Dwarven Mine trapdoor'},3)];
    }
    return shopAt(s,/^nurmof$/i,{x:2998,z:9844,level:0});
  }
  const obtainHammer=():Action[]=>{
    if(total(bank,2347)||count(995)<6)return bankAction();
    // The Dwarven Mine is a disconnected floor. Do not ask the navigator to
    // jump directly from underground to the surface hammer shop; first locate
    // and use the live underground exit, discovering it from the current map.
    if(inDwarvenMine(s))return leaveDwarvenMine(s);
    if(s.shop?.isOpen){
      const hammer=s.shop.shopItems?.find((i:any)=>i.id===2347&&i.count>0&&i.buyPrice>0&&i.buyPrice<=count(995)-5);
      return hammer?[action('buy-hammer','shopBuy',{slot:hammer.slot,amount:1,itemId:hammer.id,expectedPrice:hammer.buyPrice})]:[close()];
    }
    return shopAt(s,/^shop keeper$|^shop assistant$/i,{x:3218,z:3415});
  };
  // Buy opportunistically when already viewing stock, but do not make hammer
  // shopping a prerequisite for gathering or smelting.
  if(!count(2347)&&s.shop?.isOpen&&s.shop.shopItems?.some((i:any)=>i.id===2347&&i.count>0&&i.buyPrice>0&&i.buyPrice<=count(995)-5))return obtainHammer();
  if(s.shop?.isOpen)return [close()];
  if(inv.some((i:any)=>isFletchedOutput(i)||/^(.*logs|logs)$/i.test(i.name))||mm.phase==='bank')return bankAction();
  const useIron=targetBar===2351;
  mm.ore=barRecipe.primary;
  const ready=count(barRecipe.primary)>=8&&(!barRecipe.secondary||count(barRecipe.secondary)>=8*barRecipe.secondaryCount);
  const canSmelt=count(barRecipe.primary)>0&&(!barRecipe.secondary||count(barRecipe.secondary)>=barRecipe.secondaryCount);
  if(mm.phase==='smelt'&&!canSmelt)mm.phase='smith';
  if(mm.phase==='smelt'){
    if((mm.smeltBlockedUntil??0)>Date.now()){mm.phase='bank';return bankAction();}
    m.goal='smelt-'+(TOOL_TIERS.find(t=>t.barId===targetBar)?.metal??'bronze');
    const furnace=s.nearbyLocs?.find((l:any)=>l.id===2781&&l.reachable===true&&l.optionsWithIndex?.some((o:any)=>/^smelt$/i.test(o.text)));
    if(Number(s.player.animId)>=0)return [action('smelt-working','wait',{},3)];
    if(!furnace)return service('furnace',3229,3255);
    mm.servicePolls=0;return [action('smelt-ore','useItemOnLoc',{itemSlot:inv.find((i:any)=>i.id===mm.ore).slot,x:furnace.x,z:furnace.z,locId:furnace.id},5)];
  }
  const bar=count(targetBar)>0?targetBar:[2349,2351,2353,2359,2361,2363].find(id=>count(id)>0);
  if(mm.phase==='smith'&&bar){
    if(!count(2347)){m.goal='obtain-smithing-hammer';return obtainHammer();}
    if((mm.smithBlockedUntil??0)>Date.now()){mm.phase='bank';return bankAction();}
    const target=product(s,bar,stageAxe);mm.product=target.name;mm.productId=target.id;m.goal='smith-'+target.name.toLowerCase().replaceAll(' ','-');
    const dialog=metalDialog(s,m);if(dialog)return [dialog];
    if(s.modalOpen){mm.smithBlockedUntil=Date.now()+300_000;mm.phase='bank';m.reason='Smithing inventory interface needs a verified product mapping; retain bars';return [close()];}
    if(Number(s.player.animId)>=0)return [action('smith-working','wait',{},3)];
    const anvil=s.nearbyLocs?.find((l:any)=>l.id===2783&&l.reachable===true);
    if(!anvil)return service('anvil',3187,3425);
    mm.servicePolls=0;return [action('smith-input','useItemOnLoc',{itemSlot:inv.find((i:any)=>i.id===bar).slot,x:anvil.x,z:anvil.z,locId:anvil.id},2)];
  }
  if(mm.phase==='smith'){mm.phase='bank';return bankAction();}
  // Keep batches bounded while the agent learns the next tool tier.
  if(ready) {mm.phase='smelt';return metalNext(s,m,blocked);}
  if(inv.length>=28){if(ready){mm.phase='smelt';return metalNext(s,m,blocked);}mm.phase='bank';return bankAction();}
  if((mm.cooldownUntil??0)>Date.now())return [action('resource-cooldown','wait',{},5)];
  // Complete the carried batch; banked ingredients are loaded at the bank,
  // not treated as if they were available inside this mine.
  const primaryTotal=count(barRecipe.primary), secondaryTotal=barRecipe.secondary?count(barRecipe.secondary):0;
  const primaryDeficit=Math.max(0,8-primaryTotal), secondaryDeficit=barRecipe.secondary?Math.max(0,8*barRecipe.secondaryCount-secondaryTotal):0;
  // Finish the primary batch, then its required partner. The old comparison
  // kept choosing copper even after eight copper and zero tin were carried.
  const wanted=barRecipe.secondary&&primaryDeficit===0&&secondaryDeficit>0?barRecipe.secondary:barRecipe.primary;
  const ids=oreLocIds[wanted]??[];
  const hints=miningHintsFor(ids);
  const rocks=(s.nearbyLocs??[]).filter((l:any)=>ids.includes(l.id)&&l.reachable===true&&hints.some(p=>p.x===l.x&&p.z===l.z)&&l.optionsWithIndex?.some((o:any)=>/^mine$/i.test(o.text)))
    .sort((a:any,b:any)=>a.distance-b.distance);
  m.goal='mine-'+(wanted===436?'copper':wanted===438?'tin':wanted===453?'coal':wanted===440?'iron':TOOL_TIERS.find(t=>t.primaryOre===wanted)?.metal??'ore');
  if(rocks[0] && unsafeMiningNeighbour(s)) {
    mm.cooldownUntil=Date.now()+300_000; m.reason='Visible mining-area threat exceeds current defensive kit; leave and prepare';
    return inDwarvenMine(s)?leaveDwarvenMine(s):bankAction();
  }
  if(rocks[0]){delete mm.missing;const r=rocks[0];return [action('mine-'+r.x+'-'+r.z,'interactLoc',{locId:r.id,x:r.x,z:r.z,optionIndex:r.optionsWithIndex.find((o:any)=>/^mine$/i.test(o.text)).opIndex},5)];}
  const route=miningRouteHint(ids,s);
  if(!route&&inDwarvenMine(s))return leaveDwarvenMine(s);
  if(route&&Math.max(Math.abs(s.player.worldX-route.x),Math.abs(s.player.worldZ-route.z))>10)return [walk('mine-route-'+route.map,route.x,route.z)];
  if(mm.lastTick!==s.tick){mm.lastTick=s.tick;mm.missing=(mm.missing??0)+1;}
  if((mm.missing??0)>=3){mm.cooldownUntil=Date.now()+60_000;mm.missing=0;m.reason='No source-matched live ore found; retry after depletion cooldown';}
  return [action('ore-respawn','wait',{},5)];
}

export function validateMetal(s:any,a:Action,before?:any){
  if(!a.id.startsWith('economy-metal-'))return true;
  if(before&&/^bank(Withdraw|Deposit)$/.test(a.type)){
    const old=a.type==='bankWithdraw'?before.bank?.items:before.inventory,live=a.type==='bankWithdraw'?s.bank?.items:s.inventory;
    const id=old?.find((i:any)=>i.slot===a.fields!.slot)?.id;
    return s.bank?.isOpen===true&&id!==undefined&&live?.some((i:any)=>i.slot===a.fields!.slot&&i.id===id)&&total(live??[],id)>=a.fields!.amount;
  }
  if(a.type==='interactLoc'){
    const expected=/dwarven-mine-entrance/i.test(a.id)?/^(open|climb-down|climb down)$/i:/dwarven-mine-exit/i.test(a.id)?/^(open|climb-up|climb up|up)$/i:/^mine$/i;
    return s.nearbyLocs?.some((l:any)=>l.id===a.fields!.locId&&l.x===a.fields!.x&&l.z===a.fields!.z&&l.reachable===true&&l.optionsWithIndex?.some((o:any)=>o.opIndex===a.fields!.optionIndex&&expected.test(o.text)));
  }
  if(before&&a.type==='clickDialogOption')return s.dialog?.isOpen&&s.dialog.options?.some((o:any)=>o.index===a.fields!.optionIndex&&o.text===before.dialog?.options?.find((p:any)=>p.index===o.index)?.text);
  if(a.type==='shopBuy')return s.shop?.isOpen===true&&s.shop.shopItems?.some((i:any)=>i.id===a.fields!.itemId&&i.slot===a.fields!.slot&&i.count>0&&i.buyPrice===a.fields!.expectedPrice)
    &&total(s.inventory??[],995)>=a.fields!.expectedPrice+5;
  if(a.type==='useItemOnLoc')return s.inventory?.some((i:any)=>i.slot===a.fields!.itemSlot&&[436,438,440,447,449,451,453,2349,2351,2353,2359,2361,2363].includes(i.id)&&(!before||i.id===before.inventory?.find((b:any)=>b.slot===i.slot)?.id))
    &&s.nearbyLocs?.some((l:any)=>l.id===a.fields!.locId&&l.x===a.fields!.x&&l.z===a.fields!.z&&l.reachable===true);
  return true;
}
