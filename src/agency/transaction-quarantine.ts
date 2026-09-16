import { createHash } from 'node:crypto';
import type { LiveState } from './world-model.ts';

export const TRANSACTION_QUARANTINE_AFTER_MS = 120_000;
export const BANK_TRANSACTION_TYPES = new Set(['bankDeposit','bankWithdraw']);
export type QuarantinedTransaction = {
  at:number; commandId:string; type:string; semanticKey:string; itemIds:Array<number|string>;
  reason:string; evidence:string[]; goalKey?:string; active:boolean;
  originalReceipt?:unknown;
  observation?:{tick:number;sessionId?:string;character?:string;world?:string;worldEpoch?:string;profileId?:string};
  releasedAt?:number; releaseEvidence?:string[];
};
type Action = {type:string;fields?:Record<string,any>;itemRefs?:Array<{container?:string;id?:number|string;minimum?:number}>};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exactItem=(action:Action,before:LiveState)=>{
  if(action.itemRefs?.length)return action.itemRefs.map(r=>r.id).filter((id):id is number|string=>id!==undefined);
  const rows=action.type==='bankWithdraw'?(before.bank?.items??[]):(before.inventory??[]);
  const row=rows.find((i:any)=>i.slot===action.fields?.slot);
  return row?.id===undefined?[]:[row.id];
};
export function transactionIdentity(action:Action,before:LiveState):{semanticKey:string;itemIds:Array<number|string>}|undefined {
  if(!BANK_TRANSACTION_TYPES.has(action.type))return;
  const itemIds=exactItem(action,before);
  if(!itemIds.length)return;
  return {itemIds,semanticKey:digest([action.type,itemIds.map(String).sort(),Number(action.fields?.amount??0)])};
}
const idle=(s:LiveState)=>s.inGame===true&&!!s.player&&!s.player.isDead&&Number(s.player.hp)>0
  &&s.player.combat?.inCombat!==true&&s.danger?.active!==true&&s.dialog?.isOpen!==true;
const validRows=(rows:unknown)=>Array.isArray(rows)&&rows.every(i=>i&&Number.isSafeInteger(i.id)&&i.id>=0
  &&Number.isSafeInteger(i.slot)&&i.slot>=0&&Number.isSafeInteger(i.count??1)&&(i.count??1)>=0)
  &&new Set(rows.map(i=>i.slot)).size===rows.length;

/** Quarantine preserves uncertainty, rather than turning a timeout into success or failure. */
export function quarantineEligible(action:Action,before:LiveState,after:LiveState,startedAt:number,now:number,reason:string):boolean {
  if(!BANK_TRANSACTION_TYPES.has(action.type)||![startedAt,now].every(Number.isFinite)
    ||now-startedAt<TRANSACTION_QUARANTINE_AFTER_MS||!idle(after)||!before.player)return false;
  if(!/original bank source unavailable|life changed/i.test(reason))return false;
  if(!Array.isArray(after.inventory)||!Number.isFinite(before.tick)||!Number.isFinite(after.tick)||after.tick<=before.tick)return false;
  for(const field of ['character','world','worldEpoch','profileId'] as const)
    if(before[field]!==undefined&&after[field]!==before[field])return false;
  // A caller's reason string is not proof: require the corresponding observed condition.
  const lifeChanged=before.player.lifeId!==undefined&&after.player.lifeId!==undefined&&before.player.lifeId!==after.player.lifeId;
  const source=action.type==='bankWithdraw'?before.bank?.items:before.inventory;
  const sourceUnavailable=before.bank?.isOpen!==true||after.bank?.isOpen!==true
    ||!Array.isArray(source)||!source.some((i:any)=>i.slot===action.fields?.slot);
  return (lifeChanged||sourceUnavailable)&&!!transactionIdentity(action,before);
}
export function conflictsWithQuarantine(entry:QuarantinedTransaction,action:Action,state:LiveState):boolean {
  if(!entry.active||!BANK_TRANSACTION_TYPES.has(action.type))return false;
  const current=transactionIdentity(action,state);
  return !current||current.itemIds.some(id=>entry.itemIds.some(old=>String(old)===String(id)));
}

/** A newer complete bank/inventory observation establishes present balances only.
 * The original receipt and its unknown outcome remain in the audit; its command ID is never reusable. */
export function releaseFromFreshAccounting(entry:QuarantinedTransaction,state:LiveState,now:number):QuarantinedTransaction {
  if(!entry.active||!idle(state)||!Number.isFinite(now)||now<entry.at||state.bank?.isOpen!==true
    ||state.bank?.complete===false||!validRows(state.bank?.items)||!validRows(state.inventory)||!Number.isFinite(state.tick))return entry;
  if(entry.observation){
    for(const field of ['character','world','worldEpoch','profileId'] as const)
      if(entry.observation[field]!==undefined&&state[field]!==entry.observation[field])return entry;
    // A local client restart may change the tick origin, but never restores the old command.
    const newSession=entry.observation.sessionId!==undefined&&state.sessionId!==undefined&&state.sessionId!==entry.observation.sessionId;
    if(!newSession&&state.tick<=entry.observation.tick)return entry;
  }
  return {...entry,active:false,releasedAt:now,
    releaseEvidence:[`fresh-authoritative-bank-snapshot:${state.tick}`,'Historical outcome remains unknown; new transactions require current-state planning.']};
}
