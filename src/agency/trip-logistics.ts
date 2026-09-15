/** Personal, bounded trip learning. Observed counts are not universal food quotas. */
import { createHash } from 'node:crypto';
import type { LiveState, TaskKind } from './world-model.ts';
export type TripSample = { key:string; at:number; seconds:number; foodUsed:number; damage:number;
  escaped:boolean; died:boolean; returned:boolean; peakUsedSlots:number; capacity:number };
export type TripLearning = { bankedCargo?:number; cargoCredits?:Record<string,number>; samples:TripSample[]; active?:TripSample & {startedAt:number;life:unknown;activity:string;productiveActions:number;mixed?:boolean};
  previous?:{tick:number;session:unknown;epoch:unknown;life:unknown;hp:number;bank:boolean;at:number};
  meals?:Record<string,{healed:number;uses:number}>; seenCommands?:string[] };
export type TripPreparation = { activity:string; context:string; foodTarget:number; cargoSlots:number;
  occupiedToolSlots:number; capacity:number; samples:number; reason:string; provisional:boolean };
const valid=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export const edible=(i:any)=>(i.optionsWithIndex??[]).some((o:any)=>/^eat$/i.test(String(o.text)));
export const gatherable=(i:any)=>/^(raw |.* logs$|logs$|.* ore$|coal$|clay$|copper$|tin$|iron$|feathers?$|.*hide$|.* wool$)/i.test(String(i.name));
const foodCount=(items:any[])=>items.filter(edible).reduce((n,i)=>n+Number(i.count??1),0);
const tool=(i:any)=>/axe$|pickaxe$|fishing net|fishing rod|harpoon|lobster pot|knife|tinderbox|hammer|chisel|bait|feathers/i.test(String(i.name));
export function tripKey(state:LiveState,kind:string):string {
  // Amounts, individual ticks and food slots do not change a learned context.
  return kind+':'+createHash('sha256').update(JSON.stringify([
    state.character,state.world,state.profileId,state.player?.level,
    Math.floor(Number(state.player?.worldX??0)/64),Math.floor(Number(state.player?.worldZ??0)/64),
    (state.equipment??[]).map((i:any)=>i.id).sort(),
    (state.skills??[]).filter((s:any)=>/^(attack|defence|strength|ranged|magic|hitpoints)$/i.test(s.name))
      .map((s:any)=>[s.name,Math.floor(Number(s.baseLevel??s.level??1)/10)]).sort(),
  ])).digest('hex').slice(0,16);
}
export function emptyTrips():TripLearning{return {samples:[]};}
export function preparation(state:LiveState,kind:TaskKind|undefined,memory:TripLearning):TripPreparation {
  const activity=kind==='food'?'gathering':kind??'exploration';
  const key=memory.active?.activity===activity?memory.active.key:tripKey(state,activity),inv=state.inventory??[];
  const capacity=Number.isInteger(state.capacity)&&state.capacity>0?state.capacity:28;
  const tools=inv.filter((i:any)=>tool(i)||(!edible(i)&&!gatherable(i))).length;
  const history=memory.samples.filter(s=>s.key===key&&s.returned).slice(-8);
  const adverse=memory.samples.filter(s=>s.key===key&&(s.escaped||s.died||!s.returned&&s.damage>0)).slice(-3);
  const meals=Object.values(memory.meals??{}).filter(m=>m.uses>0);
  // A low one-trip prior is explicitly labelled, and can fall to zero. It is not a floor.
  const healPerMeal=meals.length?Math.max(1,Math.min(...meals.map(m=>m.healed/m.uses))):Math.max(1,Number(state.player?.maxHp??10)*.25);
  const immediateDanger=state.player?.combat?.inCombat===true;
  const maxHp=Number(state.player?.maxHp??0),hp=Number(state.player?.hp??0);
  const missing=valid(maxHp)&&valid(hp)?Math.max(0,maxHp-hp):0;
  const isCombat=activity==='combat';
  const cold=(isCombat||immediateDanger)?1:0;
  const use=history.length?Math.max(...history.map(s=>Math.max(s.foodUsed,Math.ceil(Math.max(0,s.damage-maxHp*.25)/healPerMeal)))):cold;
  const margin=adverse.length?Math.max(1,Math.ceil(Math.max(...adverse.map(s=>s.damage))/healPerMeal)):0;
  // Missing HP alone must not turn peaceful, unmeasured work into a large
  // food prerequisite. Non-combat reserves come from comparable trip evidence;
  // a cold-start reserve is only justified for combat or immediate danger.
  const healthNeed=(isCombat||immediateDanger)?Math.ceil(missing/healPerMeal):0;
  const need=Math.max(use+margin,healthNeed);
  const foodTarget=Math.min(Math.max(0,capacity-tools-1),need);
  return {activity,context:key,foodTarget,capacity,occupiedToolSlots:tools,
    cargoSlots:Math.max(0,capacity-tools-foodTarget),samples:history.length,provisional:history.length===0,
    reason:history.length?`Recent comparable returned trips used up to ${use} meals; ${adverse.length} adverse trip(s) inform the reserve.`:
      isCombat?'Unmeasured combat: a short one-meal probe, not a permanent minimum.':
      'No measured food demand on this non-combat task: preserve cargo room and re-evaluate observed danger/health.'};
}
export function observeTrip(memory:TripLearning,state:LiveState,kind:TaskKind|undefined,now:number):void {
  if(state.inGame!==true||!state.player||!valid(state.tick)||!valid(state.player.hp)||!Array.isArray(state.inventory))return;
  // Credits are bounded by what remains carried. Withdrawal/redeposit cannot farm gathering success.
  for(const id of Object.keys(memory.cargoCredits??{})){
    const owned=state.inventory.filter((i:any)=>String(i.id)===id).reduce((n:number,i:any)=>n+Number(i.count??1),0);
    memory.cargoCredits![id]=Math.min(memory.cargoCredits![id]!,Math.max(0,owned));
    if(!memory.cargoCredits![id])delete memory.cargoCredits![id];
  }
  const p=memory.previous,life=state.player.lifeId;
  if(life==null)return;
  const bank=state.bank?.isOpen===true;
  if(p && state.tick===p.tick && state.sessionId===p.session)return;
  if(p&&(state.tick<p.tick||now<p.at||now-p.at>120_000||p.epoch!==state.worldEpoch||p.session!==state.sessionId))delete memory.active;
  const a=memory.active;
  if(a&&p){
    if(kind&&(kind==='food'?'gathering':kind)!==a.activity)a.mixed=true;
    if(life===p.life)a.damage+=Math.max(0,p.hp-state.player.hp);
    a.peakUsedSlots=Math.max(a.peakUsedSlots,state.inventory.length);
    a.seconds=Math.max(0,(now-a.startedAt)/1000);
    if(life!==a.life || bank&&!p.bank){
      a.died=life!==a.life;a.returned=bank&&!a.died&&!a.mixed&&a.productiveActions>0;a.at=now;
      memory.samples=[...memory.samples,{...a}].slice(-64);delete memory.active;
    }
  }
  if(!memory.active&&!bank&&kind&&state.player.hp>0){
    const activity=kind==='food'?'gathering':kind;
    memory.active={key:tripKey(state,activity),at:now,startedAt:now,life,activity,productiveActions:0,seconds:0,foodUsed:0,
      damage:0,escaped:false,died:false,returned:false,peakUsedSlots:state.inventory.length,
      capacity:Number(state.capacity??28)};
  }
  memory.previous={tick:state.tick,session:state.sessionId,epoch:state.worldEpoch,life,hp:state.player.hp,bank,at:now};
}
export function recordTripEffect(memory:TripLearning,id:string,before:LiveState,after:LiveState,
  action:{type:string;fields?:Record<string,any>},verified:boolean):void {
  if(!verified||memory.seenCommands?.includes(id)||before.player?.lifeId==null||before.player.lifeId!==after.player?.lifeId
    || !Number.isFinite(after.tick)||!Number.isFinite(before.tick)||after.tick<=before.tick
    || ['character','world','worldEpoch','profileId'].some(k=>before[k]!==after[k]))return;
  memory.seenCommands=[...(memory.seenCommands??[]),id].slice(-128);
  if(memory.active){
    const xp=(s:LiveState,name:string)=>Number((s.skills??[]).find((v:any)=>v.name===name)?.experience??(s.skills??[]).find((v:any)=>v.name===name)?.xp??0);
    const learned=(after.skills??[]).some((s:any)=>xp(after,s.name)>xp(before,s.name));
    const moved=action.type==='walkTo'&&(after.player.worldX!==before.player.worldX||after.player.worldZ!==before.player.worldZ);
    if(learned||moved&&memory.active.activity==='exploration')memory.active.productiveActions++;
  }
  if(action.type==='retreat'&&memory.active)memory.active.escaped=true;
  memory.cargoCredits??={};
  const f=action.fields??{},entity=action.type==='interactLoc'?(before.nearbyLocs??[]).find((l:any)=>l.id===f.locId&&l.x===f.x&&l.z===f.z)
    :action.type==='interactNpc'?(before.nearbyNpcs??[]).find((n:any)=>n.index===f.npcIndex):undefined;
  const option=entity?.optionsWithIndex?.find((o:any)=>o.opIndex===f.optionIndex)?.text??'';
  if(/^(chop|chop down|chop-down|mine|net|small net|small-net|bait|lure|fish|harpoon|cage)$/i.test(option)){
    for(const id of new Set<string>((after.inventory??[]).filter(gatherable).map((i:any)=>String(i.id)))){
      const qty=(items:any[])=>items.filter(i=>String(i.id)===id).reduce((n,i)=>n+Number(i.count??1),0);
      const gain=qty(after.inventory??[])-qty(before.inventory??[]);
      if(Number.isSafeInteger(gain)&&gain>0)memory.cargoCredits[id]=(memory.cargoCredits[id]??0)+gain;
    }
  }
  if(action.type==='bankDeposit'&&before.bank?.isOpen===true&&after.bank?.isOpen===true) {
    const item=(before.inventory??[]).find((i:any)=>i.slot===action.fields?.slot);
    if(item&&gatherable(item)) {
      const qty=(a:any[])=>a.filter(i=>i.id===item.id).reduce((n,i)=>n+Number(i.count??1),0);
      const removed=qty(before.inventory??[])-qty(after.inventory??[]);
      if(removed>0&&removed===qty(after.bank.items??[])-qty(before.bank.items??[])){
        const credited=Math.min(removed,memory.cargoCredits[String(item.id)]??0);
        memory.bankedCargo=(memory.bankedCargo??0)+credited;
        memory.cargoCredits[String(item.id)]=(memory.cargoCredits[String(item.id)]??0)-credited;
      }
    }
  }
  if(action.type!=='useInventoryItem'||before.player?.lifeId!==after.player?.lifeId)return;
  const item=(before.inventory??[]).find((i:any)=>i.slot===action.fields?.slot);
  if(!item||!(item.optionsWithIndex??[]).some((o:any)=>o.opIndex===action.fields?.optionIndex&&/^eat$/i.test(o.text)))return;
  const used=Math.max(0,foodCount(before.inventory??[])-foodCount(after.inventory??[]));
  const healed=Number(after.player?.hp)-Number(before.player?.hp);
  if(used>0&&valid(healed)&&healed>0){
    if(memory.active)memory.active.foodUsed+=used;
    memory.meals??={};const m=memory.meals[String(item.id)]??={healed:0,uses:0};
    m.healed+=healed;m.uses+=used;
  }
}
