// Guide-backed priorities, checked against the vendored 274 content.
// Rates/prices from OSRS are never substituted for this server's observations.
import { hasUsableArrows } from './runtime-policy';
import { economyTrack, metalNext, type MetalMemory } from './economy/metalworking';
import type { ObjectiveMemory } from './economy/objectives';
import { bowNext, type BowMemory } from './economy/bowmaking';
export type Action = { id: string; type: string; fields?: Record<string, any>; waitTicks: number };
export const BANKS = [
  { name: 'varrock-west', x: 3185, z: 3436, level: 0 },
  { name: 'edgeville', x: 3094, z: 3491, level: 0 },
];
export const SOURCES = {
  wood: 'https://oldschool.runescape.wiki/w/Free-to-play_Woodcutting_training',
  axes: "https://oldschool.runescape.wiki/w/Bob%27s_Brilliant_Axes.",
  picks: "https://oldschool.runescape.wiki/w/Nurmof%27s_Pickaxe_Shop.",
  fletching: 'https://oldschool.runescape.wiki/w/Fletching_training',
};
export const skillLevel = (s: any, name: string) => Number(s.skills?.find((x: any) => String(x.name).toLowerCase() === name.toLowerCase())?.baseLevel ?? s.skills?.find((x: any) => String(x.name).toLowerCase() === name.toLowerCase())?.level ?? 1);
export const foodCount = (s: any) => (s.inventory ?? []).filter((i: any) => i.optionsWithIndex?.some((o: any) => /^eat$/i.test(o.text))).reduce((n: number,i: any) => n + Number(i.count),0);
export function activeOpponent(s: any) {
  const c = s.player?.combat;
  return c?.inCombat && c.targetType === 'npc'
    ? s.nearbyNpcs?.find((n: any) => n.index === c.targetIndex && n.optionsWithIndex?.some((o: any) => /^attack$/i.test(o.text)))
    : undefined;
}
export function isApprovedNpcTarget(target: any): boolean {
  return /^(rat|giant rat|chicken|cow|cow calf|goblin|imp|man|woman|barbarian|giant spider|skeleton|zombie|hill giant|moss giant|hobgoblin)$/i.test(String(target?.name ?? ''));
}
export function shouldHeal(s: any, ranged = false): boolean {
  // Covers the former 40–60% dead zone. A healthy ongoing fight is not a reason to flee.
  const hp = Number(s.player?.hp), max = Number(s.player?.maxHp);
  return Number.isFinite(hp) && max > 0 && hp < max && hp <= max * (ranged ? .75 : .65) && foodCount(s) > 0;
}
export function combatDisposition(s: any, economy = false, ranged = false, observedDamage = 0): 'engaged' | 'recover' | 'quiet' {
  const target = activeOpponent(s);
  const damageAge = Number(s.tick) - Number(s.player?.combat?.lastDamageTick);
  const newUnattributedDamage = Number(s.player?.combat?.lastDamageTick) >= 0 && damageAge >= 0 && damageAge <= 10;
  if (s.player?.combat?.targetType === 'player') return 'recover';
  if (target) {
    // Same encounter families as the training planner, not a blanket "in combat
    // means flee" rule. Unexpected opponents still trigger recovery.
    const known = isApprovedNpcTarget(target);
    const hp = Number(s.player?.hp), max = Number(s.player?.maxHp);
    const usableAmmo = !ranged || hasUsableArrows(s.combatStyle?.weaponName ?? '', s.equipment ?? []);
    const targetLevel = Number(target.combatLevel ?? 1);
    const combatLevel = Number(s.player?.combatLevel ?? 1);
    // A newly discovered opponent may be trialled, but only when it is within
    // a narrow level band and the normal health/supply checks pass. This lets
    // Stinger learn from targets such as Black unicorns without treating every
    // unknown NPC as safe.
    const conservativeUnknownTrial = !known && targetLevel > 0 && targetLevel <= combatLevel + 8;
    // Observed loss can span multiple ticks: retaining it is conservative.
    // Unknown damage keeps the previous health margin until evidence exists.
    const margin = observedDamage > 0 ? Math.max(4, observedDamage * 3) : Math.max(4, max * .4);
    const foodlessSafeTrial = foodCount(s) === 0 && combatLevel >= targetLevel + 3
      && hp > (observedDamage > 0 ? margin : max * .85);
    if (!economy && (known || conservativeUnknownTrial) && usableAmmo && hp > margin && (foodCount(s) > 0 || foodlessSafeTrial)) return 'engaged';
    // Unknown NPCs are passed during travel. Discovery promotes them only
    // after the training catalog has recorded a safe, actionable target.
    if (!known) return 'quiet';
    return 'recover';
  }
  return newUnattributedDamage ? 'recover' : 'quiet';
}
export function chooseLocalTargets(npcs: any[], maxDistance = 8) {
  // Don't give a distant level-2 spider priority because its name matches a level-50 OSRS monster.
  return npcs.filter(n => Number(n.distance) <= maxDistance)
    .sort((a,b) => Number(a.distance)-Number(b.distance) || Number(a.combatLevel)-Number(b.combatLevel));
}
export function nearbyAmmoRecovery(s: any): Action[] {
  if (s.player?.combat?.inCombat || (s.inventory?.length ?? 28) >= 28) return [];
  const arrow = s.groundItems?.filter((i:any) => i.reachable === true && Number(i.distance) <= 6
    && hasUsableArrows(s.combatStyle?.weaponName ?? '', [i]))
    .sort((a:any,b:any)=>a.distance-b.distance)[0];
  return arrow ? [{id:'recover-arrows-'+arrow.x+'-'+arrow.z,type:'pickupItem',fields:{x:arrow.x,z:arrow.z,itemId:arrow.id},waitTicks:8}] : [];
}
export function quiverRefill(s:any): Action[] {
  const bow=s.combatStyle?.weaponName ?? '';
  if (hasUsableArrows(bow,s.equipment ?? []) || Number(s.player?.hp) <= Number(s.player?.maxHp)*.6) return [];
  const arrows=s.inventory?.find((i:any)=>hasUsableArrows(bow,[i]) && i.optionsWithIndex?.some((o:any)=>/^wield$|^equip$/i.test(o.text)));
  const option=arrows?.optionsWithIndex.find((o:any)=>/^wield$|^equip$/i.test(o.text));
  return arrows && option ? [{id:'wield-ammo-'+arrows.slot,type:'useInventoryItem',fields:{slot:arrows.slot,optionIndex:option.opIndex},waitTicks:2}] : [];
}
export function meleeTrainingSkill(attack: number, strength: number) {
  return attack < strength ? 'attack' : 'strength';
}
export function fletchingRecipe(log: string, level: number): string | null {
  const tiers = [
    ['logs',5,10,''],['oak logs',20,25,'Oak '],['willow logs',35,40,'Willow '],
    ['maple logs',50,55,'Maple '],['yew logs',65,70,'Yew '],['magic logs',80,85,'Magic '],
  ] as const;
  const row = tiers.find(t => t[0] === log.toLowerCase());
  if (!row) return null;
  if (level >= row[2]) return row[3] + 'Long Bow';
  if (level >= row[1]) return row[3] + 'Short Bow';
  return row[0] === 'logs' ? 'Arrow Shafts' : null;
}
export function productionDialog(options: any[], label: string) {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z]/g,'');
  const product = options.find(o => Number.isInteger(o.index) && norm(o.text).includes(norm(label)));
  // The live 2004 interface exposes a four-button group per product. Select
  // that product's observed Make 10, not the first Make 10 in the dialog.
  return options.find(o => product && Number.isInteger(product.componentId) &&
    o.componentId === product.componentId - 2 && /^make 10$/i.test(o.text)) ?? product;
}
export const axeRank = (name: string) => /pickaxe|battleaxe/i.test(name) ? 0 :
  ['bronze axe','iron axe','steel axe','black axe','mithril axe','adamant axe','rune axe'].indexOf(name.toLowerCase()) + 1;
