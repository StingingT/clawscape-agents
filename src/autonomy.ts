export type CandidateLike = { id: string; type: string; fields?: Record<string, unknown> };
export const ACTION_PROGRESS_TIMEOUT_MS = 5 * 60_000;

export type AutonomyMemory = {
  active?: { intent: string; action: string; since: number; lastProgress: number; reason: string; goalKey?: string };
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

function repeatedCycle(actions: string[]): boolean {
  for (const length of [2, 3, 4]) {
    if (actions.length < length * 2) continue;
    const previous = actions.slice(-length * 2, -length).join('|');
    const current = actions.slice(-length).join('|');
    if (previous === current) return true;
  }
  return false;
}

/**
 * Record one terminal action result for the generic autonomy circuit breaker.
 * `objectiveProgress` is deliberately separate from a local state change:
 * opening a bank or moving an interface can change state without advancing
 * the selected goal. This distinction is what prevents productive-looking
 * preparation cycles from becoming permanent loops.
 */
export function recordAutonomy(
  memory: AutonomyMemory,
  before: any,
  after: any,
  action: CandidateLike,
  now = Date.now(),
  transient = false,
  goalKey?: string,
  objectiveProgress = false,
): { stalled: boolean; intent: string; progress: boolean; reason?: string } {
  const intent = intentFor(action);
  if (goalKey && memory.active?.goalKey && memory.active.goalKey !== goalKey) {
    memory.stalled = {};
    memory.recentActions = [];
  }
  const stateProgress = madeProgress(before, after, action);
  const progressed = objectiveProgress || stateProgress;
  memory.active = memory.active?.intent === intent
    ? { ...memory.active, action: action.id, goalKey: goalKey ?? memory.active.goalKey, lastProgress: progressed ? now : memory.active.lastProgress }
    : { intent, action: action.id, goalKey, since: now, lastProgress: progressed ? now : 0, reason: action.id };
  memory.stalled ??= {};
  const prior = memory.stalled[action.id];
  const count = progressed || transient ? 0 : (prior?.count ?? 0) + 1;
  memory.stalled[action.id] = { count, lastAt: now };
  memory.recentActions = [...(memory.recentActions ?? []), action.id].slice(-8);
  const cycle = !transient && !objectiveProgress && repeatedCycle(memory.recentActions);
  const timedOut = !transient && progressTimedOut(memory, now);
  const stalled = !transient && !objectiveProgress && (count >= 2 || cycle || timedOut);
  return {
    stalled,
    intent,
    progress: progressed,
    reason: stalled ? cycle ? 'repeated-action-cycle' : timedOut ? 'objective-progress-timeout' : 'repeated-no-progress-action' : undefined,
  };
}

export function progressTimedOut(memory: AutonomyMemory, now = Date.now(), timeoutMs = ACTION_PROGRESS_TIMEOUT_MS): boolean {
  const active = memory.active;
  if (!active) return false;
  const started = active.lastProgress > 0 ? active.lastProgress : active.since;
  return now - started >= timeoutMs;
}
