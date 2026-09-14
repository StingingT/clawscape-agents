import type { Memory, Observation } from './types.ts';
import type { LiveState } from './world-model.ts';

export type BuildId = 'open-development' | 'ranged-magic-pure' | 'strength-prayer-pure';
export type Development = {
  version: 1;
  id: BuildId;
  chosenAt: number;
  focus: string[];
  /** Protect XP, not merely level: a small accidental gain is still irreversible. */
  protectedXp: Record<string, number>;
  reason: string;
  evidence: string[];
  history: Array<{ at: number; from: BuildId; to: BuildId; reason: string; evidence: string[] }>;
};
const skills = (s: LiveState) => Object.fromEntries((s.skills ?? []).map((k: any) =>
  [String(k.name).toLowerCase(), { level: Number(k.baseLevel ?? k.level), xp: Number(k.experience ?? k.xp) }]));
const availableSkills = (s: LiveState): string[] => [...new Set<string>((s.combatStyle?.styles ?? [])
  .flatMap((r: any) => r.trainsSkills ?? []).map((k: any) => String(k).toLowerCase()))];

/** Roles are suggestions. Adoption needs a viable observed training mode and low base Defence. */
export function chooseDevelopment(state: LiveState, memory: Memory, now: number, hint?: string): Development {
  const known = skills(state), can = availableSkills(state);
  const combatInterest = (memory.preferences.combat ?? 0) > Math.max(memory.preferences.crafting ?? 0, memory.preferences.gathering ?? 0);
  const lowDefence = known.defence && Number.isFinite(known.defence.level) && known.defence.level <= 5;
  let id: BuildId = 'open-development', focus = can, protectedSkills: string[] = [];
  if (combatInterest && lowDefence && hint === 'ranged-magic' && can.some(k => ['ranged', 'magic'].includes(k))) {
    id = 'ranged-magic-pure'; focus = ['ranged', 'magic']; protectedSkills = ['attack', 'strength', 'defence'];
  } else if (combatInterest && lowDefence && hint === 'melee' && can.includes('strength')) {
    id = 'strength-prayer-pure'; focus = ['strength', 'prayer']; protectedSkills = ['attack', 'defence', 'ranged', 'magic'];
  }
  // Missing base/XP observations cannot establish a safe pure-build boundary.
  if (protectedSkills.some(k => !Number.isFinite(known[k]?.xp))
    || (memory.active && protectedSkills.some(k => memory.active!.target.fact === 'xp:' + k))) {
    id = 'open-development'; focus = can; protectedSkills = [];
  }
  return { version: 1, id, chosenAt: now, focus,
    protectedXp: Object.fromEntries(protectedSkills.map(k => [k, known[k].xp])),
    reason: id === 'open-development' ? 'Keep development open while following personally feasible goals; no role-based skill ceiling.' :
      `Test ${id} because my current low Defence and observed training options support specialization; protect other combat XP during the trial.`,
    evidence: [`own-build-observation:${state.player?.lifeId}:${state.tick}`, `observed-training-options:${can.join(',')}`], history: [] };
}

/** Only completed, attributed costly combat trials justify this automatic strategy change.
 * Route interruptions, missing supplies, time passage and third-party claims are not evidence. */
export function reviewDevelopment(current: Development, state: LiveState, memory: Memory, now: number): Development {
  if (current.id === 'open-development' || memory.pending || memory.active) return current;
  const trials = memory.reviews.filter(r => r.at >= current.chosenAt && r.goal.strategyId === current.id
    && r.goal.domain === 'combat' && r.evidence.length > 0 && (r.goal.deaths > 0 || r.goal.lostGp > 0));
  if (trials.length < 3 || !availableSkills(state).includes('defence')) return current;
  const evidence = trials.slice(-3).map(r => `completed-combat-trial:${r.at}:${r.goal.id}:loss=${r.goal.lostGp}:deaths=${r.goal.deaths}`);
  const reason = 'Three attributed combat trials incurred losses. End the pure experiment and test Defence as a possible way to support safer encounters; prior XP cannot be undone.';
  return { ...current, id: 'open-development', chosenAt: now, focus: ['defence'], protectedXp: {}, reason, evidence,
    history: [...current.history, { at: now, from: current.id, to: 'open-development' as const, reason, evidence }].slice(-32) };
}
export function strategyView(d: Development | undefined): Observation['strategy'] {
  return d && { id: d.id, protectedSkills: Object.keys(d.protectedXp) };
}
export function allowedTraining(d: Development | undefined, trained: string[]): boolean {
  return trained.length > 0 && trained.every(k => !Object.hasOwn(d?.protectedXp ?? {}, k.toLowerCase()));
}
export function protectedXpChanged(d: Development | undefined, state: LiveState): boolean {
  const observed = skills(state);
  return Object.entries(d?.protectedXp ?? {}).some(([skill, maximum]) =>
    !Number.isFinite(observed[skill]?.xp) || observed[skill].xp > maximum);
}

/** Recheck ALL XP-bearing style components immediately before irreversible combat dispatch. */
export function guardDevelopment(d: Development | undefined, state: LiveState,
  action: { type: string; fields?: Record<string, any> }, intendedSkill?: string): void {
  if (!d) return;
  const f = action.fields ?? {};
  const npc = (state.nearbyNpcs ?? []).find((n: any) => n.index === f.npcIndex);
  const option = npc?.optionsWithIndex?.find((o: any) => o.opIndex === f.optionIndex)?.text;
  const attack = action.type === 'interactNpc' && /^attack$/i.test(String(option));
  const styleChange = action.type === 'setCombatStyle';
  if (!attack && !styleChange) return;
  if (protectedXpChanged(d, state)) throw new Error('PURE_BUILD_XP_BOUNDARY_CHANGED');
  const index = styleChange ? f.style : state.combatStyle?.currentStyle;
  const style = (state.combatStyle?.styles ?? []).find((s: any) => s.index === index);
  const trained = (style?.trainsSkills ?? []).map((k: any) => String(k).toLowerCase());
  if (!allowedTraining(d, trained)) throw new Error('BUILD_STRATEGY_DISALLOWS_OR_CANNOT_VERIFY_STYLE_XP');
  if (intendedSkill && !trained.includes(intendedSkill.toLowerCase())) throw new Error('STYLE_DOES_NOT_TRAIN_SELECTED_GOAL');
}
