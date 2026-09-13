type ActionLike = { id:string; type:string; fields?:Record<string,unknown> };

const total = (items:any[]|undefined,id:number|string) => (items??[]).filter(i=>String(i.id)===String(id)).reduce((n,i)=>n+Number(i.count??1),0);
const skillXp = (state:any) => JSON.stringify((state.skills??[]).map((s:any)=>[s.name,s.experience??s.xp??0]).sort());
const itemState = (state:any) => JSON.stringify([state.inventory??[],state.equipment??[]].flat().map((i:any)=>[i.id,i.slot,i.count??1]).sort());
const position = (state:any) => `${state.player?.worldX}:${state.player?.worldZ}:${state.player?.level}:${state.player?.lifeId}`;

export type ActionVerification = { verified:boolean; evidence:string[]; uncertain:boolean; reason?:string };

export function verifyActionOutcome(before:any, after:any, action:ActionLike, result?:any):ActionVerification {
  const evidence:string[]=[];
  const changedItems=itemState(before)!==itemState(after);
  const changedXp=skillXp(before)!==skillXp(after);
  const moved=position(before)!==position(after);
  const type=action.type;

  if(type==='wait') return {verified:changedItems||changedXp,uncertain:false,evidence:[...(changedItems?['inventory/equipment changed']:[]),...(changedXp?['skill XP changed']:[])],reason:'clock advancement alone is not an outcome'};
  if(type==='scanNearbyLocs') return {verified:JSON.stringify(before.nearbyNpcs??[])!==JSON.stringify(after.nearbyNpcs??[])||JSON.stringify(before.nearbyLocs??[])!==JSON.stringify(after.nearbyLocs??[]),uncertain:false,evidence:['observation refreshed'],reason:'scan requires changed observation evidence'};
  if(type==='walkTo') return {verified:moved||result?.navigation?.status==='arrived',uncertain:false,evidence:[...(moved?['position changed']:[]),...(result?.navigation?.status==='arrived'?['verified arrival']:[])],reason:'navigation requires movement or verified arrival'};
  if(type==='bankDeposit'||type==='bankWithdraw') {
    const id=before.inventory?.find((i:any)=>i.slot===action.fields?.slot)?.id ?? before.bank?.items?.find((i:any)=>i.slot===action.fields?.slot)?.id;
    const invDelta=id===undefined?0:total(after.inventory,id)-total(before.inventory,id);
    const bankDelta=id===undefined?0:total(after.bank?.items,id)-total(before.bank?.items,id);
    const good=before.bank?.isOpen===true&&after.bank?.isOpen===true&&((type==='bankDeposit'&&bankDelta>0&&invDelta<0)||(type==='bankWithdraw'&&invDelta>0&&bankDelta<0));
    return {verified:good,uncertain:!good,evidence:good?[`item ${id} inventory/bank delta verified`]:[],reason:good?undefined:'bank transfer effect not verified'};
  }
  if(type==='shopBuy'||type==='shopSell') {
    const coinsBefore=total(before.inventory,'coins'),coinsAfter=total(after.inventory,'coins');
    const good=changedItems&&coinsBefore!==coinsAfter;
    return {verified:good,uncertain:!good,evidence:good?['shop item and coin deltas observed']:[],reason:good?undefined:'shop purchase/sale effect not verified'};
  }
  if(type==='interactLoc' && /^(economy-|gather-safe|chop-|mine-|fish-|cook-|smelt-|smith-|fletch-)/i.test(action.id)) {
    return {verified:changedItems||changedXp,uncertain:false,evidence:[...(changedItems?['resource state changed']:[]),...(changedXp?['skill XP changed']:[])],reason:'resource action requires output or XP'};
  }
  if(/attack|combat|train/i.test(action.id)||type==='interactNpc') {
    const combat=Boolean(after.player?.combat?.inCombat)||changedXp||changedItems||Number(after.player?.combat?.targetIndex)!==Number(before.player?.combat?.targetIndex);
    return {verified:combat,uncertain:false,evidence:combat?['combat engagement or effect observed']:[],reason:'combat requires engagement, XP, loot, or target effect'};
  }
  if(type==='closeModal'||type==='closeShop') {
    const closed=(before.modalOpen===true||before.shop?.isOpen===true||before.bank?.isOpen===true) && after.modalOpen!==true && after.shop?.isOpen!==true && after.bank?.isOpen!==true;
    return {verified:closed,uncertain:false,evidence:closed?['interface closed']:[],reason:'interface state did not change'};
  }
  if(type==='useInventoryItem'||type==='equip') return {verified:changedItems,uncertain:false,evidence:changedItems?['inventory/equipment changed']:[],reason:'equipment state did not change'};
  return {verified:changedItems||changedXp||moved,uncertain:false,evidence:[...(changedItems?['inventory/equipment changed']:[]),...(changedXp?['skill XP changed']:[]),...(moved?['position changed']:[])],reason:'no action-specific effect contract'};
}
