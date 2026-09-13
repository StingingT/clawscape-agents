import {isFood} from '../runtime-policy';
export function basicKit(s:any):boolean {
 const e=s.equipment??[];
 return e.some((i:any)=>/sword|scimitar|mace|dagger/i.test(i.name))
  && e.some((i:any)=>/shield/i.test(i.name)) && e.some((i:any)=>/platebody|chainbody/i.test(i.name));
}
export function canDefend(s:any,enemy:any):boolean {
 if(!enemy || !basicKit(s) || enemy.hp===0)return false;
 const level=Number(enemy.combatLevel), own=Number(s.player?.combatLevel);
 const hp=Number(s.player?.hp),max=Number(s.player?.maxHp);
 return level>0 && level<=own && hp>Math.max(4,max*.6)
   && (level<=own/2 || (s.inventory??[]).some(isFood));
}
export function unsafeMiningNeighbour(s:any):boolean {
 // A conservative scouting filter, not a claim that every attackable NPC is aggressive.
 return (s.nearbyNpcs??[]).some((n:any)=>n.distance<=8 && n.combatLevel>0
   && n.optionsWithIndex?.some((o:any)=>/^attack$/i.test(o.text)) && !canDefend(s,n));
}
