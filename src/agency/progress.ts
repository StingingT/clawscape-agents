import { createHash } from 'node:crypto';
import type { Facts, Goal, Pending, Outcome, Requirement } from './types.ts';

export type ProgressAssessment = {
  at: number; commandId: string; verified: boolean; stateChanged: boolean;
  objective: boolean; prerequisite: boolean; learning: boolean; productive: boolean;
  cycle: boolean; reason: string;
};
export type ProgressLedger = {
  since: number; lastVerifiedAt?: number; lastStateChangeAt?: number;
  lastObjectiveAt?: number; lastPrerequisiteAt?: number; lastLearningAt?: number;
  lastProductiveAt?: number; noProgressActions: number; recentStates: string[];
  last?: ProgressAssessment;
};
export const PROGRESS_TIMEOUT_MS = 5 * 60_000;
const amount = (facts: Facts, fact: string) => facts[fact] ?? 0;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const counts = (items: any[], equipped = false) => {
  const result: Record<string, number> = {};
  for (const item of items) {
    const key = equipped ? `${item.slot}:${item.id}` : String(item.id);
    result[key] = (result[key] ?? 0) + Number(item.count ?? 1);
  }
  return Object.entries(result).sort(([a], [b]) => a.localeCompare(b));
};

/** Personal effect state only: no ticks, timestamps, packet IDs, NPC wandering,
 * inventory slot ordering or HP regeneration. A returned state is still a cycle
 * when a planner renamed its command, changed goal, or reloaded its journal. */
export function effectState(state: Record<string, any>, facts: Facts): string {
  const p = state.player;
  return hash([
    state.character, state.world, state.worldEpoch, p?.lifeId,
    [p?.worldX, p?.worldZ, p?.level], counts(state.inventory ?? []), counts(state.equipment ?? [], true),
    state.bank?.isOpen, state.shop?.isOpen, state.dialog?.isOpen, state.modalOpen, state.combatStyle?.currentStyle,
    Object.entries(facts).filter(([k]) => /^(xp:|owned:|visited:|discovered:|gathering:banked$)/.test(k)).sort(([a],[b])=>a.localeCompare(b)),
  ]);
}
const factState = (facts: Facts) => hash(Object.entries(facts).filter(([k]) => k !== 'hp').sort(([a],[b])=>a.localeCompare(b)));
const durable = (fact: string) => /^(xp:|owned:|visited:|discovered:|gathering:banked$)/.test(fact);

/** Two complete reversible cycles, rather than repeated action names (which
 * also occur in productive batches). Pauses at the same state add no new edge. */
export function reversibleCycle(states: string[]): boolean {
  for (const size of [2, 3, 4]) {
    if (states.length < size * 2 + 1) continue;
    const tail = states.slice(-size * 2 - 1);
    if (new Set(tail).size < 2) continue;
    if (tail.slice(size).every((value, i) => value === tail[i])) return true;
  }
  return false;
}

/** Only the dispatched plan's targets can earn causal progress. Re-satisfying
 * the same reversible prerequisite is not new progress until a downstream
 * durable result has occurred. Historical unknown/rejected outcomes earn none. */
