import { recipeXp, recipeTrainingSkill, type PreparationOptions } from './goal-xp.ts';
/** Translate source facts into the existing Director's methods. Unsupported semantics stay diagnostic. */
import { createHash } from 'node:crypto';
import { SourceCatalogue, recipeYield, expectedDropQuantity, type SourceRecipe, type SourceRoute } from '../catalog/source-catalogue.ts';
import type { Requirement as SourceRequirement } from '../catalog/types.ts';
import type { Method, Requirement, Memory } from './types.ts';
import type { Catalogue, LiveState, Knowledge, Policy, Task } from './world-model.ts';
import type { AcquisitionMemory } from './acquisition.ts';
import { itemName, itemFact } from './item-intents.ts';

export type SourceTask = {
  profileId:string; kind:'recipe'|'bank'|'shop'|'pickup'|'gather'|'rune-entry'; itemId:number;
  quantity:number; recipeId?:string; routeId?:string; batch?:number; locationId?:string;
  expectedPrice?:number; runeItemId?:number;
};
export type SourceSettings = {
  version:1; directory:string; mode:'shadow'|'pilot'; pilotAgents:string[];
  confirmedProfileId?:string; confirmedWorld?:string; members?:boolean;
  pilotId?:string; expiresAt?:number; maxActions:number; maxSpendGp:number;
  requests?:Record<string,Array<{item:number|string;quantity:number}>>;
};
export type SourceReport = {
  version:string; agent:string; at:number; tick?:number; mode:string; profileId:string; enabled:boolean;
  counts:{items:number;recipes:number;routes:number}; needs:Array<{itemId:number;name:string;target:number}>;
  dependencyItems:number; truncated:boolean; registeredMethods:number;
  alternatives:Array<{itemId:number;name:string;methods:Record<string,number>;recipes:string[];drops:Array<{routeId:string;npcId?:number;expectedPerEligibleKill:number|null;conditional:boolean}>}>;
  requirementAlternatives?:Array<{id:string;ready:boolean;branches:RequirementAlternative[];rejected:string[]}>;
  blockers:Array<{id:string;reason:string}>; plans:Array<{goal:string;methods:string[];costGp:number}|{goal:string;blocked:true}>;
};
export const carried=(id:number)=>'carried:'+id;
export const bankFact=(id:number)=>'source-bank:'+id;
const integer=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>=0;
export const sourceCount=(rows:any[]|undefined,id:number)=>(rows??[]).filter(x=>x.id===id&&integer(x.count??1)).reduce((n,x)=>n+Number(x.count??1),0);
export const sourceSkills=(state:LiveState):Record<string,number>=>Object.fromEntries((state.skills??[])
  .filter((x:any)=>typeof x.name==='string'&&integer(x.currentLevel??x.level??x.baseLevel))
  .map((x:any)=>[String(x.name).toLowerCase()==='runecrafting'?'runecraft':String(x.name).toLowerCase(),Number(x.currentLevel??x.level??x.baseLevel)]));
export const sourceFlags=(state:LiveState,cfg:SourceSettings):Record<string,any>=>({
  ...(typeof state.members==='boolean'?{'world.members':state.members}:typeof state.world?.members==='boolean'?{'world.members':state.world.members}:
    typeof cfg.members==='boolean'?{'world.members':cfg.members}:{}),
});
export const exactLocation=(source:SourceCatalogue,id:string,state:LiveState,kind:'loc'|'npc'='loc'):any|undefined=>{
  const loc=source.locations.get(id) as any;if(!loc?.coordinates)return;
  const p=loc.coordinates;if(state.player?.level!==p.plane)return;
  return (kind==='loc'?state.nearbyLocs:state.nearbyNpcs)?.find((e:any)=>e.id===loc.sourceTypeId
    &&(e.x??e.tileX)===p.x&&(e.z??e.tileZ)===p.z&&e.reachable===true);
};
export const atRuneTemple=(source:SourceCatalogue,runeItemId:number,state:LiveState):boolean=>{
  const r=source.runes.get(runeItemId);if(!r?.hasPlacedGenericEntranceAndAltar)return false;
  return r.altarLocationIds.some(id=>{
    const p=source.locations.get(id)?.coordinates;
    return !!p&&state.player?.level===p.plane&&Math.floor(state.player.worldX/64)===Math.floor(p.x/64)
      &&Math.floor(state.player.worldZ/64)===Math.floor(p.z/64);
  });
};
export const templeFact=(runeItemId:number)=>'source-matching-temple:'+runeItemId;
const known=(r:{evidenceStatus:string})=>['source-verified','runtime-verified'].includes(r.evidenceStatus);
const hash=(s:string)=>createHash('sha256').update(s).digest('hex').slice(0,16);

