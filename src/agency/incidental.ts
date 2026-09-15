import { itemCount, type ItemNeed } from './item-intents.ts';

export type IncidentalGroundItem={id?:unknown;name?:unknown;count?:unknown;x?:unknown;z?:unknown;reachable?:unknown};
export type IncidentalState={inventory?:any[];equipment?:any[];groundItems?:IncidentalGroundItem[];capacity?:number};
export type IncidentalChoice={need:ItemNeed;key:string;score:number;reason:string;evidence:string[]};

const finiteCount=(v:unknown)=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):1;
const norm=(v:unknown)=>String(v??'').trim().toLowerCase().replace(/\s+/g,' ');
const equipmentLike=(name:string)=>/\b(helmet|helm|platebody|platelegs|plateskirt|chainbody|shield|sword|scimitar|longsword|battleaxe|warhammer|mace|dagger|bow|staff|robe|boots|gloves|gauntlets|amulet|ring|cape)\b/i.test(name);

/**
 * Value a side opportunity without naming particular drops or creatures.
 * A side pickup is optional: it must have spare carrying capacity and some
 * plausible collection, equipment, stacking, or future-use value. The primary
 * goal remains the parent; this function never creates a replacement objective.
 */
export function chooseIncidentalGroundItem(state:IncidentalState,now:number,cooldowns:Record<string,number>={}):IncidentalChoice|undefined {
  const inventory=Array.isArray(state.inventory)?state.inventory:[];
  const equipment=Array.isArray(state.equipment)?state.equipment:[];
  const capacity=Number.isInteger(state.capacity)&&Number(state.capacity)>0?Number(state.capacity):28;
  const free=Math.max(0,capacity-inventory.length);
  if(free<4)return;
  const ownedIds=new Set([...inventory,...equipment].map(i=>Number(i?.id)).filter(Number.isInteger));
  const choices=(state.groundItems??[]).flatMap((row):IncidentalChoice[]=>{
    const id=Number(row.id),name=String(row.name??'').trim(),x=Number(row.x),z=Number(row.z);
    if(row.reachable!==true||!Number.isInteger(id)||id<0||!name||!Number.isInteger(x)||!Number.isInteger(z))return [];
    const key=`ground:${id}:${x}:${z}`;if((cooldowns[key]??0)>now)return [];
    const stack=finiteCount(row.count),already=ownedIds.has(id),current=itemCount(inventory,{id,name,minimum:1});
    let score=0;
    if(!already)score+=4;                         // collection/future-use information
    if(equipmentLike(norm(name)))score+=3;        // equipment can be stored even when not an upgrade
    if(stack>1||current>0)score+=2;               // one slot can preserve multiple useful units
    if(free>=8)score+=1;                          // cheap carrying opportunity
    if(score<3)return [];
    return [{need:{id,name,minimum:current+Math.max(1,stack)},key,score,
      reason:'Use spare carrying capacity for a worthwhile incidental resource while preserving the primary objective; store or use it later if personal evidence supports a secondary purpose.',
      evidence:[`own-ground-opportunity:${id}:${x}:${z}`,`free-slots:${free}`,`incidental-score:${score}`]}];
  });
  return choices.sort((a,b)=>b.score-a.score||a.key.localeCompare(b.key))[0];
}

/** Items deliberately collected as incidental resources remain bankable later. */
export function incidentalBankable(item:any,ids:Record<string,number>|undefined):boolean {
  const id=Number(item?.id);return Number.isInteger(id)&&id>=0&&!!ids?.[String(id)];
}
