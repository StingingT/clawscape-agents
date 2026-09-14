import { createHash } from 'node:crypto';
import type { LiveState } from './world-model.ts';

export type StepAction = { type: string; fields?: Record<string, any> };
export type Viability = {
  state: 'viable' | 'uncertain' | 'temporarily-poor';
  attempts: number; at: number; retryAt: number; context: string; learningRevision: number;
  reason: string; evidence: string[];
};
export type QuietWindow = { fingerprint: string; since: number; at: number; tick: number; observer: string };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const quantity = (items: any[] | undefined, id: any) => (items ?? []).filter(i => String(i.id) === String(id))
  .reduce((n, i) => n + Number(i.count ?? 1), 0);

/** Stable method-step identity; ephemeral action IDs and NPC indices are not memories. */
export function stepKey(action: StepAction, state: LiveState): string {
  const f = action.fields ?? {};
  const npc = (state.nearbyNpcs ?? []).find((n: any) => n.index === f.npcIndex);
  const item = (state.inventory ?? []).find((i: any) => i.slot === (f.slot ?? f.sourceSlot ?? f.itemSlot));
  const option = npc?.optionsWithIndex?.find((o: any) => o.opIndex === f.optionIndex)?.text;
  return digest([action.type, f.x, f.z, f.level, f.locId, npc?.id, npc?.name, option, item?.id,
    f.style, f.optionIndex, f.itemId, f.amount, f.targetSlot]);
}
export function retryAllowed(v: Viability | undefined, at: number, context: string, learningRevision: number): boolean {
  return !v || v.state === 'viable' || (at >= v.at &&
    (at >= v.retryAt || context !== v.context || learningRevision > v.learningRevision));
}
export function recordViability(old: Viability | undefined, status: 'verified' | 'rejected' | 'interrupted',
  at: number, context: string, learningRevision: number, evidence: string[], reason: string): Viability {
  const attempts = (old?.attempts ?? 0) + 1;
  return { state: status === 'verified' ? 'viable' : status === 'interrupted' ? 'uncertain' : 'temporarily-poor',
    attempts, at, retryAt: status === 'verified' ? at : at + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 6)),
    context, learningRevision, evidence: evidence.slice(0, 8), reason };
}

/**
 * Some actions mutate state when they succeed, but a long, stable observation can prove
 * that the expected observable mutation did not happen. This is deliberately narrower
 * than "timeout means failed": purchases, transfers, production-dialogue choices and
 * other actions with hidden/delayed effects are excluded.
 */
function observableNoEffect(action: StepAction, before: LiveState, after: LiveState): boolean {
  const f = action.fields ?? {};
  if (!['useItemOnItem', 'useItemOnLoc', 'interactNpc', 'interactLoc', 'talkToNpc'].includes(action.type)) return false;
  if (!Array.isArray(before.inventory) || !Array.isArray(after.inventory)
    || !Array.isArray(before.equipment) || !Array.isArray(after.equipment)) return false;
  if (!same(before.inventory, after.inventory) || !same(before.equipment, after.equipment)
    || !same(before.skills, after.skills) || !same(before.dialog, after.dialog)
    || !same(before.bank, after.bank) || !same(before.shop, after.shop)
    || before.modalOpen !== after.modalOpen || !same(before.player?.combat, after.player?.combat)) return false;

  if (action.type === 'useItemOnItem' || action.type === 'useItemOnLoc') {
    const sourceSlot = f.sourceSlot ?? f.itemSlot;
    const source = before.inventory.find((i: any) => i.slot === sourceSlot);
    if (!source || quantity(after.inventory, source.id) !== quantity(before.inventory, source.id)) return false;
    if (action.type === 'useItemOnItem') {
      const target = before.inventory.find((i: any) => i.slot === f.targetSlot);
      if (!target || quantity(after.inventory, target.id) !== quantity(before.inventory, target.id)) return false;
    }
    return true;
  }
  if (action.type === 'interactNpc' || action.type === 'talkToNpc') {
    const oldNpc = (before.nearbyNpcs ?? []).find((n: any) => n.index === f.npcIndex);
    if (!oldNpc) return false;
    return (after.nearbyNpcs ?? []).some((n: any) => n.id === oldNpc.id && n.name === oldNpc.name);
  }
  if (action.type === 'interactLoc') {
    return (after.nearbyLocs ?? []).some((n: any) => n.id === f.locId && n.x === f.x && n.z === f.z);
  }
  return false;
}

