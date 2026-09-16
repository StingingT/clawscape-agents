import { createHash } from 'node:crypto';
import type { LiveState } from './world-model.ts';

export const TRANSACTION_QUARANTINE_AFTER_MS = 120_000;
export const BANK_TRANSACTION_TYPES = new Set(['bankDeposit','bankWithdraw']);

export type QuarantinedTransaction = {
  at:number;
  commandId:string;
  type:string;
  semanticKey:string;
  itemIds:Array<number|string>;
  reason:string;
  evidence:string[];
  goalKey?:string;
  active:boolean;
  releasedAt?:number;
  releaseEvidence?:string[];
};

type Action = { type:string; fields?:Record<string,any>; itemRefs?:Array<{container?:string;id?:number|string;minimum?:number}> };

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exactItem=(action:Action,before:LiveState)=>{
  const f=action.fields??{};
  if(action.itemRefs?.length)return action.itemRefs.map(r=>r.id).filter((id):id is number|string=>id!==undefined);
  const rows=action.type==='bankWithdraw'?(before.bank?.items??[]):(before.inventory??[]);
  const row=rows.find((i:any)=>Number(i.slot)===Number(f.slot));
  return row?.id===undefined?[]:[row.id];
};

export function transactionIdentity(action:Action,before:LiveState):{semanticKey:string;itemIds:Array<number|string>}|undefined {
  if(!BANK_TRANSACTION_TYPES.has(action.type))return;
  const itemIds=exactItem(action,before);
  if(!itemIds.length)return;
  return {itemIds,semanticKey:digest([action.type,itemIds.map(String).sort(),Number(action.fields?.amount??0)])};
}

/** A transaction is quarantinable only when fresh evidence says historical attribution is no longer available.
 * Elapsed time by itself is deliberately insufficient. */
export function quarantineEligible(action:Action,before:LiveState,after:LiveState,startedAt:number,now:number,reason:string):boolean {
  if(!BANK_TRANSACTION_TYPES.has(action.type)||now-startedAt<TRANSACTION_QUARANTINE_AFTER_MS)return false;
  if(!/original bank source unavailable|life changed|transaction attribution|historical attribution unavailable/i.test(reason))return false;
  const a=after.player,b=before.player;
  if(after.inGame!==true||!a||!b||a.isDead||!(Number(a.hp)>0)||!Array.isArray(after.inventory)||!Number.isFinite(after.tick)||Number(after.tick)<=Number(before.tick))return false;
  for(const field of ['character','world','worldEpoch','profileId'] as const)
    if(before[field]!==undefined&&after[field]!==before[field])return false;
  return !!transactionIdentity(action,before);
}

export function conflictsWithQuarantine(entry:QuarantinedTransaction,action:Action,state:LiveState):boolean {
  if(!entry.active||!BANK_TRANSACTION_TYPES.has(action.type))return false;
  const current=transactionIdentity(action,state);
  if(!current)return false;
  return current.itemIds.some(id=>entry.itemIds.some(old=>String(old)===String(id)));
}

/** A complete fresh open-bank observation is an authoritative present-state baseline.
 * It does not resolve what the historical command did; it only permits future commands to be planned from current balances. */
export function releaseFromFreshAccounting(entry:QuarantinedTransaction,state:LiveState,now:number):QuarantinedTransaction {
  if(!entry.active||state.inGame!==true||state.player?.isDead||!(Number(state.player?.hp)>0)
    ||state.bank?.isOpen!==true||!Array.isArray(state.bank?.items)||!Array.isArray(state.inventory)||!Number.isFinite(state.tick))return entry;
  return {...entry,active:false,releasedAt:now,
    releaseEvidence:[`fresh-authoritative-bank-snapshot:${state.tick}`,'Historical outcome remains unknown; future transactions must use this fresh current state.']};
}
