import {createHash} from 'node:crypto';
import {transitionOption} from './discovery.ts';
import type {LiveState} from './world-model.ts';
import type {LiveCandidate,Receipt} from './live-adapter.ts';
import type {Pending,Goal} from './types.ts';

export type IsolationWindow={observer:string;fingerprint:string;since:number;at:number;tick:number};
export type UnresolvedTransfer={commandId:string;at:number;status:'historically-unresolved';
  scope:'non-economic-discovery-only';itemId:number;fingerprint:string;reason:string;evidence:string[];
  receipt:Receipt;pending:Pending;goal:Goal;baseline:LiveState};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const counts=(rows:any[]):Array<[number,number]>|undefined=>{
  if(!Array.isArray(rows)||rows.some(i=>!Number.isInteger(i.id)||!Number.isSafeInteger(i.count??1)||(i.count??1)<0))return;
  const m=new Map<number,number>();for(const i of rows)m.set(i.id,(m.get(i.id)??0)+(i.count??1));
  return [...m].sort((a,b)=>a[0]-b[0]);
};
/** This is NOT transaction settlement. It proves only current quiescence for
 * isolating historical uncertainty. No financial or inventory action may follow.
 * This deliberately does not support shop purchases, choices or advanced dual journals. */
export function observeTransferIsolation(r:Receipt,after:LiveState,now:number,observer:string,previous?:IsolationWindow):
 {ready:boolean;reason:string;window?:IsolationWindow;itemId?:number;evidence?:string[]} {
  const no=(reason:string)=>({ready:false,reason});
  if(r.scope!=='task'||!['bankDeposit','bankWithdraw'].includes(r.action.type))return no('NOT_AN_ISOLATABLE_BANK_TRANSFER');
  if(r.before?._advanced)return no('ADVANCED_EXECUTOR_RECONCILIATION_REQUIRED');
  const container=r.action.type==='bankWithdraw'?'bank':'inventory';
  const ref=r.action.itemRefs?.find(v=>v.field==='slot'&&v.container===container);
  const original=container==='bank'?r.before.bank?.items:r.before.inventory;
  const itemId=ref?.id??original?.find((i:any)=>i.slot===r.action.fields?.slot)?.id;
  if(!Number.isInteger(itemId)||itemId<0)return no('ORIGINAL_TRANSFER_IDENTITY_MISSING');
  for(const field of ['character','world','profileId'])if(r.before[field]!==undefined&&r.before[field]!==after[field])return no('ACTOR_OR_WORLD_MISMATCH');
  const p=after.player, inv=counts(after.inventory), gear=counts(after.equipment);
  if(after.inGame!==true||!p||p.isDead||!(p.hp>0)||p.lifeId==null||p.animId!==-1||p.combat?.inCombat!==false
    ||p.combat?.targetType&&p.combat.targetType!=='none'||after.danger?.active===true)return no('CURRENT_IDLE_SAFE_STATE_REQUIRED');
  const damage=Number(p.combat?.lastDamageTick);
  if(Number.isFinite(damage)&&damage>=0&&after.tick-damage>=0&&after.tick-damage<=10)return no('RECENT_DAMAGE');
  if(![p.worldX,p.worldZ,p.level,after.tick,now,r.startedAt].every(Number.isFinite)||now<r.startedAt
    ||!inv||!gear||!Array.isArray(after.skills)||(after.unavailable??[]).some((v:string)=>['inventory','equipment','activity'].includes(v)))return no('CURRENT_ACCOUNTING_INCOMPLETE');
  const bankOpen=after.bank?.isOpen;
  if(typeof bankOpen!=='boolean'||after.shop?.isOpen!==false||after.dialog?.isOpen!==false
    ||after.dialog?.isWaiting===true||after.modalOpen===true&&!bankOpen)return no('CURRENT_ACCOUNTING_INTERFACES_REQUIRED');
  const bank=bankOpen?counts(after.bank.items):undefined;
  if(bankOpen&&!bank)return no('CURRENT_BANK_ACCOUNTING_INCOMPLETE');
  // Historical life/session changes are preserved, not converted to losses. The
  // *new* baseline must be continuous. Replay ticks never advance this window.
  const fingerprint=hash([r.commandId,after.character,after.world,after.worldEpoch,after.sessionId,after.profileId,
    p.lifeId,p.respawnCount,p.worldX,p.worldZ,p.level,p.hp,inv,gear,after.skills,bankOpen,bank]);
  const continuous=previous?.observer===observer&&previous.fingerprint===fingerprint&&now>=previous.at
    &&now-previous.at<=10_000&&after.tick>previous.tick;
  const window={observer,fingerprint,since:continuous?previous.since:now,at:now,tick:after.tick};
  if(now-window.since<30_000)return {ready:false,window,reason:'OBSERVING_CURRENT_BASELINE_FOR_ISOLATION'};
  return {ready:true,window,itemId,reason:'Historical bank outcome remains unresolved; permit only independent non-economic discovery.',
    evidence:[`continuous-current-baseline:${window.since}->${now}`,`current-life:${p.lifeId}`,
      'No success, failure, loss, wealth gain, or server cancellation inferred.',
      'All bank, shop, item-use, reward-choice and combat operations remain barred; no timeout or new command ID lifts isolation.']};
}
/** Durable containment is enforced at dispatch, not just by hiding planner goals. */
export function isolatedActionAllowed(action:LiveCandidate,state:LiveState):boolean {
  if(['wait','scanNearbyLocs','walkTo','retreat','closeModal','closeShop'].includes(action.type))return true;
  if(action.type!=='interactLoc')return false;
  const f=action.fields??{},p=state.player;
  const loc=(state.nearbyLocs??[]).find((l:any)=>l.id===f.locId&&l.x===f.x&&l.z===f.z&&Number(l.level??p?.level)===p?.level);
  return loc?.reachable===true&&/^(?:large |double |wooden |stone )?(?:door|gate|stairs|staircase|ladder|trapdoor)$/i.test(String(loc.name??''))&&!!transitionOption(loc)&&transitionOption(loc)!.opIndex===f.optionIndex;
}
export const transferFingerprint=(r:Receipt,itemId:number)=>hash([r.action.type,itemId,r.action.fields?.amount]);
