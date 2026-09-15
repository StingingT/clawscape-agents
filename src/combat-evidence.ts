/** Public observations only. Missing damage on a kill is not missing kill identity. */
export type CombatEvent = {tick:number;type:'damage_taken'|'damage_dealt'|'kill';damage:number;
  source_type:string;source_index:number;target_type:string;target_index:number};
const nat=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
export function combatEvents(raw:unknown):CombatEvent[] {
  if(!Array.isArray(raw))return [];
  return raw.slice(-30).flatMap(e=>{
    if(!e||!nat(e.tick)||!['damage_taken','damage_dealt','kill'].includes(e.type))return [];
    const source=e.sourceIndex??e.source_index,target=e.targetIndex??e.target_index;
    const sourceType=e.sourceType??e.source_type,targetType=e.targetType??e.target_type;
    if(!nat(source)||!nat(target)||!['player','npc'].includes(sourceType)||!['player','npc'].includes(targetType))return [];
    // Zero is only the neutral, unused damage field for an otherwise identified kill.
    const damage=e.type==='kill'&&e.damage==null?0:e.damage;
    if(!nat(damage))return [];
    return [{tick:e.tick,type:e.type,damage,source_type:sourceType,source_index:source,target_type:targetType,target_index:target}];
  });
}
export function observedPlayerIndex(value:unknown):number|null {return nat(value)?value:null;}
export function ownKill(events:CombatEvent[],self:number|null|undefined,npc:number,startTick:number|null,endTick:number|null):boolean {
  return nat(self)&&nat(startTick)&&nat(endTick)&&events.some(e=>e.type==='kill'&&e.tick>startTick&&e.tick<=endTick
    &&e.source_type==='player'&&e.source_index===self&&e.target_type==='npc'&&e.target_index===npc);
}
