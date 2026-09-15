import { createHash } from 'node:crypto';
import { obsoleteEmptyRecipe } from './item-intents.ts';
import type { LiveState } from './world-model.ts';

export type StepAction = { type: string; fields?: Record<string, any> };
export type Viability = {
  state: 'viable' | 'uncertain' | 'temporarily-poor';
  attempts: number; at: number; retryAt: number; context: string; learningRevision: number;
  reason: string; evidence: string[];
};
export type QuietWindow = { fingerprint: string; since: number; at: number; tick: number; observer: string };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Stable method-step identity; ephemeral action IDs and NPC indices are not memories. */
export function stepKey(action: StepAction, state: LiveState): string {
  const f = action.fields ?? {};
  const npc = (state.nearbyNpcs ?? []).find((n: any) => n.index === f.npcIndex);
  const item = (state.inventory ?? []).find((i: any) => i.slot === (f.slot ?? f.sourceSlot ?? f.itemSlot));
  const option = npc?.optionsWithIndex?.find((o: any) => o.opIndex === f.optionIndex)?.text;
  const refs=(action as any).itemRefs;
  if(refs?.length)return digest([action.type,refs.map((r:any)=>[r.container,r.id,r.minimum,r.option]),f.x,f.z,f.locId]);
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

/** Only repeatable, resource-local activity can be interrupted from current idle state.
 * This does NOT prove historical non-execution. Transactions, rewards and generic talk
 * remain strict; a fresh subsequent command must revalidate its own materials/options. */
function repeatableActivity(action: StepAction, before: LiveState): boolean {
  const f=action.fields??{};
  const option=(entity:any)=>(entity?.optionsWithIndex??[]).find((o:any)=>o.opIndex===f.optionIndex)?.text??'';
  if(action.type==='interactNpc') {
    const npc=(before.nearbyNpcs??[]).find((n:any)=>n.index===f.npcIndex);
    return /^(attack|net|small net|small-net|bait|lure|harpoon|cage|fish)$/i.test(option(npc))
      || /^(bank|use-quickly)$/i.test(option(npc))&&/^banker$/i.test(String(npc?.name))
      || /^trade$/i.test(option(npc))&&/^(gerrant|aubury|lowe|bob|shop keeper|shop assistant)$/i.test(String(npc?.name));
  }
  if(action.type==='interactLoc') {
    const loc=(before.nearbyLocs??[]).find((n:any)=>n.id===f.locId&&n.x===f.x&&n.z===f.z);
    return /^(chop|chop down|chop-down|mine|open|close)$/i.test(option(loc))
      && !/chest|coffin|altar|lever/i.test(String(loc?.name));
  }
  if(action.type==='useItemOnItem') {
    const names=[f.sourceSlot??f.itemSlot,f.targetSlot].map(slot=>String((before.inventory??[]).find((i:any)=>i.slot===slot)?.name??'').toLowerCase());
    const pair=(a:RegExp,b:RegExp)=>a.test(names[0]!)&&b.test(names[1]!)||a.test(names[1]!)&&b.test(names[0]!);
    return pair(/^feathers?$/,/^arrow shafts?$/)||pair(/^headless arrows?$/,/^(bronze|iron|steel|mithril|adamant|rune) arrow(tips?|heads?)$/)
      ||pair(/^(knife|tinderbox)$/,/^(logs|oak logs|willow logs|maple logs|yew logs|magic logs)$/);
  }
  if(action.type==='useItemOnLoc') {
    const item=(before.inventory??[]).find((i:any)=>i.slot===(f.itemSlot??f.sourceSlot));
    const loc=(before.nearbyLocs??[]).find((l:any)=>l.id===f.locId&&l.x===f.x&&l.z===f.z);
    return /^raw (shrimps?|anchovies|trout|salmon|sardines?|herring|tuna|lobster|swordfish|chicken|beef)$/i.test(String(item?.name))
      && /^(range|fire|fireplace|stove|cooking pot)$/i.test(String(loc?.name));
  }
  return false;
}
const inventoryMark=(items:any[])=>items.map(i=>[String(i.id),Number(i.count??1),Number(i.slot)]).sort((a,b)=>Number(a[2])-Number(b[2]));
const skillMark=(skills:any[])=>skills.map(s=>[s.name,s.experience??s.xp,s.baseLevel??s.level]).sort();
/** An unknown transaction is NOT made safe by elapsed time or new knowledge.
 * Known transient commands and supported repeatable activity can be abandoned
 * from current quiescence, without claiming historical success or non-execution. */
export function observeQuietStep(action: StepAction, before: LiveState, after: LiveState, now: number,
  observer: string, previous?: QuietWindow): { window?: QuietWindow; settled: boolean; reason: string } {
  const no = (reason: string) => ({ settled: false, reason });
  // A pickup has no irreversible transaction/choice semantics. If its requested item
  // was never attributable, retire the stale receipt after fresh quiescence instead
  // of freezing the controller. A future pickup must be selected from fresh ground state.
  const transient = ['walkTo', 'retreat', 'closeModal', 'closeShop', 'setCombatStyle', 'pickupItem'].includes(action.type);
  const invalidRecipe = obsoleteEmptyRecipe(action, before, after);
  const repeatable = repeatableActivity(action, before) || invalidRecipe;
  if (!transient && !repeatable)
    return no('This operation requires attributable outcome evidence; a timeout cannot authorize replay.');
  const a = after.player, b = before.player;
  if (!a || !b || after.inGame !== true || a.isDead || !(a.hp > 0) || a.animId !== -1
    || a.combat?.inCombat !== false || (a.combat.targetType && a.combat.targetType !== 'none' && !(repeatable && a.combat.targetType==='npc')))
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
  if(repeatable && [after.dialog?.isOpen,after.bank?.isOpen,after.shop?.isOpen,after.modalOpen].some(v=>v===true))return no('An active interface must be observed/resolved; do not replay the initiating action.');
  const fingerprint = digest([after.character, after.world, after.worldEpoch, after.sessionId, after.profileId,
    a.lifeId, a.respawnCount, a.worldX, a.worldZ, a.level, a.hp, inventoryMark(after.inventory), inventoryMark(after.equipment),
    skillMark(after.skills??[]), after.bank?.isOpen, after.shop?.isOpen, after.dialog?.isOpen, after.modalOpen, after.combatStyle?.currentStyle,
    repeatable ? [action.type, action.fields] : undefined]);
  const continuous = previous?.observer === observer && previous.fingerprint === fingerprint
    && now >= previous.at && now - previous.at <= 60_000 && after.tick > previous.tick;
  const window = { observer, fingerprint, since: continuous ? previous.since : now, at: now, tick: after.tick };
  const settled = now - window.since >= 30_000;
  const completedReason = invalidRecipe
    ? 'Invalid historical tool/empty-slot context interrupted after fresh quiescence. Original effects remain unknown; no reward or non-execution inferred and no stale packet may be replayed.'
    : repeatable
    ? 'Repeatable activity interrupted: it is now idle after a continuous quiet window; historical effects are unknown, no success or non-execution is inferred, and any new action needs fresh validation.'
    : action.type==='pickupItem'
    ? 'Unattributed pickup interrupted after a continuous quiet window; no success is inferred and any future pickup requires a fresh visible ground item.'
    : 'Transient step interrupted after a continuous quiet window; no success or replay inferred.';
  return { window, settled,
    reason: settled ? completedReason : 'Observing a 30-second quiet window before retiring this transient step.' };
}
