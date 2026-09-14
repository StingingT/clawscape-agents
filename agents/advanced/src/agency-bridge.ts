import type { Observation, Intent, ActionResult } from './contracts.ts';
import type { LiveDecision } from './live-policy.ts';
import type { LiveCandidate, Verification } from '../../../src/agency/live-adapter.ts';
import { verifyActionOutcome } from '../../../src/action-outcome.ts';

/** Normalize only the controlled character's observation. Keep the original for journal reconciliation. */
export function agencyState(o: Observation): Record<string, any> {
  const item = (i: Observation['inventory'][number]) => ({ ...i, optionsWithIndex:i.options.map(p=>({opIndex:p.index,text:p.text})) });
  const entity = (e: Observation['entities'][number]) => ({id:e.content_id,index:e.index,name:e.name,x:e.position.x,z:e.position.z,
    level:e.position.plane,reachable:e.reachable,hp:e.hp,maxHp:e.max_hp,combatLevel:e.combat_level,inCombat:e.in_combat,
    distance:o.position?Math.max(Math.abs(o.position.x-e.position.x),Math.abs(o.position.z-e.position.z)):Infinity,
    optionsWithIndex:e.options.map(p=>({opIndex:p.index,text:p.text}))});
  return {character:o.character,world:o.world,sessionId:o.session_id,profileId:o.profile_id,tick:o.tick,seq:o.seq,
    inGame:o.connected,capacity:o.capacity,player:{hp:o.hp,maxHp:o.max_hp,lifeId:o.life_id,respawnCount:o.respawns,
      worldX:o.position?.x,worldZ:o.position?.z,level:o.position?.plane,isDead:o.hp===0,animId:o.activity?.animation,
      combat:{inCombat:o.activity?.target_type==='npc'&&o.entities.some(e=>e.kind==='npc'&&e.index===o.activity?.target_index&&e.options.some(p=>/^attack$/i.test(p.text))),
        targetType:o.activity?.target_type,targetIndex:o.activity?.target_index,lastDamageTick:o.activity?.last_damage_tick}},
    skills:o.skills.map(s=>({name:s.name,baseLevel:s.base,level:s.current,experience:s.xp})),inventory:o.inventory.map(item),equipment:o.equipment.map(item),
    bank:{isOpen:o.bank.open,items:o.bank.items?.map(item)},shop:{isOpen:o.shop_open},modalOpen:o.activity?.modal_open??o.activity?.design_open,
    dialog:{isOpen:o.dialog.open,isWaiting:o.dialog.waiting,text:o.dialog.text,options:o.dialog.options},
    combatStyle:{currentStyle:o.activity?.style,styles:(o.activity?.styles??[]).map(s=>({index:s.index,trainsSkills:s.skill.split(',').map(k=>k.trim().toLowerCase())})),weaponName:o.equipment.find(i=>/sword|scimitar|bow|staff|dagger|mace/i.test(i.name))?.name},
    nearbyNpcs:o.entities.filter(e=>e.kind==='npc').map(entity),nearbyLocs:o.entities.filter(e=>e.kind==='object').map(entity),
    groundItems:o.entities.filter(e=>e.kind==='ground_item').map(entity),
    combatEvents:(o.activity?.events??[]).map(e=>({...e,targetType:e.target_type,targetIndex:e.target_index})),_advanced:o};
}