export type RequirementAlternative={prerequisites:Requirement[];missing:Requirement[];ready:boolean};

/** OR -> alternative methods, AND -> shared prerequisites. A failed optional branch is NOT a global blocker. */
export function requirementBranches(req:SourceRequirement|undefined,state:LiveState,cfg:SourceSettings,source:SourceCatalogue):{
  branches:Requirement[][];gaps:string[];alternatives:RequirementAlternative[];rejected:string[]
} {
  const skills=sourceSkills(state),flags=sourceFlags(state,cfg);
  type Result={branches:Requirement[][];rejected:string[]};
  const fail=(reason:string):Result=>({branches:[],rejected:[reason]});
  let visits=0,exhausted=false;
  const visit=(r:SourceRequirement|undefined,depth=0):Result=>{
    if(++visits>1024||depth>16){exhausted=true;return fail('Requirement structure exceeds bounded adapter limit');}
    if(!r)return {branches:[[]],rejected:[]};
    if('all'in r){
      let combinations:Requirement[][]=[[]];const rejected:string[]=[];
      for(const part of r.all){const next=visit(part,depth+1);rejected.push(...next.rejected);
        combinations=combinations.flatMap(a=>next.branches.map(b=>[...a,...b]));
        if(combinations.length>64){exhausted=true;return fail('Requirement alternatives exceed bounded adapter limit');}}
      return {branches:combinations,rejected};
    }
    if('any'in r){
      const parts=r.any.map(x=>visit(x,depth+1)),branches=parts.flatMap(x=>x.branches);
      if(branches.length>64){exhausted=true;return fail('Requirement alternatives exceed bounded adapter limit');}
      return {branches,rejected:parts.flatMap(x=>x.rejected)};
    }
    if('skill'in r)return {branches:[[{fact:'level:'+r.skill,minimum:r.level}]],rejected:[]};
    if('itemId'in r||'itemName'in r){const i='itemId'in r?source.item(r.itemId):source.item(r.itemName);
      if(!i)return fail('Unknown or ambiguous required item');
      // "either" must still be withdrawn before a local executor can use the item; never spend bank stock as inventory.
      return {branches:[[{fact:r.container==='bank'?bankFact(i.id):carried(i.id),minimum:r.quantity}]],rejected:[]};}
    if('coins'in r)return {branches:[[{fact:r.container==='bank'?bankFact(995):carried(995),minimum:r.coins}]],rejected:[]};
    if('flag'in r){if(flags[r.flag]!==undefined&&flags[r.flag]===(r.value??true))return {branches:[[]],rejected:[]};
      return fail('Unverified or unmet flag: '+r.flag);}
    if('fact'in r){let value=state.sourceFacts?.[r.fact];
      // Native equipped identities are rechecked by the executor; an unequipped OR alternative does not poison an inventory alternative.
      const worn=/^worn-item:(\d+)$/.exec(r.fact);if(worn&&Array.isArray(state.equipment))value=sourceCount(state.equipment,Number(worn[1]))>0;
      const equal=r.equals!==undefined?value===r.equals:r.minimum!==undefined?true:value===true;
      if(value!==undefined&&equal&&(r.minimum===undefined||typeof value==='number'&&Number.isFinite(value)&&value>=r.minimum))
        return {branches:[[]],rejected:[]};
      return fail('Unmapped or unmet source predicate: '+r.fact);}
    if('quest'in r){const q=state.quests?.[r.quest];
      if(typeof q==='number'&&q>=(r.stage??1)||q===true&&r.stage===undefined)return {branches:[[]],rejected:[]};
      return fail('Unverified quest: '+r.quest);}
    return fail('Unsupported requirement shape');
  };
  const result=visit(req);
  if(exhausted)return {branches:[],gaps:['Requirement structure/alternatives exceed bounded adapter limit'],alternatives:[],rejected:result.rejected};
  const amount=(p:Requirement):number|undefined=>p.fact.startsWith('level:')?skills[p.fact.slice(6)]:
    p.fact.startsWith('carried:')?Array.isArray(state.inventory)?sourceCount(state.inventory,Number(p.fact.slice(8))):undefined:
    p.fact.startsWith('source-bank:')?state.bank?.isOpen===true&&Array.isArray(state.bank.items)?sourceCount(state.bank.items,Number(p.fact.slice(12))):undefined:undefined;
  const merge=(ps:Requirement[]):Requirement[]=>[...ps.reduce((m,p)=>m.set(p.fact,Math.max(m.get(p.fact)??0,p.minimum)),new Map<string,number>())]
    .map(([fact,minimum])=>({fact,minimum}));
  const alternatives=result.branches.map(ps=>{const prerequisites=merge(ps),missing=prerequisites.filter(p=>amount(p)===undefined||amount(p)!<p.minimum);
    return {prerequisites,missing,ready:missing.length===0};});
  const rejected=[...new Set(result.rejected)];
  if(!alternatives.length)return {branches:[],gaps:rejected.length?rejected:['No usable requirement alternative'],alternatives,rejected};
  if(alternatives.some(x=>x.ready))return {branches:result.branches,gaps:[],alternatives,rejected};
  // Only requirements common to ALL surviving branches may be described as necessary.
  // Their minimum is the least threshold achievable by choosing an alternative, not the highest tool tier.
  const common=alternatives[0]!.prerequisites.filter(p=>alternatives.every(a=>a.prerequisites.some(q=>q.fact===p.fact)))
    .map(p=>({fact:p.fact,minimum:Math.min(...alternatives.map(a=>a.prerequisites.find(q=>q.fact===p.fact)!.minimum))}));
  const gaps:string[]=[];
  for(const pre of common){const observed=amount(pre);if(observed!==undefined&&observed>=pre.minimum)continue;
    if(pre.fact.startsWith('level:')){const skill=pre.fact.slice(6);gaps.push(observed===undefined?'Unknown skill: '+skill:`${skill} requires ${pre.minimum}, observed ${observed}`);}
    else if(pre.fact.startsWith('carried:'))gaps.push(`Missing carried item: ${pre.fact.slice(8)}; requires ${pre.minimum}, observed ${observed??'unknown'}`);
    else if(pre.fact.startsWith('source-bank:'))gaps.push(`Missing bank item: ${pre.fact.slice(12)}; requires ${pre.minimum}, observed ${observed??'unknown'}`);
  }
  if(!gaps.length)gaps.push('No currently satisfied requirement alternative; choose one of the reported branches, not every tool or level.');
  return {branches:result.branches,gaps:[...new Set(gaps)],alternatives,rejected};
}