// 2004 unstrung bows use the same display names as finished bows. Do not infer
// sellability from a modern "(u)" suffix, or sell the usable starter Shortbow.
export const isFletchedOutput = (i:any) => [48,50,54,56,58,60,62,64,66,68,70,72].includes(Number(i.id));
const axeLevels = [0,1,1,6,6,21,31,41];
const near = (s: any,p: any,r=2) => Number(s.player?.level) === (p.level ?? 0)
  && Math.max(Math.abs(s.player.worldX-p.x),Math.abs(s.player.worldZ-p.z)) <= r;
const coins = (items: any[]) => items.filter(i => /^coins$/i.test(i.name)).reduce((n,i)=>n+Number(i.count),0);
export type EconomyMemory = {
  objectives?: ObjectiveMemory;
  metal?: MetalMemory;
  bowmaking?: BowMemory;
  bankItems?: any[]; processing?: string; product?: string; selling?: boolean;
  harvest?: { id: number; x: number; z: number }; goal?: string; reason?: string;
  selectedSite?: string; batches?: number;
  missingResource?: { site: string; polls: number; tick: number };
  siteCooldowns?: Record<string, number>;
  bankCooldowns?: Record<string, number>;
};
export function woodSites(s: any, processing=true) {
  const wc = skillLevel(s,'woodcutting'), fletch = skillLevel(s,'fletching');
  const axe = Math.max(0,...[...(s.inventory ?? []),...(s.equipment ?? [])].map((i: any) => axeRank(i.name)));
  const sites = [];
  if (wc >= 60 && (!processing || fletch >= 65) && axe >= 3) sites.push({ name:'edgeville-yew',tree:'Yew',x:3088,z:3480,level:0,bank:BANKS[1]!,reason:'Use the collision-proven east approach outside the 3x3 yew footprint; test throughput with an upgraded axe' });
  // m48_54 LOC 0 39 31: willowtree, size 2x2. The old x=3112
  // is INSIDE its footprint. x=3113 is the collision-proven east approach,
  // not permission to accept any adjacent endpoint as arrival.
  if (wc >= 30) sites.push({ name:'edgeville-willow',tree:'Willow',x:3113,z:3487,level:0,bank:BANKS[1]!,reason:'Reach the east side of the source willow footprint near Edgeville bank' });
  sites.push({ name:'varrock-oak',tree:wc >= 15 ? 'Oak' : 'Tree',x:3170,z:3420,level:0,bank:BANKS[0]!,reason:'Use the east approach outside the 3x3 oak footprint near Varrock West bank' });
  return sites;
}
export function selectWoodSite(s: any) { return woodSites(s)[0]!; }
const resource = (i: any) => isFletchedOutput(i) || /^(logs|oak logs|willow logs|maple logs|yew logs|magic logs|arrow shaft.*|.*ore|.*bar)$/i.test(i.name);
function walk(id: string,p: any,reason: string): Action[] { return [{id,type:'walkTo',fields:{x:p.x,z:p.z,level:p.level ?? 0,reason},waitTicks:2}]; }
function close(): Action[] { return [{id:'economy-close-interface',type:'closeModal',waitTicks:1}]; }
export function bankAt(s: any, preferred?: typeof BANKS[number], blocked: (id: string) => boolean = () => false, unavailable: Record<string, number> = {}): Action[] {
  const booth = (s.nearbyLocs ?? []).find((l: any) => /bank booth|bank chest/i.test(l.name) && l.reachable === true && l.optionsWithIndex?.some((o: any) => /^use-quickly$|^bank$/i.test(o.text)));
  if (booth) return [{id:'economy-open-bank',type:'interactLoc',fields:{x:booth.x,z:booth.z,locId:booth.id,optionIndex:booth.optionsWithIndex.find((o: any)=>/^use-quickly$|^bank$/i.test(o.text)).opIndex},waitTicks:2}];
  const ordered = [...BANKS].sort((a,b) => Math.hypot(s.player.worldX-a.x,s.player.worldZ-a.z)-Math.hypot(s.player.worldX-b.x,s.player.worldZ-b.z));
  if (preferred) ordered.sort((a,b) => Number(b.name === preferred.name) - Number(a.name === preferred.name));
  for (const bank of BANKS) if (near(s,bank,0)) unavailable[bank.name] = Date.now() + 300_000;
  const destination = ordered.find(p => !blocked('economy-bank-'+p.name) && (unavailable[p.name] ?? 0) <= Date.now());
  return destination ? walk('economy-bank-'+destination.name,destination,'Try a feasible bank; arrival still requires an observed usable booth')
    : [{id:'economy-bank-alternatives-blocked',type:'wait',waitTicks:5}];
}
export function shopAt(s: any, name: RegExp, destination: any): Action[] {
  const npc = s.nearbyNpcs?.find((n: any)=>name.test(n.name) && n.reachable === true);
  const trade = npc?.optionsWithIndex?.find((o: any)=>/^trade$/i.test(o.text));
  if (npc && trade) return [{id:'economy-trade-'+npc.index,type:'interactNpc',fields:{npcIndex:npc.index,optionIndex:trade.opIndex},waitTicks:2}];
  return near(s,destination,0) ? [{id:'economy-shop-not-visible',type:'wait',waitTicks:5}] : walk('economy-shop-'+destination.x,destination,'Obtain the required tool through an observed shop');
}
export function economyNext(s: any,m: EconomyMemory, blocked: (id: string) => boolean = () => false): Action[] {
  if(m.objectives&&!m.objectives.intent){m.goal='review-profit-prerequisites';m.reason=m.objectives.decision?.blocker??'No supported positive or unmeasured production option; preserve assets until an alternative is available';return [{id:'economy-review-profit-prerequisites',type:'wait',waitTicks:5}];}
  if(economyTrack(s,m)==='metalworking')return metalNext(s,m,blocked);
  if(m.objectives?.intent?.mode==='finish')return bowNext(s,m,blocked);
  const intent=m.objectives?.intent,processLogs=intent?.mode!=='logs';
  const inv = s.inventory ?? [], eq = s.equipment ?? [], all = [...inv,...eq];
  const cash = coins(inv), bestAxe = Math.max(0,...all.map((i:any)=>axeRank(i.name)));
  const hasPick = all.some((i:any)=>/^(bronze|iron|steel|mithril|adamant|rune) pickaxe$/i.test(i.name));
  const knife = inv.find((i:any)=>/^knife$/i.test(i.name));
  const fletch = skillLevel(s,'fletching');
  const site = woodSites(s,processLogs).find(p => (!intent?.site||p.name===intent.site) && !blocked('economy-site-'+p.name) && (m.siteCooldowns?.[p.name] ?? 0) <= Date.now());
  m.selectedSite = site?.name;
  const useBank = (preferred?: typeof BANKS[number]) => bankAt(s, preferred, blocked, m.bankCooldowns ??= {});
  if (m.processing && !inv.some((i:any)=>String(i.name).toLowerCase() === m.processing)) { delete m.processing; delete m.product; }
  if (s.bank?.isOpen) {
    m.bankItems = s.bank.items ?? [];
    const material = inv.find((i:any)=>resource(i) && String(i.name).toLowerCase() !== m.processing && !m.selling);
    if (material) { m.goal='bank-production-batch'; return [{id:'economy-deposit-'+material.slot,type:'bankDeposit',fields:{slot:material.slot,amount:inv.filter((i:any)=>i.id===material.id).reduce((n:number,i:any)=>n+Number(i.count),0)},waitTicks:2}]; }
    // Tools are usable from inventory: never require Attack levels just to carry them.
    const storedTool = m.bankItems!.find(i => (!bestAxe && axeRank(i.name)>0) || (!hasPick && !intent && /^bronze pickaxe$/i.test(i.name)) || (processLogs && !knife && /^knife$/i.test(i.name)));
    if (storedTool && inv.length < 28) return [{id:'economy-withdraw-tool',type:'bankWithdraw',fields:{slot:storedTool.slot,amount:1},waitTicks:2}];
    const bankCoins = m.bankItems!.find(i=>/^coins$/i.test(i.name));
    if (cash < 25 && bankCoins && (bestAxe < 3 || !hasPick)) return [{id:'economy-withdraw-tool-fund',type:'bankWithdraw',fields:{slot:bankCoins.slot,amount:Math.min(250-cash,Number(bankCoins.count))},waitTicks:2}];
    if (m.processing || m.selling) return close();
    // Prefer banked inputs before another gathering trip. Only process a usable tier.
    const storedLogs = processLogs && knife ? m.bankItems!.filter(i=>(!intent||i.id===intent.inputId) && fletchingRecipe(i.name,fletch) && Number(i.count)>0)
      .sort((a,b)=>['logs','oak logs','willow logs','maple logs','yew logs','magic logs'].indexOf(b.name.toLowerCase())-['logs','oak logs','willow logs','maple logs','yew logs','magic logs'].indexOf(a.name.toLowerCase()))[0] : undefined;
    if (storedLogs && inv.length < 25) {
      m.processing=storedLogs.name.toLowerCase(); m.product=intent?.recipe??fletchingRecipe(storedLogs.name,fletch)!; m.goal='batch-fletching';
      return [{id:'economy-withdraw-fletching-batch',type:'bankWithdraw',fields:{slot:storedLogs.slot,amount:Math.min(24,28-inv.length,Number(storedLogs.count))},waitTicks:2}];
    }
    if (bestAxe < 3 && cash < 250) {
      const sell = m.bankItems!.find(i=>isFletchedOutput(i) && Number(i.count)>0);
      if (sell && inv.length < 25) { m.selling=true; m.goal='fund-tool-upgrade'; return [{id:'economy-withdraw-sale-batch',type:'bankWithdraw',fields:{slot:sell.slot,amount:Math.min(20,28-inv.length,Number(sell.count))},waitTicks:2}]; }
    }
    if (cash > 250) {
      const c = inv.find((i:any)=>/^coins$/i.test(i.name));
      return [{id:'economy-bank-surplus',type:'bankDeposit',fields:{slot:c.slot,amount:cash-250},waitTicks:2}];
    }
    return close();
  }
  if (s.shop?.isOpen) {
    const stock = (s.shop.shopItems ?? []).filter((i:any)=>Number(i.count)>0 && Number.isFinite(i.buyPrice) && i.buyPrice>0 && i.buyPrice <= cash);
    const axe = stock.filter((i:any)=>axeRank(i.name)>bestAxe && skillLevel(s,'woodcutting')>=axeLevels[axeRank(i.name)]! && i.buyPrice <= cash-(!hasPick ? 1 : 0))
      .sort((a:any,b:any)=>axeRank(b.name)-axeRank(a.name))[0];
    const pick = !hasPick ? stock.find((i:any)=>/^bronze pickaxe$/i.test(i.name)) : undefined;
    const buy = axe ?? pick;
    if (buy) return [{id:'economy-buy-tool-'+buy.id,type:'shopBuy',fields:{slot:buy.slot,amount:1,reason:'Source-compatible tool; observed price within carried budget'},waitTicks:2}];
    if (m.selling) {
      const sale = inv.find(isFletchedOutput);
      const offer = s.shop.playerItems?.find((i:any)=>i.id===sale?.id && Number(i.sellPrice)>0);
      if (sale && offer) return [{id:'economy-sell-product-'+sale.slot,type:'shopSell',fields:{slot:sale.slot,amount:1},waitTicks:2}];
      if (!sale) m.selling=false;
    }
    return close();
  }
  if ((!bestAxe || !hasPick&&!intent || (bestAxe < 3 && cash >= 200)) && !m.processing && !m.selling) {
    m.goal='obtain-tools'; m.reason='Recover/upgrade axe; carry a bronze pickaxe before any mining trip';
    if ((!bestAxe && cash < 16) || (!hasPick && cash < 1)) {
      if (coins(m.bankItems ?? [])>0 || (m.bankItems ?? []).some(i=>axeRank(i.name)>0)) return useBank();
      m.reason='No cash/tool available: need a banked sale batch or a verified free tool source';
      return useBank();
    }
    return shopAt(s,/^bob$/i,{x:3232,z:3203});
  }
  if (processLogs && !knife) {
    m.goal='obtain-fletching-knife'; m.reason='Normal ground spawn at Lumbridge, map m50_50 OBJ 0 24 2:946';
    const item = s.groundItems?.find((i:any)=>/^knife$/i.test(i.name) && i.reachable === true);
    if (item) return near(s,item,1)
      ? [{id:'economy-pickup-knife',type:'pickupItem',fields:{x:item.x,z:item.z,itemId:item.id},waitTicks:2}]
      : walk('economy-knife-spawn',item,'Reach the observed knife pile before attempting pickup');
    return near(s,{x:3224,z:3202},0) ? [{id:'economy-wait-knife-respawn',type:'wait',waitTicks:5}] : walk('economy-knife-spawn',{x:3224,z:3202},m.reason);
  }
  if (m.selling) {
    // Public m50_53 shop keeper spawn near the current production bank.
    // Resolve the actual Trade menu after arrival, not a sale from proximity.
    if (inv.some(isFletchedOutput)) return shopAt(s,/^shop keeper$|^shop assistant$/i,{x:3218,z:3415});
    delete m.selling;
  }
  if (processLogs && m.processing) {
    // A Make-10 queue owns the character until it finishes. Reopening the
    // product dialog cancels that queue, even though dispatch reported success.
    if (Number(s.player?.animId) >= 0) return [{id:'economy-continue-production',type:'wait',waitTicks:2}];
    const log = inv.find((i:any)=>String(i.name).toLowerCase()===m.processing);
    const recipe = log && (intent?.recipe??fletchingRecipe(log.name,fletch));
    if (recipe) {
      m.product=recipe; m.goal='batch-fletching'; m.reason='Knife + '+log.name+' -> '+recipe+'; verify Fletching XP and output';
      return [{id:'economy-fletch-'+log.slot,type:'useItemOnItem',fields:{sourceSlot:knife.slot,targetSlot:log.slot},waitTicks:2}];
    }
  }
  // Completed products are banked before another batch; retain tools and supplies.
  if (inv.length >= 28 || inv.some((i:any)=>isFletchedOutput(i) || /arrow shaft/i.test(i.name))) {
    m.goal='bank-production-batch'; m.reason='Deposit products and preserve tools before the next batch';
    return useBank(site?.bank);
  }
  if (processLogs && (m.bankItems ?? []).some(i=>(!intent||i.id===intent.inputId) && fletchingRecipe(i.name,fletch) && Number(i.count)>0)) {
    m.goal='collect-banked-inputs'; m.reason='Process existing usable logs before spending time on another gathering trip';
    return useBank();
  }
  if (!site) { m.goal='gathering-cooldown'; m.reason='All prepared gathering sites temporarily unavailable'; return [{id:'economy-sites-blocked',type:'wait',waitTicks:5}]; }
  m.goal='gather-'+site.tree.toLowerCase(); m.reason=site.reason;
  if (!near(s,site,12)) return walk('economy-site-'+site.name,site,site.reason);
  const trees = (s.nearbyLocs ?? []).filter((l:any)=>l.name.toLowerCase()===site.tree.toLowerCase() && l.reachable === true
    && l.optionsWithIndex?.some((o:any)=>/^chop/i.test(o.text)) && Math.hypot(l.x-site.x,l.z-site.z)<20);
  trees.sort((a:any,b:any)=>Number(a.distance)-Number(b.distance));
  const tree = trees.find((l:any)=>l.id===m.harvest?.id && l.x===m.harvest?.x && l.z===m.harvest?.z) ?? trees[0];
  if (tree) {
    delete m.missingResource;
    if (m.harvest?.x===tree.x && m.harvest?.z===tree.z && Number(s.player.animId)>=0) return [{id:'economy-continue-harvest',type:'wait',waitTicks:2}];
    m.harvest={id:tree.id,x:tree.x,z:tree.z};
    return [{id:'economy-'+site.tree.toLowerCase()+'-'+tree.x+'-'+tree.z,type:'interactLoc',fields:{x:tree.x,z:tree.z,locId:tree.id,optionIndex:tree.optionsWithIndex.find((o:any)=>/^chop/i.test(o.text)).opIndex},waitTicks:5}];
  }
  delete m.harvest;
  if (m.missingResource?.site !== site.name) m.missingResource = { site: site.name, polls: 0, tick: -1 };
  if (m.missingResource.tick !== s.tick) { m.missingResource.tick = s.tick; m.missingResource.polls++; }
  if (m.missingResource.polls >= 3) {
    (m.siteCooldowns ??= {})[site.name] = Date.now() + 60_000;
    delete m.missingResource;
  }
  return [{id:'economy-resource-respawn',type:'wait',waitTicks:5}];
}