export function recordProgress(ledger: ProgressLedger | undefined, goal: Goal, pending: Pending, outcome: Outcome): ProgressLedger {
  ledger ??= { since: outcome.at, noProgressActions: 0, recentStates: [] };
  const verified = ['verified','progress'].includes(outcome.status) && outcome.evidence.length > 0;
  goal.progressHighWater ??= { ...pending.before };
  const water = goal.progressHighWater;
  const advances = (target: Requirement) => verified && Math.min(amount(outcome.facts,target.fact),target.minimum)
    > Math.max(Math.min(amount(pending.before,target.fact),target.minimum), Math.min(amount(water,target.fact),target.minimum));
  const targets = pending.progressTargets ?? [goal.target];
  const rootExpected = (pending.method.effects[goal.target.fact] ?? 0) > 0;
  const objective = rootExpected && advances(goal.target);
  const advanced = targets.filter(target => target.fact !== goal.target.fact && advances(target));
  let prerequisite = advanced.length > 0;
  // Evidence-backed route approach is useful preparation; a worse/backtracking
  // route does not refresh the same goal's best-distance watermark.
  const approach = outcome.approach;
  if (verified && approach && [approach.before,approach.after].every(n=>Number.isFinite(n)&&n>=0)) {
    goal.approachBest ??= {};
    const best = goal.approachBest[approach.key] ?? approach.before;
    if (approach.after < Math.min(best,approach.before)) {
      prerequisite = true; goal.approachBest[approach.key] = approach.after;
    }
  }
  const investigationProgress=advanced.some(t=>goal.supportGoals?.some(s=>s.purpose==='investigate-blocker'
    &&s.id===pending.supportGoalId&&s.target.fact===t.fact));
  const learning = verified && (investigationProgress || [...Object.keys(pending.method.effects),...(pending.method.progressFacts??[])].some(fact => durable(fact)
    && amount(outcome.facts,fact) > Math.max(amount(pending.before,fact),amount(water,fact))));
  const durableResult = learning || objective && durable(goal.target.fact) || advanced.some(t=>durable(t.fact));
  const before = outcome.effectState?.before ?? factState(pending.before);
  const after = outcome.effectState?.after ?? factState(outcome.facts);
  let states = ledger.recentStates;
  if (durableResult) states = [];
  if (states.at(-1) !== before) states = [...states,before];
  if (states.at(-1) !== after) states = [...states,after];
  ledger.recentStates = states.slice(-17);
  const cycle = !durableResult && reversibleCycle(ledger.recentStates);
  const productive = verified && !cycle && (objective || prerequisite || learning);
  const stateChanged = before !== after;
  if (verified) ledger.lastVerifiedAt = outcome.at;
  if (stateChanged) ledger.lastStateChangeAt = outcome.at;
  if (productive) {
    ledger.lastProductiveAt = outcome.at;
    if (objective) ledger.lastObjectiveAt = goal.lastObjectiveProgressAt = outcome.at;
    if (prerequisite || learning && !objective) ledger.lastPrerequisiteAt = goal.lastSupportProgressAt = outcome.at;
    if (learning) ledger.lastLearningAt = outcome.at;
  }
  ledger.noProgressActions = productive ? 0 : ledger.noProgressActions + 1;
  if (verified) {
    // After genuine downstream production, the next input batch may earn
    // preparation credit again. Transfers alone cannot reset these watermarks.
    if (durableResult) goal.progressHighWater = { ...outcome.facts };
    else for (const target of targets) water[target.fact] = Math.max(amount(water,target.fact),amount(outcome.facts,target.fact));
  }
  ledger.last = { at:outcome.at,commandId:outcome.commandId,verified,stateChanged,objective,prerequisite,learning,productive,cycle,
    reason:cycle?'reversible-state-cycle':productive?objective?'objective-advanced':learning?'verified-learning':'plan-prerequisite-advanced'
      :verified?'verified-action-without-causal-progress':'no-verified-progress' };
  return ledger;
}

export function progressHealth(memory: { progress?: ProgressLedger; active?: Goal }, now: number) {
  const p=memory.progress;
  const since=p?.lastProductiveAt??p?.since??memory.active?.startedAt;
  return {
    lastVerifiedActionAt:p?.lastVerifiedAt??null,lastStateChangeAt:p?.lastStateChangeAt??null,
    lastProductiveAt:p?.lastProductiveAt??null,lastObjectiveProgressAt:p?.lastObjectiveAt??null,
    lastSupportProgressAt:p?.lastPrerequisiteAt??null,lastLearningAt:p?.lastLearningAt??null,
    noProgressActions:p?.noProgressActions??0,cycleDetected:p?.last?.cycle??false,
    productiveAgeMs:since===undefined?null:Math.max(0,now-since),
    stalled:!!p?.last?.cycle || since!==undefined && now-since>=PROGRESS_TIMEOUT_MS,
    lastProgressKind:p?.last?.reason??null,
  };
}