/** Executor scope is deliberately narrower than the 419 known recipes. */
export function recipeSupport(r:SourceRecipe):string|undefined {
  if(!known(r))return 'source recipe unresolved';
  const sem=r.semantics;
  if(!sem)return 'semantics missing';
  if(sem.conditionalConsumption?.length||sem.requiredCarriedItems?.length||sem.byproducts?.length)
    return 'conditional consumption/byproduct executor not integrated';
  if(sem.capability==='item-on-item')return r.id==='recipe:headless-arrows'||/^recipe:fletch:fletching_(bronze|iron|steel|mithril|adamant|rune)_arrow$/.test(r.id)
    ?undefined:'item-on-item ordering/UI has not been audited for this recipe';
  if(sem.capability==='knife-on-log-select-product')return r.id==='recipe:fletch-shafts:fletching_normal'?undefined:'product-specific fletching UI not integrated';
  if(sem.capability==='smelt-at-furnace')return sem.yield?.kind==='deterministic'?undefined:'stochastic smelting needs a bounded material/attempt policy';
  if(sem.capability==='runecraft-at-matching-altar')return undefined;
  return 'executor not integrated: '+sem.capability;
}

/** Source-defined bow/arrow requirements, not a role restriction or guessed item name. */
export function compatibleSourceArrows(source:SourceCatalogue,state:LiveState):number[] {
  const weapon=(state.equipment??[]).map((e:any)=>source.item(e.id)).find((i:any)=>i?.properties?.metadata?.category==='weapon_bow')
    ??source.item(String(state.combatStyle?.weaponName??''));
  if(weapon?.properties?.metadata?.category!=='weapon_bow')return [];
  const bowLevel=Number((weapon.properties.metadata as any).parameters?.levelrequire),ranged=sourceSkills(state).ranged;
  if(!Number.isFinite(bowLevel)||ranged===undefined||ranged<bowLevel)return [];
  return source.data.items.filter(i=>i.classification==='active'&&/^(bronze|iron|steel|mithril|adamant|rune)_arrow$/.test(i.symbol)
    &&Number((i.properties?.metadata as any)?.parameters?.levelrequire)<=bowLevel).map(i=>i.id);
}

