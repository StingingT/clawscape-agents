type ActionLike = { id?:string; actionId?:string; type:string; fields?:Record<string,any> };
export type ActionVerification = { verified:boolean; evidence:string[]; uncertain:boolean; reason?:string };
const quantity=(items:any[]|undefined,id:any)=>(items??[]).filter(i=>String(i.id)===String(id)).reduce((n,i)=>n+Number(i.count??1),0);
const coins=(s:any)=>(s.inventory??[]).filter((i:any)=>Number(i.id)===995||/^coins$/i.test(String(i.name))).reduce((n:number,i:any)=>n+Number(i.count??1),0);
const xp=(s:any,name:string)=>Number(s.skills?.find((k:any)=>String(k.name).toLowerCase()===name)?.experience??s.skills?.find((k:any)=>String(k.name).toLowerCase()===name)?.xp??0);
const same=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);
const yes=(...evidence:string[]):ActionVerification=>({verified:true,evidence,uncertain:false});
const no=(reason:string,uncertain=true):ActionVerification=>({verified:false,evidence:[],uncertain,reason});
const menu=(e:any,index:any)=>(e?.optionsWithIndex??[]).find((o:any)=>o.opIndex===index)?.text??'';
const opened=(s:any)=>s.bank?.isOpen===true||s.shop?.isOpen===true||s.dialog?.isOpen===true||s.modalOpen===true;

