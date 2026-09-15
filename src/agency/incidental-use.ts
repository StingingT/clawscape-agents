export type IncidentalUseAction={id:string;type:'useInventoryItem';fields:{slot:number;optionIndex:number;reason:string};waitTicks:number};

/**
 * A low-cost observed item action may be used without replacing the current goal.
 * This layer names actions, not particular items or creatures. Final dispatch still
 * passes through the normal development/build guard, so protected XP cannot be bypassed.
 */
export function chooseIncidentalUse(state:any):IncidentalUseAction|undefined {
  if(state.player?.combat?.inCombat===true||state.bank?.isOpen===true||state.shop?.isOpen===true||state.dialog?.isOpen===true||state.modalOpen===true)return;
  for(const item of state.inventory??[]) {
    if(!Number.isInteger(item.slot))continue;
    const option=(item.optionsWithIndex??[]).find((o:any)=>Number.isInteger(o.opIndex)&&/^(bury|scatter)$/i.test(String(o.text)));
    if(option)return {id:`incidental-use-${item.id}-${item.slot}`,type:'useInventoryItem',fields:{slot:item.slot,optionIndex:option.opIndex,
      reason:'Use a low-cost incidental resource for immediate progression while preserving the primary objective.'},waitTicks:2};
  }
}