/** This mapping cannot turn a player's message or unknown target into a permitted action. */
export function agencyCandidate(o: Observation, decision: LiveDecision): LiveCandidate {
  const i=decision.intent, a=(type:string,fields:Record<string,any>={}):LiveCandidate=>({id:decision.goal,type,fields,waitTicks:1});
  if(!i) {
    if(decision.wait)return a('wait');
    throw new Error('EXECUTABLE_INTENT_REQUIRED');
  }
  const choice=(slot:number,re:RegExp)=>o.inventory.find(v=>v.slot===slot)?.options.find(v=>re.test(v.text))?.index;
  switch(i.operation) {
    case 'close_interface':return a('closeModal');
    case 'move':return a('walkTo',{x:i.destination.x,z:i.destination.z,level:i.destination.plane});
    case 'eat':return a('useInventoryItem',{slot:i.slot,optionIndex:choice(i.slot,/^eat$/i)});
    case 'equip':return a('useInventoryItem',{slot:i.slot,optionIndex:choice(i.slot,/^(wear|wield|equip)$/i)});
    case 'deposit':return a('bankDeposit',{slot:i.slot,amount:i.amount});
    case 'withdraw':return a('bankWithdraw',{slot:i.slot,amount:i.amount});
    case 'style':return a('setCombatStyle',{style:i.style_index});
    case 'dialogue':return a('clickDialogOption',{option:i.option_index});
    case 'accept_design':return a('acceptCharacterDesign');
    case 'use_on_item':return a('useItemOnItem',{sourceSlot:i.slot,targetSlot:i.target_slot});
    case 'interact': case 'use_on_object': case 'pickup': {
      const e=o.entities.find(e=>e.ref===i.entity_ref);
      if(!e)throw new Error('FRESH_ENTITY_REFERENCE_REQUIRED');
      if(i.operation==='pickup'&&e.kind==='ground_item')return a('pickupItem',{x:e.position.x,z:e.position.z,itemId:e.content_id});
      if(i.operation==='use_on_object'&&e.kind==='object')return a('useItemOnLoc',{itemSlot:i.slot,locId:e.content_id,x:e.position.x,z:e.position.z});
      if(i.operation==='interact'&&e.kind==='npc'&&e.index!==null)return a('interactNpc',{npcIndex:e.index,optionIndex:i.option_index});
      if(i.operation==='interact'&&e.kind==='object')return a('interactLoc',{locId:e.content_id,x:e.position.x,z:e.position.z,optionIndex:i.option_index});
      throw new Error('UNSUPPORTED_ENTITY_OPERATION');
    }
  }
}

/** A result is used only for its exact command. Timeout and post-dispatch cancellation stay unknown. */
export function arbiterVerification(commandId:string,result:ActionResult|undefined):Verification {
  if(!result)return {status:'unknown',evidence:[],reason:'No action result yet.'};
  if(result.action_id!==commandId)throw new Error('RESULT_COMMAND_ID_MISMATCH');
  if(result.status==='SUCCEEDED'&&result.evidence.length)return {status:'verified',evidence:result.evidence};
  if(result.status==='REJECTED'||result.status==='EXPIRED'||result.status==='CANCELLED'&&!/MAY_STILL|OUTCOME_UNKNOWN|PREEMPTED/.test(result.reason))
    return {status:'rejected',evidence:[`arbiter-before-dispatch:${result.reason}`]};
  return {status:'unknown',evidence:[],reason:`${result.status}:${result.reason}`};
}

/** Emergency selection is independent of ordinary tasks; never falls through to training. */
export function urgentDecision(o:Observation):LiveDecision|undefined {
  if(o.hp===null||o.max_hp===null||o.hp<=0)return;
  if(o.hp>=o.max_hp || o.hp>Math.max(o.max_hp*.8,o.danger.damage_margin??0))return;
  const meal=o.inventory.find(i=>i.count>0&&i.options.some(p=>/^eat$/i.test(p.text)));
  if(!meal)return;
  if(o.bank.open||o.shop_open||o.dialog.open||o.activity?.modal_open)
    return {goal:'heal:close-interface',reason:'Urgent health interrupt; original goal remains active.',intent:{operation:'close_interface'}};
  return {goal:'heal',reason:'Use observed food; do not discard the interrupted task.',intent:{operation:'eat',slot:meal.slot,item_id:meal.id}};
}

export function observedVerification(before:Record<string,any>,after:Record<string,any>,action:LiveCandidate):Verification {
  const v=verifyActionOutcome(before,after,action);
  return {status:v.verified?'verified':v.uncertain?'unknown':'rejected',evidence:v.evidence,reason:v.reason};
}
