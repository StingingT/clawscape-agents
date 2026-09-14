import type { GearCatalog } from './catalog';
import { usable } from './planner';
export const mission=(role:string)=>role==='economy'
  ? 'Maximize sustainable net wealth; choose production, skill unlocks and tools by their value'
  : 'Become stronger through useful equipment and build-compatible experience, while sustaining supplies and avoiding death';

export function usefulXp(before:any,after:any,role:string,ranged:boolean){
  const combat=new Set(ranged?['ranged','magic','defence','hitpoints']:['attack','strength','defence','hitpoints']);
  let result=0;
  for(const skill of after.skills??[]){
    const name=String(skill.name).toLowerCase(),old=before.skills?.find((x:any)=>String(x.name).toLowerCase()===name);
    if(!old||Number(old.baseLevel??old.level)>=99)continue;
    const gain=Math.max(0,Number(skill.experience??0)-Number(old.experience??0));
    result+=gain*(role==='economy'?.001:combat.has(name)?.01:.001);
  }
  return result;
}
export function outcomeReward(before:any,after:any,action:any,role:string,ranged:boolean,catalog:GearCatalog){
  let value=usefulXp(before,after,role,ranged);
  const quality=(s:any,family:string)=>Math.max(0,...catalog.items.filter(g=>g.family===family&&usable(g,s)
    &&(g.tool?[...(s.inventory??[]),...(s.equipment??[])]:s.equipment??[]).some((i:any)=>i.id===g.id)).map(g=>g.quality));
  for(const family of role==='economy'?['axe','pickaxe']:ranged?['bow','legs','hands']:['melee'])value+=(quality(after,family)-quality(before,family))*2;
  // Banking is a transfer, not income, and more shafts/logs are not money.
  // Award sale income only when that exact inventory item actually decreased.
  const cash=(s:any)=>(s.inventory??[]).filter((i:any)=>i.id===995).reduce((n:number,i:any)=>n+Number(i.count),0);
  const item=before.inventory?.find((i:any)=>i.slot===action.fields?.slot);
  const qty=(s:any)=>item?(s.inventory??[]).filter((i:any)=>i.id===item.id).reduce((n:number,i:any)=>n+i.count,0):0;
  if(action.type==='shopSell'&&qty(after)<qty(before)&&cash(after)>cash(before))value+=(cash(after)-cash(before))*(role==='economy'?.1:.01);
  if(action.type==='shopBuy'&&cash(after)<cash(before))value+=(cash(after)-cash(before))*(role==='economy'?.1:.001);
  if(after.player?.isDead&&!before.player?.isDead||after.player?.lifeId!==before.player?.lifeId||Number(after.player?.respawnCount??0)>Number(before.player?.respawnCount??0))value-=100;
  if(action.type==='wait')value-=.05;
  return Number(value.toFixed(4));
}
