/** Item identity belongs to the plan; slots belong only to the next packet. */
export type ItemRef = {
  field: 'slot' | 'sourceSlot' | 'itemSlot' | 'targetSlot';
  container: 'inventory' | 'bank' | 'shop';
  id: number; name: string; minimum: number; option?: string;
};
export type ItemAction = { type:string; fields?:Record<string,any>; itemRefs?:ItemRef[] };
export type ItemNeed = { id?:number; name:string; minimum:number };
export class MissingItem extends Error {
  need:ItemNeed;
  constructor(need:ItemNeed) { super('REQUIRED_ITEM_MISSING: '+need.name); this.need=need; }
}
export const itemName=(value:unknown)=>String(value??'').trim().toLowerCase().replace(/_/g,' ').replace(/\s+/g,' ')
  .replace(/^feathers$/,'feather').replace(/^arrow shafts$/,'arrow shaft').replace(/^headless arrows$/,'headless arrow')
  .replace(/^((?:bronze|iron|steel|mithril|adamant|rune) arrow)s$/,'$1');
export const itemMatches=(row:any,need:ItemNeed)=>need.id!==undefined?row?.id===need.id:itemName(row?.name)===itemName(need.name);
export const itemCount=(rows:any[]|undefined,need:ItemNeed)=>(rows??[]).filter(i=>itemMatches(i,need)).reduce((n,i)=>n+Number(i.count??1),0);
export const itemFact=(need:ItemNeed)=>'carried:'+ (need.id!==undefined?need.id:'name:'+itemName(need.name));
const rows=(s:any,container:ItemRef['container'])=>container==='bank'?(s.bank?.isOpen===true?s.bank.items:undefined):container==='shop'?(s.shop?.isOpen===true?s.shop.shopItems:undefined):s.inventory;
const specs=(a:ItemAction):Array<[ItemRef['field'],ItemRef['container']]> => {
  if(a.type==='useItemOnItem')return [[a.fields?.sourceSlot!==undefined?'sourceSlot':'itemSlot','inventory'],['targetSlot','inventory']];
  if(a.type==='useItemOnLoc'||a.type==='useItemOnNpc')return [[a.fields?.itemSlot!==undefined?'itemSlot':'sourceSlot','inventory']];
  if(a.type==='bankWithdraw')return [['slot','bank']];
  if(a.type==='shopBuy')return [['slot','shop']];
  return ['useInventoryItem','equip','bankDeposit','shopSell'].includes(a.type)?[['slot','inventory']]:[];
};
function checkRows(s:any,container:ItemRef['container']):any[] {
  const list=rows(s,container);
  if(!Array.isArray(list)||list.some(i=>!Number.isInteger(i.slot)||i.slot<0||!Number.isInteger(i.id)||i.id<0||!Number.isSafeInteger(i.count??1)||(i.count??1)<(container==='inventory'?1:0))
    || new Set(list.map(i=>i.slot)).size!==list.length)throw new Error('COMPLETE_UNAMBIGUOUS_ITEM_OBSERVATION_REQUIRED');
  return list;
}
/** Capture identities at candidate selection, never by interpreting an action's prose ID. */
export function bindItems<T extends ItemAction>(action:T,state:any):T {
  const required=specs(action);if(!required.length)return structuredClone(action);
  if(action.itemRefs)return resolveItems(action,state);
  const refs=required.map(([field,container]):ItemRef=>{
    const slot=action.fields?.[field];
    const row=checkRows(state,container).find(i=>i.slot===slot);
    if(!Number.isInteger(slot)||!row)throw new Error('ITEM_REFERENCE_INVALID_BEFORE_DISPATCH: '+field);
    const explicit=field==='targetSlot'?action.fields?.targetItemId:action.fields?.expectedItemId??action.fields?.itemId;
    if(explicit!==undefined&&explicit!==row.id)throw new Error('ITEM_IDENTITY_MISMATCH');
    const minimum=['bankWithdraw','bankDeposit','shopBuy','shopSell'].includes(action.type)&&Number(action.fields?.amount)>0?Number(action.fields!.amount):1;
    if(!Number.isSafeInteger(minimum)||minimum<1)throw new Error('INVALID_ITEM_QUANTITY');
    const option=action.type==='useInventoryItem'?(row.optionsWithIndex??[]).find((o:any)=>o.opIndex===action.fields?.optionIndex)?.text:undefined;
    if(action.type==='useInventoryItem'&&typeof option!=='string')throw new Error('ITEM_OPTION_CHANGED');
    return {field,container,id:row.id,name:String(row.name??row.id),minimum,option};
  });
  return resolveItems({...structuredClone(action),itemRefs:refs},state);
}
/** Resolve the same identities anywhere in a fresh inventory. Never mutate an old receipt. */
export function resolveItems<T extends ItemAction>(action:T,state:any):T {
  const required=specs(action), refs=action.itemRefs;
  if(!required.length)return structuredClone(action);
  if(!refs||refs.length!==required.length||required.some(([f,c])=>refs.filter(r=>r.field===f&&r.container===c).length!==1))throw new Error('BOUND_ITEM_IDENTITIES_REQUIRED');
  const result=structuredClone(action);result.fields={...result.fields};
  for(const ref of refs) {
    if(!Number.isInteger(ref.id)||ref.id<0||!Number.isSafeInteger(ref.minimum)||ref.minimum<1)throw new Error('INVALID_BOUND_ITEM');
    const matching=checkRows(state,ref.container).filter(i=>i.id===ref.id&&Number(i.count??1)>=ref.minimum)
      .sort((a,b)=>Number(b.slot===action.fields?.[ref.field])-Number(a.slot===action.fields?.[ref.field])||a.slot-b.slot);
    const row=matching[0];
    if(!row)throw new MissingItem({id:ref.id,name:ref.name,minimum:ref.minimum});
    result.fields[ref.field]=row.slot;
    if(ref.option!==undefined){
      const op=(row.optionsWithIndex??[]).find((o:any)=>itemName(o.text)===itemName(ref.option));
      if(!Number.isInteger(op?.opIndex))throw new Error('ITEM_OPTION_CHANGED');
      result.fields.optionIndex=op.opIndex;
    }
  }
  if(result.type==='useItemOnItem'&&(result.fields.sourceSlot??result.fields.itemSlot)===result.fields.targetSlot)throw new Error('DISTINCT_RECIPE_INPUTS_REQUIRED');
  return result;
}
/** A known old failure mode: an empty target slot, not an unknown quest-item recipe.
 * Permits abandoning only this invalid tool/empty-slot context after quiescence.
 * It proves neither success nor non-execution; future recipes need their own identities. */
export function obsoleteEmptyRecipe(action:ItemAction,before:any,after:any):boolean {
  if(action.type!=='useItemOnItem'||action.itemRefs)return false;
  const f=action.fields??{},source=f.sourceSlot??f.itemSlot,target=f.targetSlot;
  if(!Number.isInteger(source)||!Number.isInteger(target)||source===target||target<0||target>=28)return false;
  try {
    const a=checkRows(before,'inventory'),b=checkRows(after,'inventory');
    const tool=a.find(i=>i.slot===source);
    return !!tool&&((tool.id===946&&itemName(tool.name)==='knife')||(tool.id===590&&itemName(tool.name)==='tinderbox'))
      && !a.some(i=>i.slot===target)&&!b.some(i=>i.slot===target)
      && !(before.unavailable??[]).includes('inventory')&&!(after.unavailable??[]).includes('inventory');
  }catch{return false;}
}