export function buildSourceMethods(source:SourceCatalogue,c:Catalogue,state:LiveState,k:Knowledge,acquisition:AcquisitionMemory|undefined,
  policy:Policy,memory:Memory,cfg:SourceSettings,now:number,preparation?:PreparationOptions):SourceReport {
  const profileId=source.data.profile.id,skills=sourceSkills(state),arrowIds=compatibleSourceArrows(source,state);
  const report:SourceReport={version:'source-catalogue-20260921.1',agent:memory.agent,at:now,tick:state.tick,mode:cfg.mode,profileId,enabled:false,
    counts:{items:source.items.size,recipes:source.recipes.size,routes:source.routes.size},needs:[],dependencyItems:0,truncated:false,registeredMethods:0,alternatives:[],requirementAlternatives:[],blockers:[],plans:[]};
  const deny=(id:string,reason:string)=>{if(report.blockers.length<150&&!report.blockers.some(x=>x.id===id&&x.reason===reason))report.blockers.push({id,reason});};
  if(!Array.isArray(state.inventory)||(state.unavailable??[]).includes('inventory')||!state.player||state.inGame!==true){deny('observation','complete live inventory/player observation required');return report;}
  const reportRequirements=(id:string,requirements:ReturnType<typeof requirementBranches>)=>{
    requirements.gaps.forEach(reason=>deny(id,reason));
    if(report.requirementAlternatives!.length<96&&(requirements.alternatives.length>1||requirements.gaps.length||requirements.rejected.length))
      report.requirementAlternatives!.push({id,ready:requirements.alternatives.some(a=>a.ready),branches:requirements.alternatives,rejected:requirements.rejected});
  };
  const rootIds=new Set<number>();const demand=new Map<number,number>();
  const addNeed=(id:number,qty:number)=>{if(!source.items.has(id)||!Number.isSafeInteger(qty)||qty<1)return;rootIds.add(id);demand.set(id,Math.max(demand.get(id)??0,qty));};
  const carriedArrows=arrowIds.reduce((n,id)=>n+sourceCount(state.inventory,id)+sourceCount(state.equipment,id),0);
  if(arrowIds.length){c.view.facts.arrows=carriedArrows;
    // Replenish in bounded tranches. A shop quote covers ONE purchase, never an entire stock-dependent batch.
    const target=Math.min(policy.ammoTarget,carriedArrows+15);
    if(target>carriedArrows){arrowIds.forEach(id=>addNeed(id,target-carriedArrows));
      c.opportunities=c.opportunities.filter(x=>x.id!=='supply-ammunition');
      c.opportunities.push({id:'source-restock-ammunition',domain:'crafting',target:{fact:'arrows',minimum:target},priority:'maintenance',source:'need',
        reason:'Replenish compatible ammunition from a bounded source-backed acquisition chain.',evidence:['source-profile:'+profileId,'own-state:'+state.tick]});}
    c.methods=c.methods.filter(x=>x.id!=='supply-ammunition');c.tasks.delete('supply-ammunition');}
  const need=acquisition?.need;
  if(need&&!need.optional){const item=need.id!==undefined?source.item(need.id):source.item(need.name);if(item)addNeed(item.id,need.minimum);else deny('item-need','unknown or ambiguous item '+need.name);}
  for(const requested of cfg.requests?.[memory.agent]??[]){const item=source.item(requested.item);if(!item){deny('request','unknown/ambiguous item '+requested.item);continue;}
    const have=sourceCount(state.inventory,item.id),target=Math.min(requested.quantity,have+15);if(have>=target)continue;addNeed(item.id,target);
    c.opportunities.push({id:'source-request:'+item.id,domain:'crafting',target:{fact:carried(item.id),minimum:target},priority:'strategic',source:'need',
      reason:'Operator resource request; satisfy it through existing source-backed methods.',evidence:['source-profile:'+profileId,'operator-resource-request']});}
  const seeds=[...rootIds];
  if(preparation&&rootIds.size){
    // Search other currently learnable activities, not just ancestors of the wanted product.
    const initial=source.dependencies(seeds),required=new Set<string>();
    for(const id of initial.items)for(const recipe of source.recipesFor(id)){
      if(recipeSupport(recipe))continue; // Training can never supply a missing executor.
      const req=requirementBranches(recipe.requirements,state,cfg,source);
      for(const branch of req.branches)for(const p of branch)if(p.fact.startsWith('level:')&&skills[p.fact.slice(6)]!==undefined&&skills[p.fact.slice(6)]!<p.minimum)required.add(p.fact.slice(6));
    }
    const training=source.data.recipes.filter(recipe=>required.has(recipeTrainingSkill(recipe)??'')&&!recipeSupport(recipe)
      &&requirementBranches(recipe.requirements,state,cfg,source).branches.some(b=>b.filter(p=>p.fact.startsWith('level:')).every(p=>skills[p.fact.slice(6)]!==undefined&&skills[p.fact.slice(6)]!>=p.minimum)));
    if(training.length>32)report.truncated=true;
    seeds.push(...training.slice(0,32).map(x=>x.productItemId));
  }
  const closure=source.dependencies(seeds);report.dependencyItems=closure.items.length;report.truncated=report.truncated||closure.truncated;
  // Do not leave an old unverified acquisition shortcut beside its replacement for the same dependency.
  if(need&&rootIds.size){c.methods=c.methods.filter(m=>!m.id.startsWith('acquire:'));for(const id of [...c.tasks.keys()])if(id.startsWith('acquire:'))c.tasks.delete(id);}
  const bank=state.bank?.isOpen===true?state.bank.items??[]:k.bank;
  for(const id of closure.items){c.view.facts[carried(id)]=sourceCount(state.inventory,id);c.view.facts[bankFact(id)]=sourceCount(bank,id);}
  c.view.facts[carried(995)]=sourceCount(state.inventory,995);c.view.facts[bankFact(995)]=sourceCount(bank,995);
  for(const [skill,level] of Object.entries(skills))c.view.facts['level:'+skill]=level;
  for(const id of rootIds)report.needs.push({itemId:id,name:source.item(id)!.name,target:demand.get(id)!});
  const effect=(id:number,qty:number)=>{
    const result:Record<string,number>={[carried(id)]:qty,['carried:name:'+itemName(source.item(id)!.name)]:qty};
    if(need&&(need.id===id||need.id===undefined&&source.item(need.name)?.id===id))result[itemFact(need)]=qty;
    if(arrowIds.includes(id))result.arrows=qty;if(id===995)result.coins=qty;return result;
  };
  const add=(key:string,t:Omit<SourceTask,'profileId'>,effects:Record<string,number>,prerequisites:Requirement[]=[],consumes:Record<string,number>={},costGp=0,durationMs=3000)=>{
    const id='source:'+profileId+':'+key;
    const m:Method={id,capability:'acquisition',domain:'crafting',prerequisites,consumes,effects,costGp,lossBoundGp:0,risk:'safe',durationMs};
    const taskRecipe=t.recipeId?source.recipes.get(t.recipeId):undefined;
    const activity=t.kind==='gather'?(source.routes.get(t.routeId!)?.interaction?.action==='mine-observed-rock'?'mining':'woodcutting'):
      taskRecipe?.semantics?.capability==='smelt-at-furnace'?'smithing':taskRecipe?.semantics?.capability==='runecraft-at-matching-altar'?'runecraft':taskRecipe?'fletching':undefined;
    if(activity)m.effects['xp:'+activity]=1; // Legacy activity flag is never accepted by the training forecast.
    if(preparation&&taskRecipe)recipeXp(m,taskRecipe,t.batch??1,preparation);
    c.methods.push(m);c.tasks.set(id,{id,kind:'acquisition',sourceResource:{...t,profileId}} as Task);report.registeredMethods++;
  };
  if(!c.view.capabilities.includes('acquisition'))c.view.capabilities.push('acquisition');
  for(const id of closure.items){const item=source.item(id)!;const routes=source.sourcesFor(id),recipes=source.recipesFor(id);
    report.alternatives.push({itemId:id,name:item.name,methods:routes.reduce((a,r)=>(a[r.method]=(a[r.method]??0)+1,a),{} as Record<string,number>),recipes:recipes.map(x=>x.id),
      drops:routes.filter(x=>x.method==='monster-drop').slice(0,8).map(r=>({routeId:r.id,npcId:r.actor?.id,expectedPerEligibleKill:expectedDropQuantity(r),conditional:!!r.semantics?.conditions?.length}))});
    if(sourceCount(bank,id)>0){const quantities=[...new Set([1,Math.min(sourceCount(bank,id),Math.max(demand.get(id)??15,15))])];
      for(const quantity of quantities)add('bank:'+id+':'+quantity,{kind:'bank',itemId:id,quantity},effect(id,quantity),[],{[bankFact(id)]:quantity},0,state.bank?.isOpen?1500:15000);}
    const stock=state.shop?.isOpen===true?state.shop.shopItems?.find((x:any)=>x.id===id&&x.count>0):undefined;
    if(stock){if(Number.isSafeInteger(stock.buyPrice)&&stock.buyPrice>0)add('buy:'+id,{kind:'shop',itemId:id,quantity:1,expectedPrice:stock.buyPrice},effect(id,1),[],{[carried(995)]:stock.buyPrice},stock.buyPrice,1500);
      else deny('shop:'+id,'live price unknown or invalid; it is not zero');}
    else if(routes.some(r=>r.method==='shop-purchase'))deny('shop:'+id,'open the merchant and observe stock/price; remote shop exploration is not dispatched by this pilot');
    for(const ground of (state.groundItems??[]).filter((x:any)=>x.id===id&&x.reachable===true&&Number.isInteger(x.x??x.tileX)&&Number.isInteger(x.z??x.tileZ)).slice(0,2)) {
      const quantity=sourceCount([ground],id);if(quantity>0)add('pickup:'+id+':'+(ground.x??ground.tileX)+':'+(ground.z??ground.tileZ),
        {kind:'pickup',itemId:id,quantity,locationId:`observed:${ground.x??ground.tileX}:${ground.z??ground.tileZ}`},effect(id,quantity));}
    for(const route of routes.filter(x=>x.method==='gathering')) {
      if(!known(route)){deny(route.id,'gathering source conditions unresolved');continue;}
      const action=route.interaction?.action;
      if(!['mine-observed-rock','chop-observed-tree'].includes(action??'')){deny(route.id,'gathering executor not integrated');continue;}
      const locationId=(route.locationIds??[]).find(l=>exactLocation(source,l,state));
      if(!locationId){deny(route.id,'no matching resource placement is currently observed and reachable');continue;}
      const requirements=requirementBranches(route.requirements,state,cfg,source);
      reportRequirements(route.id,requirements);
      for(const [n,prereqs] of requirements.branches.entries())add('gather:'+hash(route.id)+':'+n,{kind:'gather',routeId:route.id,locationId,itemId:id,quantity:1},effect(id,1),prereqs,{},0,6000);
    }
    if(routes.some(r=>r.method==='monster-drop'))deny('loot:'+id,'drop alternatives indexed; new combat/ownership/stochastic-budget adapter is not enabled in the local pilot');
    for(const recipe of recipes){const unsupported=recipeSupport(recipe);if(unsupported){deny(recipe.id,unsupported);continue;}
      const requirements=requirementBranches(recipe.requirements,state,cfg,source);reportRequirements(recipe.id,requirements);
      if(!requirements.branches.length)continue;
      const sem=recipe.semantics!,per=recipeYield(recipe,source,skills);if(per===null){deny(recipe.id,'yield unknown, stochastic, or inaccessible rune relationship');continue;}
      let locationId:string|undefined,prerequisite:Requirement|undefined;
      if(sem.capability==='smelt-at-furnace') {
        // Only the ordinary furnace already supported in src/economy/metalworking.ts; no Fremennik/quest furnace guesses.
        locationId=recipe.locationIds?.find(l=>(source.locations.get(l) as any)?.sourceTypeId===2781&&exactLocation(source,l,state));
        if(!locationId){deny(recipe.id,'ordinary furnace is not currently observed and reachable');continue;}
      }
      if(sem.capability==='runecraft-at-matching-altar') {
        const rune=source.runes.get(id)!;const inside=atRuneTemple(source,id,state);
        c.view.facts[templeFact(id)]=Number(inside);
        const entrance=rune.entranceLocationIds.find(l=>exactLocation(source,l,state));
        if(!inside&&!entrance){deny(recipe.id,'matching ruins or temple must first be personally observed');continue;}
        locationId=rune.altarLocationIds[0];if(!locationId){deny(recipe.id,'inner altar placement unresolved');continue;}
        if(!inside&&entrance)add('enter-rune:'+id,{kind:'rune-entry',itemId:id,quantity:0,locationId:entrance,runeItemId:id},
          {[templeFact(id)]:1},[{fact:carried(rune.talismanItemId),minimum:1},...requirements.branches[0]!],{},0,4500);
        prerequisite={fact:templeFact(id),minimum:1};
      }
      const possible=sem.maxBatch?Math.min(sem.maxBatch,...recipe.inputs.map(i=>Math.floor(sourceCount(state.inventory,i.itemId!)/i.quantity))):1;
      const runeCount=sem.processingMode==='all-carried-essence'?sourceCount(state.inventory,recipe.inputs[0]!.itemId!):undefined;
      const batches=[...new Set(sem.processingMode==='all-carried-essence'?[Math.max(1,runeCount!)]:sem.maxBatch?(possible>0?[possible]:[sem.maxBatch,1]):[1])];
      for(const batch of batches)for(const [n,reqs] of requirements.branches.entries()) {
        const consumes:Record<string,number>={};for(const i of recipe.inputs)consumes[carried(i.itemId!)]=(consumes[carried(i.itemId!)]??0)+i.quantity*batch;
        const tools=(recipe.tools??[]).map(x=>({fact:carried(x.itemId!),minimum:x.quantity}));
        add('recipe:'+hash(recipe.id)+':'+batch+':'+n,{kind:'recipe',recipeId:recipe.id,itemId:id,quantity:per*batch,batch,locationId},
          effect(id,per*batch),[...reqs,...tools,...(prerequisite?[prerequisite]:[])],consumes,0,sem.capability==='runecraft-at-matching-altar'?6000:3000+(sem.maxBatch?sem.maxBatch-batch:0));
      }
    }
  }
  return report;
}
