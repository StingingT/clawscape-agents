export type CandidateLike = { id: string; type: string; fields?: Record<string, unknown> };
export const ACTION_PROGRESS_TIMEOUT_MS = 5 * 60_000;

export type AutonomyMemory = {
  active?: { intent: string; action: string; since: number; lastProgress: number; reason: string };
  stalled?: Record<string, { count: number; lastAt: number }>;
  recentActions?: string[];
};

const inventorySignature = (state: any) => [...(state.inventory ?? []), ...(state.equipment ?? [])]
  .map((item: any) => `${item.id}:${item.count ?? 1}`).sort().join('|');
const skillSignature = (state: any) => (state.skills ?? [])
  .map((skill: any) => `${skill.name}:${skill.level ?? skill.baseLevel}:${skill.experience ?? 0}`).sort().join('|');
const positionSignature = (state: any) => {
  const player = state.player ?? {};
  return `${player.worldX}:${player.worldZ}:${player.level}:${player.lifeId}`;
};
const nearbySignature = (state: any) => JSON.stringify([
  (state.nearbyNpcs ?? []).map((n: any) => [n.index,n.id,n.name,n.x,n.z,n.reachable]).sort(),
  (state.nearbyLocs ?? []).map((l: any) => [l.id,l.name,l.x,l.z,l.reachable]).sort(),
]);

// A scan gathers evidence, whereas wait only advances the server clock.
export const passive = (action: CandidateLike) => action.type === 'wait';

// Q learning is allowed to choose among meaningful alternatives, but an old
// high value for waiting must never suppress available work.
export function preferActive<T extends CandidateLike>(options: T[]): T[] {
  const active = options.filter(option => !passive(option));
  return active.length ? active : options;
}

export function intentFor(action: CandidateLike): string {
  if (action.id.startsWith('training-')) return 'measure-training-site';
  if (action.id.startsWith('goal-')) return 'acquire-or-fund-upgrade';
  if (action.id.startsWith('economy-')) return 'sustain-production-profit';
  if (/ammo|arrow|knife|fletch/i.test(action.id)) return 'restore-ranged-supplies';
  if (/fish|cook|food|heal/i.test(action.id)) return 'restore-survival-supplies';
  if (/explore|scan/i.test(action.id)) return 'discover-a-verified-next-step';
  return 'make-build-progress';
}

export function madeProgress(before: any, after: any, action: CandidateLike): boolean {
  if (action.type === 'scanNearbyLocs') return nearbySignature(before) !== nearbySignature(after);
  if (action.type === 'wait') return inventorySignature(before)!==inventorySignature(after) || skillSignature(before)!==skillSignature(after);
  // A harvesting attempt only counts when it actually produces an item or
  // experience. Incidental HP/position changes must not keep an empty tree,
  // mine, fishing spot or thieving target alive forever.
  if (action.type === 'interactLoc' && /^(economy-|gather-safe|chop-)/.test(action.id)) {
    return inventorySignature(before) !== inventorySignature(after)
      || skillSignature(before) !== skillSignature(after);
  }
  if (positionSignature(before) !== positionSignature(after)) return true;
  if (inventorySignature(before) !== inventorySignature(after)) return true;
  if (skillSignature(before) !== skillSignature(after)) return true;
  // HP loss is risk evidence, never task progress. Combat entry may be a
  // valid engagement signal, but it does not count as a completed outcome;
  // XP, loot, or a verified target effect must follow.
  return Boolean(before.player?.combat?.inCombat) === false && Boolean(after.player?.combat?.inCombat) === true;
}

export function recordAutonomy(memory: AutonomyMemory, before: any, after: any, action: CandidateLike, now = Date.now(), transient = false): { stalled: boolean; intent: string; progress: boolean } {
  const intent = intentFor(action);
  const progressed = madeProgress(before, after, action);
  memory.active = memory.active?.intent === intent
    ? { ...memory.active, action: action.id, lastProgress: progressed ? now : memory.active.lastProgress }
    : { intent, action: action.id, since: now, lastProgress: progressed ? now : 0, reason: action.id };
  memory.stalled ??= {};
  const prior = memory.stalled[action.id];
  const count = progressed || transient ? 0 : (prior?.count ?? 0) + 1;
  memory.stalled[action.id] = { count, lastAt: now };
  return { stalled: count >= 2, intent, progress: progressed };
}

export function progressTimedOut(memory: AutonomyMemory, now = Date.now(), timeoutMs = ACTION_PROGRESS_TIMEOUT_MS): boolean {
  const active = memory.active;
  if (!active) return false;
  const started = active.lastProgress > 0 ? active.lastProgress : active.since;
  return now - started >= timeoutMs;
}
