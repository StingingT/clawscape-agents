import { createHash } from 'node:crypto';
import type { LiveState } from './world-model.ts';
import type { StepAction } from './step-retry.ts';

export const HISTORICAL_QUIET_MS = 30_000;
export type HistoricalWindow = {
  observer: string; fingerprint: string; loss: string; since: number;
  at: number; tick: number; samples: number;
};
export type HistoricalAssessment = {
  settled: boolean; reason: string; evidence: string[]; window?: HistoricalWindow;
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rowsValid = (rows: unknown): rows is Array<Record<string, any>> => Array.isArray(rows)
  && rows.every(i => i && Number.isSafeInteger(i.id) && i.id >= 0 && Number.isSafeInteger(i.slot)
    && i.slot >= 0 && Number.isSafeInteger(i.count ?? 1) && (i.count ?? 1) >= 0)
  && new Set(rows.map(i => i.slot)).size === rows.length;
const rowsMark = (rows: Array<Record<string, any>>) => rows.map(i => [i.slot, i.id, i.count ?? 1]).sort((a,b) => a[0]-b[0]);

/** Local client restarts alone are NOT evidence of historical attribution loss. */
export function historicalContextLoss(before: LiveState, current: LiveState, allowPlane = false): string | undefined {
  if (!before.player || !current.player) return;
  for (const field of ['character', 'world', 'profileId'] as const)
    if (before[field] !== undefined && current[field] !== before[field]) return;
  if (before.worldEpoch !== undefined && current.worldEpoch !== undefined && before.worldEpoch !== current.worldEpoch)
    return 'observed-server-epoch-change';
  const a = before.player, b = current.player;
  if (a.lifeId != null && b.lifeId != null && a.lifeId !== b.lifeId) return 'observed-life-context-change';
  if (Number.isFinite(a.respawnCount) && Number.isFinite(b.respawnCount) && a.respawnCount !== b.respawnCount)
    return 'observed-respawn-context-change';
  if (allowPlane && Number.isFinite(a.level) && Number.isFinite(b.level) && a.level !== b.level)
    return 'observed-traversal-plane-change';
  // Raw SDK snapshots can omit epoch/session metadata. A lower tick is only a
  // hypothesis here: observeHistoricalContext requires a new continuous window.
  if (Number.isSafeInteger(before.tick) && Number.isSafeInteger(current.tick) && current.tick < before.tick)
    return 'observed-tick-origin-reset';
}

/** These are ordinary captured traversal primitives, not unknown rewards or choices. */
export function historicalTraversal(action: StepAction, before: LiveState): boolean {
  if (action.type === 'walkTo' || action.type === 'retreat') return true;
  if (action.type !== 'interactLoc') return false;
  const f = action.fields ?? {}, p = before.player;
  const loc = (before.nearbyLocs ?? []).find((l: any) => l.id === f.locId && l.x === f.x && l.z === f.z
    && Number(l.level ?? p?.level) === Number(p?.level));
  const option = (loc?.optionsWithIndex ?? []).find((o: any) => o.opIndex === f.optionIndex);
  return !!loc && /^(open|close|climb(?:-up|-down)?)$/i.test(String(option?.text))
    && !/chest|coffin|altar|lever|reward|trap/i.test(String(loc.name));
}

function fingerprint(before: LiveState, current: LiveState, allowPlane: boolean): { value: string; loss: string } | undefined {
  const loss = historicalContextLoss(before, current, allowPlane), p = current.player;
  if (!loss || current.inGame !== true || !p || p.isDead || !(p.hp > 0) || p.animId !== -1
    || p.combat?.inCombat !== false || current.danger?.active === true
    || current.dialog?.isOpen !== false || current.shop?.isOpen === true
    || current.modalOpen === true && current.bank?.isOpen !== true
    || p.combat?.targetType && p.combat.targetType !== 'none'
    || ![current.tick,p.worldX,p.worldZ,p.level,p.hp].every(Number.isFinite)
    || !Number.isSafeInteger(current.tick) || current.tick < 0
    || !rowsValid(current.inventory) || !rowsValid(current.equipment) || !Array.isArray(current.skills)
    || current.inventoryComplete === false || current.equipmentComplete === false) return;
  const damageTick = Number(p.combat?.lastDamageTick);
  if (Number.isFinite(damageTick) && damageTick >= 0 && current.tick - damageTick >= 0 && current.tick - damageTick <= 10) return;
  if (current.bank?.isOpen === true && (current.bank.complete === false || !rowsValid(current.bank.items))) return;
  const value = hash([
    loss, before.tick, before.character, before.world, before.worldEpoch, before.profileId,
    before.player?.lifeId, before.player?.respawnCount, before.player?.level,
    current.character, current.world, current.worldEpoch, current.profileId, current.sessionId,
    p.lifeId, p.respawnCount, p.level, p.worldX, p.worldZ, p.hp,
    rowsMark(current.inventory), rowsMark(current.equipment), current.skills,
    current.bank?.isOpen, current.bank?.isOpen ? rowsMark(current.bank.items) : null,
    current.dialog?.isOpen, current.shop?.isOpen, current.modalOpen
  ]);
  return {value, loss};
}

/** Freshness is measured BETWEEN current observations, never against an obsolete
 * tick origin. This authorizes administrative interruption/quarantine only. */
export function observeHistoricalContext(before: LiveState, current: LiveState, now: number,
  observer: string, previous?: HistoricalWindow, allowPlane = false): HistoricalAssessment {
  const mark = fingerprint(before, current, allowPlane);
  if (!mark || !Number.isFinite(now)) return {settled:false, reason:'Historical context recovery needs complete, same-owner, quiet current observations and observed context loss.', evidence:[]};
  const continuous = previous?.observer === observer && previous.fingerprint === mark.value
    && now >= previous.at && now - previous.at <= 10_000 && current.tick > previous.tick;
  const window: HistoricalWindow = {observer, fingerprint:mark.value, loss:mark.loss,
    since:continuous ? previous.since : now, at:now, tick:current.tick,
    samples:continuous ? previous.samples + 1 : 1};
  const settled = window.samples >= 3 && now - window.since >= HISTORICAL_QUIET_MS;
  return {window, settled,
    reason:settled ? 'Historical command context ended; preserve its unknown outcome and replan from the measured current context.'
      : 'Observing a fresh 30-second current-context window; the historical command is not replayed.',
    evidence:settled ? [mark.loss, `current-context-window:${window.since}:${now}:${window.samples}`,
      'Administrative retirement only; no historical success, failure, death count, loss value or learning reward inferred.'] : []};
}

/** A caller cannot turn a reason string or expired timer into settlement evidence. */
export function historicalWindowReady(before: LiveState, current: LiveState, now: number,
  observer: string, window: HistoricalWindow | undefined, allowPlane = false): boolean {
  const mark = fingerprint(before,current,allowPlane);
  return !!mark && !!window && window.observer === observer && window.fingerprint === mark.value
    && current.tick === window.tick && Number.isFinite(now) && now >= window.at && now - window.at <= 10_000
    && window.samples >= 3 && window.at - window.since >= HISTORICAL_QUIET_MS;
}