/** An unknown transaction is NOT made safe by elapsed time or new knowledge.
 * Known transient commands, plus a narrow set of actions whose non-effect can be
 * established from stable state, can be abandoned without asserting success. */
export function observeQuietStep(action: StepAction, before: LiveState, after: LiveState, now: number,
  observer: string, previous?: QuietWindow): { window?: QuietWindow; settled: boolean; reason: string } {
  const no = (reason: string) => ({ settled: false, reason });
  const transient = ['walkTo', 'retreat', 'closeModal', 'closeShop', 'setCombatStyle'].includes(action.type);
  const provedNoEffect = observableNoEffect(action, before, after);
  if (!transient && !provedNoEffect)
    return no('This operation requires attributable outcome evidence; a timeout cannot authorize replay.');
  const a = after.player, b = before.player;
  if (!a || !b || after.inGame !== true || a.isDead || !(a.hp > 0) || a.animId !== -1
    || a.combat?.inCombat !== false || (a.combat.targetType && a.combat.targetType !== 'none'))
    return no('Need a connected, alive, stationary, explicitly idle observation.');
  if (a.lifeId == null || a.lifeId !== b.lifeId || a.level !== b.level || a.respawnCount !== b.respawnCount)
    return no('Life or plane changed; reconcile losses separately.');
  for (const field of ['character', 'world', 'worldEpoch', 'profileId'])
    if (before[field] !== undefined && before[field] !== after[field]) return no('Actor or world continuity changed.');
  if (![before.tick, after.tick, a.worldX, a.worldZ, a.level, now].every(Number.isFinite) || after.tick <= before.tick)
    return no('Fresh increasing observation ticks and complete coordinates required.');
  if (!Array.isArray(after.inventory) || !Array.isArray(after.equipment)) return no('Accounting observation is incomplete.');
  if (['closeModal', 'closeShop'].includes(action.type)) {
    if (action.type === 'closeShop' ? after.shop?.isOpen !== false :
      ![after.modalOpen, after.bank?.isOpen, after.shop?.isOpen, after.dialog?.isOpen].includes(false)
      || [after.modalOpen, after.bank?.isOpen, after.shop?.isOpen, after.dialog?.isOpen].includes(true))
      return no('Requested interface closure is not established.');
  }
  if (action.type === 'setCombatStyle' && !Number.isInteger(after.combatStyle?.currentStyle))
    return no('Current combat style must be observed before replanning.');
  const fingerprint = digest([after.character, after.world, after.worldEpoch, after.sessionId, after.profileId,
    a.lifeId, a.respawnCount, a.worldX, a.worldZ, a.level, a.hp, after.inventory, after.equipment,
    after.skills, after.bank, after.shop, after.dialog, after.modalOpen, after.combatStyle,
    provedNoEffect ? [action.type, action.fields] : undefined]);
  const continuous = previous?.observer === observer && previous.fingerprint === fingerprint
    && now >= previous.at && now - previous.at <= 60_000 && after.tick > previous.tick;
  const window = { observer, fingerprint, since: continuous ? previous.since : now, at: now, tick: after.tick };
  const settled = now - window.since >= 30_000;
  const completedReason = provedNoEffect
    ? 'Action retired as interrupted after a continuous quiet window proved no observable effect; success is not inferred and retry remains cooldown-bound.'
    : 'Transient step interrupted after a continuous quiet window; no success or replay inferred.';
  return { window, settled,
    reason: settled ? completedReason : 'Observing a 30-second quiet window before retiring this transient step.' };
}
