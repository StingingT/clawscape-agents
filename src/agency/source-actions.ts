/** Concrete local pilot. Every packet binds fresh item slots and observed targets. */
import type { LiveCandidate } from './live-adapter.ts';
import type { LiveState } from './world-model.ts';
import type { SourceCatalogue } from '../catalog/source-catalogue.ts';
import { recipeYield } from '../catalog/source-catalogue.ts';
import { carried, bankFact, sourceCount, sourceSkills, sourceFlags, exactLocation, atRuneTemple,
  requirementBranches, recipeSupport, type SourceTask, type SourceSettings } from './source-methods.ts';

export type SourcePort={bank:(state:any)=>LiveCandidate[];route:(p:{x:number;z:number;level:number})=>Promise<{status:string;destination?:{x:number;z:number;level:number};reason?:string}>};
export type SourceDialog={recipeId:string;lifeId:unknown;at:number};
export type SourceActionResult={actions:LiveCandidate[];reason?:string};
const no=(reason:string):SourceActionResult=>({actions:[],reason});
const total=(state:LiveState,id:number)=>sourceCount(state.inventory,id);
const row=(state:LiveState,id:number)=>state.inventory?.find((x:any)=>x.id===id&&Number.isInteger(x.slot)&&x.count>0);
const option=(entity:any,regex:RegExp)=>(entity?.optionsWithIndex??[]).find((x:any)=>Number.isInteger(x.opIndex)&&regex.test(String(x.text)));
const norm=(x:string)=>x.toLowerCase().replace(/[.!]/g,'').replace(/\s+/g,' ').trim().replace(/shafts$/,'shaft');
export function hasOutputSpace(source:SourceCatalogue,state:LiveState,consumes:Array<{itemId:number;quantity:number}>,itemId:number,quantity:number):boolean {
  if(!Array.isArray(state.inventory)||!Number.isInteger(quantity)||quantity<1)return false;
  const balances=new Map<number,number>();for(const c of consumes)balances.set(c.itemId,(balances.get(c.itemId)??0)+c.quantity);
  let freed=0;
  for(const r of state.inventory){const remaining=balances.get(r.id)??0,used=Math.min(remaining,Number(r.count??1));
    if(used>=Number(r.count??1))freed++;balances.set(r.id,remaining-used);}
  const stillPresent=total(state,itemId)-(consumes.filter(x=>x.itemId===itemId).reduce((n,x)=>n+x.quantity,0))>0;
  const slots=source.item(itemId)?.properties?.stackable===true?(stillPresent?0:1):quantity;
  return (state.capacity??28)-state.inventory.length+freed>=slots;
}
function requirementsReady(source:SourceCatalogue,req:any,state:LiveState,cfg:SourceSettings):boolean {
  const branches=requirementBranches(req,state,cfg,source).branches,skills=sourceSkills(state);
  return branches.some(b=>b.every(r=>{
    const skill=r.fact.startsWith('level:')?skills[r.fact.slice(6)]:undefined;
    const amount=skill??(r.fact.startsWith('carried:')?total(state,Number(r.fact.slice(8))):r.fact.startsWith('source-bank:')&&state.bank?.isOpen?sourceCount(state.bank.items,Number(r.fact.slice(12))):undefined);
    return amount!==undefined&&amount>=r.minimum;
  }));
}
export async function sourceActions(source:SourceCatalogue,t:SourceTask,state:LiveState,cfg:SourceSettings,port:SourcePort,dialog:SourceDialog|undefined,now:number):Promise<SourceActionResult> {
  if(t.profileId!==source.data.profile.id)return no('Source task/profile mismatch');
  if(state.inGame!==true||state.player?.isDead||state.player?.combat?.inCombat===true||!Array.isArray(state.inventory)||(state.unavailable??[]).includes('inventory'))
    return no('Fresh, living, out-of-combat player and inventory required');
  const emit=(type:string,fields:Record<string,any>={},waitTicks=2):SourceActionResult=>({actions:[{id:'source-action:'+t.kind+':'+(t.recipeId??t.routeId??t.itemId)+':'+type,type,fields,waitTicks}]});
  if(t.kind!=='bank'&&state.bank?.isOpen===true)return emit('closeModal');
  if(t.kind!=='shop'&&state.shop?.isOpen===true)return emit('closeShop');
  if(t.kind==='bank') {
    if(state.shop?.isOpen===true)return emit('closeShop');
    if(state.bank?.isOpen!==true)return {actions:port.bank(state)};
    const r=state.bank.items?.find((x:any)=>x.id===t.itemId&&x.count>=t.quantity&&Number.isInteger(x.slot));
    if(!r)return no('Fresh bank lacks the planned quantity');
    return hasOutputSpace(source,state,[],t.itemId,t.quantity)?emit('bankWithdraw',{slot:r.slot,amount:t.quantity}):no('Bank withdrawal would exceed inventory capacity');
  }
  if(t.kind==='shop') {
    const r=state.shop?.isOpen===true?state.shop.shopItems?.find((x:any)=>x.id===t.itemId&&x.count>0&&Number.isInteger(x.slot)):undefined;
    if(!r||!Number.isSafeInteger(r.buyPrice)||r.buyPrice<=0||r.buyPrice!==t.expectedPrice)return no('Fresh stock and unchanged positive single-unit quote required');
    if(t.quantity!==1||total(state,995)<r.buyPrice)return no('A single-unit purchase must be affordable from carried coins');
    return hasOutputSpace(source,state,[{itemId:995,quantity:r.buyPrice}],t.itemId,1)?emit('shopBuy',{slot:r.slot,amount:1}):no('Purchase would exceed inventory capacity');
  }
  if(t.kind==='pickup') {
    const r=state.groundItems?.find((x:any)=>x.id===t.itemId&&x.reachable===true&&`observed:${x.x??x.tileX}:${x.z??x.tileZ}`===t.locationId);
    if(!r||Number(r.count??1)!==t.quantity)return no('Ground item location or quantity changed; replan');
    return hasOutputSpace(source,state,[],t.itemId,t.quantity)?emit('pickupItem',{itemId:r.id,x:r.x??r.tileX,z:r.z??r.tileZ}):no('Pickup would exceed inventory capacity');
  }
  if(t.kind==='gather') {
    const r=t.routeId&&source.routes.get(t.routeId),loc=t.locationId&&exactLocation(source,t.locationId,state);
    if(!r||!loc||!requirementsReady(source,r.requirements,state,cfg))return no('Observed resource, skill or usable tool requirement missing');
    const op=option(loc,r.interaction?.action==='mine-observed-rock'?/^mine$/i:/^chop(?:[- ]down)?$/i);
    if(!op||!hasOutputSpace(source,state,[],t.itemId,1))return no('Observed gathering option or inventory space missing');
    return emit('interactLoc',{locId:loc.id,x:loc.x,z:loc.z,optionIndex:op.opIndex},5);
  }
  if(t.kind==='rune-entry') {
    const rune=source.runes.get(t.itemId),loc=t.locationId&&exactLocation(source,t.locationId,state);
    if(!rune?.hasPlacedGenericEntranceAndAltar||!loc||!rune.entranceLocationIds.includes(t.locationId!))return no('Matching source-backed ruins are not observed');
    if(rune.members&&sourceFlags(state,cfg)['world.members']!==true)return no('Members-world status not verified');
    const talisman=row(state,rune.talismanItemId);if(!talisman)return no('Matching reusable talisman must be carried');
    return emit('useItemOnLoc',{itemSlot:talisman.slot,locId:loc.id,x:loc.x,z:loc.z},4);
  }
  const recipe=t.recipeId&&source.recipes.get(t.recipeId);
  if(!recipe||recipe.productItemId!==t.itemId||recipeSupport(recipe)||!requirementsReady(source,recipe.requirements,state,cfg))return no('Recipe requirements or supported executor changed');
  if((recipe.tools??[]).some(x=>total(state,x.itemId!)<x.quantity))return no('Reusable tool missing from current inventory');
  const sem=recipe.semantics!,per=recipeYield(recipe,source,sourceSkills(state));if(per===null)return no('Deterministic supported recipe yield required');
  let batch=1;
  if(sem.maxBatch)batch=Math.min(sem.maxBatch,...recipe.inputs.map(x=>Math.floor(total(state,x.itemId!)/x.quantity)));
  if(sem.processingMode==='all-carried-essence')batch=total(state,recipe.inputs[0]!.itemId!);
  if(batch<1||batch!==t.batch||per*batch!==t.quantity)return no('Actual automatic batch changed; replan without spending unreserved inputs');
  const consumes=recipe.inputs.map(x=>({itemId:x.itemId!,quantity:x.quantity*batch}));
  if(consumes.some(x=>total(state,x.itemId)<x.quantity))return no('Recipe input missing from current inventory');
  if(!hasOutputSpace(source,state,consumes,t.itemId,t.quantity))return no('Recipe output would exceed inventory capacity');
  if(state.dialog?.isOpen===true||state.interface?.isOpen===true||state.modalOpen===true) {
    if(sem.capability!=='knife-on-log-select-product'||dialog?.recipeId!==recipe.id||dialog.lifeId!==state.player.lifeId||now-dialog.at>60_000)
      return no('Unrelated or stale production interface; no arbitrary choice is authorized');
    const expected=norm(source.item(recipe.productItemId)!.name);
    const options=(state.dialog?.options??[]).filter((o:any)=>Number.isInteger(o.index)&&norm(String(o.text))===expected);
    if(options.length!==1)return no('A single exact Arrow Shafts dialogue option is required; component-only interfaces remain unsupported');
    return emit('clickDialogOption',{optionIndex:options[0].index},4);
  }
  if(sem.capability==='item-on-item') {
    // These audited arrow handlers accept input #2 used on input #1; no fuzzy names or guessed slots.
    const a=row(state,recipe.inputs[1]!.itemId!),b=row(state,recipe.inputs[0]!.itemId!);
    if(!a||!b||a.slot===b.slot)return no('Distinct observed arrow ingredients required');
    return emit('useItemOnItem',{sourceSlot:a.slot,targetSlot:b.slot},3);
  }
  if(sem.capability==='knife-on-log-select-product') {
    const tool=row(state,recipe.tools![0]!.itemId!),input=row(state,recipe.inputs[0]!.itemId!);
    return tool&&input?emit('useItemOnItem',{sourceSlot:tool.slot,targetSlot:input.slot},3):no('Knife/log slots unavailable');
  }
  if(sem.capability==='smelt-at-furnace') {
    const loc=t.locationId&&exactLocation(source,t.locationId,state);
    if(!loc||loc.id!==2781)return no('Ordinary source-matched furnace not observed');
    const primary=row(state,recipe.inputs[0]!.itemId!);if(!primary)return no('Primary ore missing');
    let symbol=(source.item(primary.id)?.properties?.metadata as any)?.parameters?.smeltsto;
    if(primary.id===440&&total(state,453)>=2&&(sourceSkills(state).smithing??0)>=30||primary.id===453)symbol='steel_bar';
    if(symbol!==source.item(recipe.productItemId)?.symbol)return no('Item-on-furnace chooses a different product for this inventory; interface adapter required');
    return emit('useItemOnLoc',{itemSlot:primary.slot,locId:loc.id,x:loc.x,z:loc.z},5);
  }
  if(sem.capability==='runecraft-at-matching-altar') {
    const rune=source.runes.get(recipe.productItemId);
    if(!rune||!atRuneTemple(source,rune.runeItemId,state)||!t.locationId||!rune.altarLocationIds.includes(t.locationId))return no('Matching inner temple required');
    const loc=exactLocation(source,t.locationId,state),op=option(loc,/^craft[- ]?rune(?:s)?$/i);
    if(loc&&op)return emit('interactLoc',{locId:loc.id,x:loc.x,z:loc.z,optionIndex:op.opIndex},5);
    const p=source.locations.get(t.locationId)?.coordinates;if(!p)return no('Inner altar placement missing');
    const path=await port.route({x:p.x,z:p.z,level:p.plane});
    if(path.status==='ready'&&path.destination)return emit('walkTo',{...path.destination},3);
    return no(path.reason??'Matching altar approach is not yet collision-validated');
  }
  return no('No audited executor for this source recipe');
}