/** Action-specific verification. Missing evidence is UNKNOWN, not a rejected mutation. */
export function verifyActionOutcome(before:any,after:any,action:ActionLike,result?:any):ActionVerification {
  const f=action.fields??{}, type=action.type;
  if(!before?.player||!after?.player)return no('complete player observation required');
  if(before.player.lifeId!==after.player.lifeId)return no('life changed; losses and intent must be reconciled');
  if(result?.accepted===false || result?.phase==='rejected')return no('explicit server rejection',false);
  if(type==='wait')return Number(after.tick)>Number(before.tick)?yes('read-only wait completed'):no('observation has not advanced',false);
  if(type==='scanNearbyLocs')return Number(after.tick)>=Number(before.tick)&&Array.isArray(after.nearbyLocs)?yes('read-only scan completed'):no('scan unavailable',false);
  if(type==='walkTo'||type==='retreat') {
    const moved=before.player.worldX!==after.player.worldX||before.player.worldZ!==after.player.worldZ;
    if(type==='retreat')return moved?yes('retreat movement observed'):no('retreat not yet observed');
    const distance=(s:any)=>Math.max(Math.abs(Number(s.player.worldX)-Number(f.x)),Math.abs(Number(s.player.worldZ)-Number(f.z)));
    if(!Number.isFinite(distance(after))||Number(after.player.level)!==Number(f.level??0))return no('destination/plane invalid');
    if(distance(after)<=1)return yes('requested destination observed');
    if(moved && (distance(after)<distance(before)||result?.navigation?.status==='progress'))return yes('navigation leg made verified movement');
    return no('movement not yet verified',!['blocked','arrived'].includes(result?.navigation?.status));
  }
  if(type==='bankDeposit'||type==='bankWithdraw') {
    const source=type==='bankWithdraw'?before.bank?.items:before.inventory;
    const item=source?.find((i:any)=>i.slot===f.slot);
    if(!item||before.bank?.isOpen!==true||after.bank?.isOpen!==true)return no('original bank source unavailable');
    const inv=quantity(after.inventory,item.id)-quantity(before.inventory,item.id),bank=quantity(after.bank.items,item.id)-quantity(before.bank.items,item.id);
    const wanted=Number(f.amount), direction=type==='bankDeposit'?-1:1;
    const enough=wanted===-1?inv*direction>0:inv*direction===wanted;
    return enough&&inv===-bank?yes(`item:${item.id} balanced inventory/bank delta:${inv}/${bank}`):no('requested transfer not reconciled');
  }
  if(type==='shopBuy'||type==='shopSell') {
    const source=type==='shopBuy'?before.shop?.shopItems:before.inventory;
    const item=source?.find((i:any)=>i.slot===f.slot), n=Number(f.amount);
    if(!item||!Number.isInteger(n)||n<=0)return no('original shop item/quantity unavailable');
    const items=quantity(after.inventory,item.id)-quantity(before.inventory,item.id),money=coins(after)-coins(before);
    const direction=type==='shopBuy'?1:-1;
    if(items===direction*n && money*direction<0)return yes(`requested item:${item.id} delta:${items}`,`coins:${money}`);
    return no('requested item and payment not both verified');
  }
  if(type==='closeModal'||type==='closeShop')return opened(before)&&!opened(after)?yes('interface closed'):no('interface closure not verified');
  if(type==='setCombatStyle')return after.combatStyle?.currentStyle===f.style?yes(`requested style:${f.style} observed`):no('requested style not observed');
  if(type==='acceptCharacterDesign')return before.modalOpen===true&&after.modalOpen===false?yes('design interface closed'):no('design closure not observed');
  if(type==='useInventoryItem'||type==='equip') {
    const item=before.inventory?.find((i:any)=>i.slot===f.slot);
    if(!item)return no('original inventory slot unavailable');
    const option=menu(item,f.optionIndex);
    if(/eat/i.test(option)&&quantity(after.inventory,item.id)<quantity(before.inventory,item.id)&&Number(after.player.hp)>Number(before.player.hp))return yes(`food:${item.id} consumed with healing`);
    if(/wear|wield|equip/i.test(option)&&(after.equipment??[]).some((i:any)=>i.id===item.id)&&!same(before.equipment,after.equipment))return yes(`equipment:${item.id} observed`);
    return no('requested inventory effect not verified');
  }
  if(type==='pickupItem')return quantity(after.inventory,f.itemId)>quantity(before.inventory,f.itemId)?yes(`pickup:${f.itemId} observed`):no('requested pickup not observed');
  if(type==='talkToNpc'||type==='clickDialogOption')return !same(before.dialog,after.dialog)?yes('dialogue advanced'):no('dialogue effect not verified');
  let option='';
  if(type==='interactNpc')option=menu((before.nearbyNpcs??[]).find((n:any)=>n.index===f.npcIndex),f.optionIndex);
  if(type==='interactLoc')option=menu((before.nearbyLocs??[]).find((n:any)=>n.id===f.locId&&n.x===f.x&&n.z===f.z),f.optionIndex);
  if(/^attack$/i.test(option)) {
    const b=before.player.combat,a=after.player.combat;
    const correct=a?.inCombat===true&&a.targetType==='npc'&&a.targetIndex===f.npcIndex;
    const fresh=correct&&!(b?.inCombat===true&&b.targetType==='npc'&&b.targetIndex===f.npcIndex);
    const event=(after.combatEvents??[]).some((e:any)=>e.tick>Number(before.tick)&&e.targetType==='npc'&&e.targetIndex===f.npcIndex&&['damage_dealt','kill'].includes(e.type));
    const gained=['attack','strength','defence','ranged','magic'].some(k=>xp(after,k)>xp(before,k));
    return fresh||event||correct&&gained?yes(fresh?'requested NPC newly engaged':'requested encounter effect observed'):no('no attributable new encounter effect');
  }
  if(/bank|use-quickly/i.test(option))return before.bank?.isOpen!==true&&after.bank?.isOpen===true?yes('bank opened'):no('bank opening not observed');
  if(/trade/i.test(option))return before.shop?.isOpen!==true&&after.shop?.isOpen===true?yes('shop opened'):no('shop opening not observed');
  if(/talk/i.test(option))return !same(before.dialog,after.dialog)?yes('target dialogue advanced'):no('target dialogue not observed');
  if(/^open$/i.test(option)) {
    const loc=(after.nearbyLocs??[]).find((n:any)=>n.x===f.x&&n.z===f.z&&n.id===f.locId);
    return !loc||!/^open$/i.test(menu(loc,f.optionIndex))?yes('requested obstruction changed'):no('obstruction unchanged');
  }
  const skill=/net|bait|lure|fish/i.test(option)?'fishing':/chop/i.test(option)?'woodcutting':/mine/i.test(option)?'mining':'';
  if(skill&&xp(after,skill)>xp(before,skill)&&!same(before.inventory,after.inventory))return yes(`${skill} output and XP observed`);
  if(type==='useItemOnItem'||type==='useItemOnLoc') {
    if(!same(before.dialog,after.dialog))return yes('production dialogue observed');
    const slot=f.sourceSlot??f.itemSlot, item=(before.inventory??[]).find((i:any)=>i.slot===slot);
    const target=before.inventory?.find((i:any)=>i.slot===f.targetSlot);
    const consumed=item&&quantity(after.inventory,item.id)<quantity(before.inventory,item.id)||target&&quantity(after.inventory,target.id)<quantity(before.inventory,target.id);
    if(consumed&&['cooking','firemaking','fletching','smithing','crafting'].some(k=>xp(after,k)>xp(before,k)))return yes('production inputs consumed and XP observed');
  }
  return no('action-specific outcome remains unknown');
}
