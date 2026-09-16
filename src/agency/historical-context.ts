import { createHash } from 'node:crypto';
import { stepKey, type StepAction } from './step-retry.ts';
import { BANK_TRANSACTION_TYPES, transactionIdentity, TRANSACTION_QUARANTINE_AFTER_MS } from './transaction-quarantine.ts';
import type { LiveState } from './world-model.ts';

export const HISTORICAL_QUIET_MS = 30_000;
export type HistoricalWindow = { observer:string; fingerprint:string; since:number; at:number; tick:number; samples:number };
export type HistoricalAssessment = { settled:boolean; reason:string; window?:HistoricalWindow; evidence:string[] };
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** This is an administrative identity, not an outcome contract. An original menu
 * observation is required for transitions; unknown rewards/choices never qualify. */
export function historicalActionIdentity(action:StepAction, before:LiveState):
  {semanticKey:string; itemIds:Array<number|string>; kind:'bank'|'navigation'}|undefined {
  if (BANK_TRANSACTION_TYPES.has(action.type)) {
    const bank=transactionIdentity(action,before);
    return bank && {...bank,kind:'bank'};
  }
  const f=action.fields??{};
  if (action.type==='interactLoc') {
    const loc=(before.nearbyLocs??[]).find((l:any)=>l.id===f.locId&&l.x===f.x&&l.z===f.z);
    const option=loc?.optionsWithIndex?.find((o:any)=>o.opIndex===f.optionIndex)?.text;
    if (!loc || !/^(open|close|climb(?:-up|-down)?)$/i.test(String(option??''))
      || /chest|coffin|altar|lever/i.test(String(loc.name??''))) return;
  } else if (action.type==='walkTo') {
    if (![f.x,f.z,f.level??before.player?.level].every(Number.isFinite)) return;
  } else if (action.type!=='retreat') return;
  return {semanticKey:'navigation:'+stepKey(action,before),itemIds:[],kind:'navigation'};
}

const validRows=(rows:unknown):rows is any[]=>Array.isArray(rows)&&rows.every(i=>i&&Number.isSafeInteger(i.id)&&i.id>=0
  &&Number.isSafeInteger(i.slot)&&i.slot>=0&&Number.isSafeInteger(i.count??1)&&(i.count??1)>=0)
  &&new Set(rows.map(i=>i.slot)).size===rows.length;
const rowsMark=(rows:any[])=>rows.map(i=>[i.slot,i.id,i.count??1]).sort((a,b)=>a[0]-b[0]);

/** Freshness is measured BETWEEN CURRENT observations, not against an old game's
 * tick counter. A reset/transition never proves what an old command did.
 * This helper sends no commands, alters no old snapshot, and grants no reward. */
