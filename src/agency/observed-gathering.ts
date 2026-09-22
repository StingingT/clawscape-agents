import { harvestLevel } from '../runtime-policy.ts';

export type ObservedGatherAction={id:string;type:'interactLoc';fields:{x:number;z:number;locId:number;optionIndex:number};waitTicks:number};
export type ObservedGatheringToolNeed={tool:'axe'|'pickaxe';action:'chop'|'mine'};

/**
 * A resource action can reveal a missing *category* of prerequisite without
 * claiming where that prerequisite comes from.  Callers still need an own
 * observed bank/shop/ground source before turning this into an item request.
 * This keeps a blocked tree or rock useful as evidence, rather than silently
 * treating it as a failed gathering route.
 */
export function observedMissingGatheringTool(state:any):ObservedGatheringToolNeed|undefined {
  const carried=[...(state.inventory??[]),...(state.equipment??[])];
  const has=(pattern:RegExp)=>carried.some((item:any)=>pattern.test(String(item?.name??'')));
  const nearby=(state.nearbyLocs??[]).filter((loc:any)=>loc?.reachable===true);
  const chop=nearby.some((loc:any)=>(loc.optionsWithIndex??[]).some((o:any)=>/chop/i.test(String(o?.text??''))));
  if(chop&&!has(/\b(?:axe|hatchet)\b/i)&&!has(/battleaxe/i))return {tool:'axe',action:'chop'};
  const mine=nearby.some((loc:any)=>(loc.optionsWithIndex??[]).some((o:any)=>/mine/i.test(String(o?.text??''))));
  if(mine&&!has(/pickaxe/i))return {tool:'pickaxe',action:'mine'};
}

/** Create only actions justified by the current local observation.  A tool is
 * required only for the observed discipline that genuinely needs it; this is
 * deliberately not a map, NPC, or character-specific fallback. */
export function observedGatheringActions(state:any,woodcutting:number,capacity=28):ObservedGatherAction[] {
  if((state.inventory?.length??0)>=capacity)return [];
  const carried=[...(state.inventory??[]),...(state.equipment??[])];
  const has=(pattern:RegExp)=>carried.some((item:any)=>pattern.test(String(item?.name??'')));
  const result:ObservedGatherAction[]=[];
  for(const loc of state.nearbyLocs??[]) {
    if(loc?.reachable!==true||![loc.x,loc.z,loc.id].every(Number.isInteger))continue;
    const option=(loc.optionsWithIndex??[]).find((o:any)=>/chop|mine|fish|thieve|steal/i.test(String(o?.text??''))&&Number.isInteger(o?.opIndex));
    if(!option)continue;
    const text=String(option.text),name=String(loc.name??'');
    if(/chop/i.test(text)&&(!has(/\baxe\b/i)||harvestLevel(name)>woodcutting))continue;
    if(/mine/i.test(text)&&!has(/pickaxe/i))continue;
    result.push({id:`observed-gather-${text.toLowerCase().replace(/[^a-z]+/g,'-')}-${loc.id}-${loc.x}-${loc.z}`,
      type:'interactLoc',fields:{x:loc.x,z:loc.z,locId:loc.id,optionIndex:option.opIndex},waitTicks:5});
  }
  return result.sort((a,b)=>Number((state.nearbyLocs??[]).find((l:any)=>l.id===a.fields.locId&&l.x===a.fields.x&&l.z===a.fields.z)?.distance??99)
    -Number((state.nearbyLocs??[]).find((l:any)=>l.id===b.fields.locId&&l.x===b.fields.x&&l.z===b.fields.z)?.distance??99));
}

/** A generic gathering batch is actionable only when this observation exposes
 * either a safe resource action or a concrete missing tool category.  This
 * prevents a planner from inventing a "gathering" objective while standing
 * somewhere with no known resource, while still allowing a tree/rock to
 * create an evidence-backed preparation request. */
export function observedGatheringAffordance(state:any,woodcutting:number,capacity=28):boolean {
  return observedGatheringActions(state,woodcutting,capacity).length>0
    || observedMissingGatheringTool(state)!==undefined;
}
