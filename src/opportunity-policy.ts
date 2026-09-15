export type OpportunityItem = { id?:unknown; name?:unknown; count?:unknown; slot?:unknown; x?:unknown; z?:unknown; distance?:unknown; reachable?:unknown; optionsWithIndex?:Array<{text?:unknown;opIndex?:unknown}> };
export type OpportunityState = { inventory?:OpportunityItem[]; equipment?:OpportunityItem[]; groundItems?:OpportunityItem[]; capacity?:number; player?:{combat?:{inCombat?:boolean}}; bank?:{isOpen?:boolean}; shop?:{isOpen?:boolean}; dialog?:{isOpen?:boolean}; modalOpen?:boolean };
export type OpportunityAction = { id:string; type:string; fields?:Record<string,unknown>; waitTicks:number };

const name=(v:unknown)=>String(v??'').trim().toLowerCase();
const equipment=/\b(helm(?:et)?|hat|coif|body|platebody|chainbody|legs|platelegs|plateskirt|skirt|shield|sq shield|kiteshield|boots|gloves|gauntlets|cape|amulet|ring|sword|scimitar|longsword|battleaxe|warhammer|mace|dagger|bow|staff)\b/i;
const resource=/\b(raw |logs?|ore|bars?|essence|flax|wool|leather|hide|feathers?|herbs?|seeds?|gems?|clay|runes?|arrows?|shafts?|arrowtips?|arrowheads?|food|fish|coins?)\b/i;
const tool=/\b(axe|pickaxe|tinderbox|hammer|knife|chisel|shears|harpoon|fishing net|fishing rod)\b/i;
const obviousWaste=/\b(ashes|burnt|broken|rotten)\b/i;

export function incidentalUtility(item:OpportunityItem,state:OpportunityState):number {
  const n=name(item.name); if(!n||obviousWaste.test(n))return -10;
  let score=0;
  if(resource.test(n))score+=4;
  if(equipment.test(n))score+=3;
  if(tool.test(n))score+=3;
  if((state.inventory??[]).some(i=>i.id===item.id||name(i.name)===n))score+=2;
  if((state.equipment??[]).some(i=>name(i.name)===n))score+=1;
  return score;
}

/** Take only cheap side opportunities; never replace the selected primary goal or justify a long detour. */
export function incidentalOpportunity(state:OpportunityState,primaryKind?:string):OpportunityAction|undefined {
  if(state.player?.combat?.inCombat||state.bank?.isOpen||state.shop?.isOpen||state.dialog?.isOpen||state.modalOpen)return;
  const inv=state.inventory??[],capacity=Number(state.capacity??28),free=Math.max(0,capacity-inv.length);
  // Observed one-click transformations that directly create progression are cheap enough to use in place.
  const use=inv.find(i=>Number.isInteger(i.slot)&&(i.optionsWithIndex??[]).some(o=>Number.isInteger(o.opIndex)&&/^(bury|scatter)$/i.test(String(o.text))));
  if(use){const op=use.optionsWithIndex!.find(o=>Number.isInteger(o.opIndex)&&/^(bury|scatter)$/i.test(String(o.text)))!;
    return {id:`incidental-use-${String(use.id)}-${String(use.slot)}`,type:'useInventoryItem',fields:{slot:use.slot,optionIndex:op.opIndex,reason:'low-cost incidental progression while preserving the primary objective'},waitTicks:2};}
  const candidates=(state.groundItems??[]).filter(i=>i.reachable===true&&Number.isInteger(i.id)&&Number.isFinite(Number(i.x))&&Number.isFinite(Number(i.z)))
    .map(i=>({i,d:Number.isFinite(Number(i.distance))?Number(i.distance):99,u:incidentalUtility(i,state)}))
    .filter(r=>r.d<=2&&r.u>=3)
    .filter(r=>{
      const stacks=inv.some(i=>i.id===r.i.id||name(i.name)===name(r.i.name));
      if(stacks)return true;
      const reserve=primaryKind==='gathering'?3:2;
      return free>reserve;
    }).sort((a,b)=>(b.u-a.u)||(a.d-b.d));
  const best=candidates[0];if(!best)return;
  return {id:`incidental-pickup-${String(best.i.id)}-${String(best.i.x)}-${String(best.i.z)}`,type:'pickupItem',fields:{x:best.i.x,z:best.i.z,itemId:best.i.id,reason:'useful incidental resource with low detour and inventory cost'},waitTicks:2};
}

export function bankableIncidentalEquipment(item:OpportunityItem):boolean { return equipment.test(name(item.name)); }