export function observeHistoricalContext(action:StepAction,before:LiveState,after:LiveState,
  startedAt:number,now:number,observer:string,previous?:HistoricalWindow):HistoricalAssessment {
  const no=(reason:string):HistoricalAssessment=>({settled:false,reason,evidence:[]});
  const binding=historicalActionIdentity(action,before),a=after.player,b=before.player;
  if (!binding) return no('Historical operation has no supported administrative retirement contract.');
  if (![startedAt,now].every(Number.isFinite)||now-startedAt<TRANSACTION_QUARANTINE_AFTER_MS)
    return no('Historical reconciliation age threshold not reached; no replay is authorized.');
  if (!a||!b||!Number.isSafeInteger(before.tick)||before.tick<0)
    return no('Original action context is incomplete; do not invent a historical observation.');
  for (const field of ['character','world','profileId'] as const)
    if (before[field]!==undefined&&before[field]!==after[field]) return no('Historical actor, world or profile does not match.');

  const lifeChanged=b.lifeId!=null&&a.lifeId!=null&&b.lifeId!==a.lifeId;
  const epochChanged=before.worldEpoch!=null&&after.worldEpoch!=null&&before.worldEpoch!==after.worldEpoch;
  const tickOrderLost=Number.isSafeInteger(after.tick)&&after.tick<before.tick;
  const planeChanged=b.level!=null&&a.level!=null&&b.level!==a.level;
  const source=action.type==='bankWithdraw'?before.bank?.items:before.inventory;
  const originalSourceMissing=binding.kind==='bank'&&(before.bank?.isOpen!==true||!Array.isArray(source)
    ||!source.some((i:any)=>i.slot===action.fields?.slot&&binding.itemIds.some(id=>String(id)===String(i.id))));
  if (!(lifeChanged||epochChanged||tickOrderLost||binding.kind==='navigation'&&planeChanged||originalSourceMissing))
    return no('Historical attribution loss is not established; elapsed time or a local session change is insufficient.');

  if (after.inGame!==true||a.isDead||!Number.isFinite(a.hp)||a.hp<=0||a.animId!==-1
    ||a.combat?.inCombat!==false||a.combat?.targetType==='player'||after.danger?.active===true
    ||after.manualControl===true||after.control?.mode==='MANUAL'||after.control?.disabled===true)
    return no('Historical retirement requires current connected, alive, idle, sole-controller observations.');
  const damage=Number(a.combat?.lastDamageTick);
  if(Number.isFinite(damage)&&damage>=0&&after.tick-damage>=0&&after.tick-damage<=10)
    return no('Recent damage prevents historical retirement; safety takes priority.');
  if (![after.tick,a.worldX,a.worldZ,a.level].every(Number.isSafeInteger)||after.tick<0||a.lifeId==null)
    return no('Complete current position, life and tick evidence is required.');
  const fresh=after._advanced?.fresh_at;
  if (fresh!==undefined&&(fresh===null||!Number.isFinite(fresh)||fresh>now||now-fresh>10_000))
    return no('Current observation is stale; historical retirement is not authorized.');
  if (after.dialog?.isOpen===true||after.shop?.isOpen===true||after.modalOpen===true&&after.bank?.isOpen!==true)
    return no('An active choice or unresolved interface prevents historical retirement.');
  if (!validRows(after.inventory)||!validRows(after.equipment)||after.inventoryComplete===false||after.equipmentComplete===false)
    return no('Complete current inventory and equipment accounting is required.');
  if (after.bank?.isOpen===true&&(after.bank.complete===false||!validRows(after.bank.items)))
    return no('The currently open bank observation is incomplete.');

  const fingerprint=digest([binding.semanticKey,before.tick,b.lifeId,b.level,before.worldEpoch,
    after.character,after.world,after.worldEpoch,after.sessionId,after.profileId,
    a.lifeId,a.respawnCount,a.worldX,a.worldZ,a.level,a.hp,
    rowsMark(after.inventory),rowsMark(after.equipment),after.bank?.isOpen,
    after.bank?.isOpen===true?rowsMark(after.bank.items):null,
    (after.skills??[]).map((s:any)=>[s.name,s.experience??s.xp,s.baseLevel??s.level]).sort(),
    after.dialog?.isOpen,after.shop?.isOpen,after.modalOpen,after.combatStyle?.currentStyle]);
  const continuous=previous?.observer===observer&&previous.fingerprint===fingerprint
    &&now>=previous.at&&now-previous.at<=10_000&&after.tick>previous.tick;
  const window:HistoricalWindow={observer,fingerprint,since:continuous?previous.since:now,at:now,tick:after.tick,
    samples:continuous?previous.samples+1:1};
  const settled=window.samples>=2&&now-window.since>=HISTORICAL_QUIET_MS;
  const boundaries=[lifeChanged?'life':null,epochChanged?'epoch':null,tickOrderLost?'tick-order':null,
    planeChanged?'plane':null,originalSourceMissing?'original-source':null].filter(Boolean).join(',');
  return {settled,window,
    reason:settled?'Historical context unavailable; current state is quiescent. Preserve uncertainty and replan without replay.'
      :'Observing a fresh current-context quiet window before historical quarantine; no old tick or outcome is assumed.',
    evidence:settled?[`historical-context-boundary:${boundaries}`,`current-quiet-observations:${window.samples}:${window.since}->${now}`,
      'Historical effects and losses remain unknown; current accounting is not proof of the old outcome.',
      ...(binding.kind==='navigation'?['historical-navigation-context']:[])]:[]};
}
