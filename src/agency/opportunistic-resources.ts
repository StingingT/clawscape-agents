import type { LiveCandidate } from './live-adapter.ts';
import type { LiveState, TaskKind } from './world-model.ts';

export type IncidentalMemory = {
  bankItemIds: number[];
  handled: Array<{ at:number; id:number; name:string; use:'pickup'|'process'|'skill-use'|'bank'; evidence:string }>;
};

export const emptyIncidental = ():IncidentalMemory => ({ bankItemIds:[], handled:[] });
const norm=(v:unknown)=>String(v??'').replace(/<[^>]*>/g,'').trim().toLowerCase().replace(/\s+/g,' ');
const option=(e:any,re:RegExp)=>(e?.optionsWithIndex??[]).find((o:any)=>Number.isInteger(o.opIndex)&&re.test(norm(o.text)));
const distance=(s:LiveState,e:any)=>Math.max(Math.abs(Number(s.player?.worldX)-Number(e.x??e.tileX)),Math.abs(Number(s.player?.worldZ)-Number(e.z??e.tileZ)));
const capacity=(s:LiveState)=>Number.isInteger(s.capacity)?Number(s.capacity):28;
const free=(s:LiveState)=>Math.max(0,capacity(s)-(s.inventory??[]).length);
const itemId=(v:any)=>Number.isInteger(v?.id)&&v.id>=0?Number(v.id):undefined;

/**
 * Side opportunities never become prerequisites for the primary objective.
 * They are bounded by spare inventory, distance and fresh observation. Unknown
 * items may be sampled when carrying capacity is comfortable so the agent can
 * learn their options/value instead of requiring a hard-coded item allowlist.
 */
export function incidentalCandidate(state:LiveState,primary?:TaskKind):LiveCandidate|undefined {
  if(state.inGame===false||state.player?.isDead===true||state.player?.combat?.inCombat===true||state.bank?.isOpen===true||state.shop?.isOpen===true||state.dialog?.isOpen===true||state.modalOpen===true)return;
  const inventory=state.inventory??[];
  // Prefer an observed, immediate, no-travel skill/use action. The item name is
  // irrelevant: capability comes from its live option, not a special-case ID.
  for(const item of inventory) {
    const use=option(item,/^bury$/i);
    if(use&&Number.isInteger(item.slot))return {id:`incidental-skill-use-${item.id}-${item.slot}`,type:'useInventoryItem',fields:{slot:item.slot,optionIndex:use.opIndex,reason:'low-cost incidental resource use with an observed skill action'},waitTicks:2};
  }
  // A generic raw resource can be processed only against a freshly observed,
  // adjacent heat source. This is a hypothesis verified by the normal outcome journal.
  const raw=inventory.find((i:any)=>/^raw\b/i.test(norm(i.name))&&Number.isInteger(i.slot));
  if(raw) {
    const heat=(state.nearbyLocs??[]).filter((l:any)=>Number.isInteger(l.x)&&Number.isInteger(l.z)&&/^(fire|fireplace|range|stove|cooking pot)$/i.test(norm(l.name)))
      .sort((a:any,b:any)=>distance(state,a)-distance(state,b))[0];
    if(heat&&distance(state,heat)<=1)return {id:`incidental-process-${raw.id}-${heat.id}`,type:'useItemOnLoc',fields:{itemSlot:raw.slot,x:heat.x,z:heat.z,locId:heat.id,reason:'process an incidental raw resource at an observed adjacent heat source'},waitTicks:4};
  }
  const spare=free(state);
  const minimumSpare=primary==='gathering'?3:2;
  if(spare<=minimumSpare)return;
  const ground=(state.groundItems??[]).filter((g:any)=>g.reachable===true&&itemId(g)!==undefined&&Number.isInteger(g.x??g.tileX)&&Number.isInteger(g.z??g.tileZ)&&distance(state,g)<=3);
  if(!ground.length)return;
  const known=new Map<number,any>();
  for(const row of [...inventory,...(state.equipment??[]),...(state.bank?.isOpen===true?state.bank.items??[]:[])])if(itemId(row)!==undefined)known.set(row.id,row);
  const ranked=ground.map((g:any)=>{
    const prior=known.get(g.id),sameStack=inventory.some((i:any)=>i.id===g.id),opts=prior?.optionsWithIndex??[];
    const observedUtility=opts.some((o:any)=>/^(eat|bury|wield|equip|wear|use)$/i.test(norm(o.text)));
    const score=(sameStack?5:0)+(observedUtility?4:0)+(prior?2:0)+(spare>=6?1:0)-distance(state,g);
    return {g,score};
  }).filter((r:any)=>r.score>=0).sort((a:any,b:any)=>b.score-a.score||distance(state,a.g)-distance(state,b.g));
  const chosen=ranked[0]?.g;if(!chosen)return;
  return {id:`incidental-pickup-${chosen.id}-${chosen.x??chosen.tileX}-${chosen.z??chosen.tileZ}`,type:'pickupItem',fields:{x:chosen.x??chosen.tileX,z:chosen.z??chosen.tileZ,itemId:chosen.id,reason:'collect a nearby incidental resource while spare carrying capacity makes the diversion cheap'},waitTicks:2};
}

export function recordIncidental(memory:IncidentalMemory,before:LiveState,after:LiveState,action:LiveCandidate,now:number):void {
  if(!action.id.startsWith('incidental-'))return;
  const id=Number(action.fields?.itemId??(before.inventory??[]).find((i:any)=>i.slot===action.fields?.itemSlot||i.slot===action.fields?.slot)?.id);
  const row=[...(after.inventory??[]),...(before.inventory??[])].find((i:any)=>i.id===id);
  const use=action.type==='pickupItem'?'pickup':action.type==='useInventoryItem'?'skill-use':'process';
  if(Number.isInteger(id)&&id>=0) {
    if(action.type==='pickupItem'&&!memory.bankItemIds.includes(id))memory.bankItemIds=[...memory.bankItemIds,id].slice(-256);
    memory.handled=[...memory.handled,{at:now,id,name:String(row?.name??id),use,evidence:`verified:${action.type}:${before.tick}->${after.tick}`}].slice(-256);
  }
}

export function incidentalBankable(item:any,memory:IncidentalMemory):boolean {
  return Number.isInteger(item?.id)&&memory.bankItemIds.includes(item.id)&&item.protected!==true;
}
