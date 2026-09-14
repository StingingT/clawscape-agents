import type { Domain, Memory, Opportunity, Review } from './types.ts';

/** Motivation is separate from a combat build. These are preferences, not level caps. */
export type AmbitionId = 'artisan-collector' | 'resource-specialist' | 'world-explorer'
  | 'all-skill-mastery' | 'combat-mastery' | 'combat-build-experiment';
export type Ambition = {
  version: 1; id: AmbitionId; name: string; chosenAt: number;
  reason: string; evidence: string[];
  history: Array<{ at: number; from: AmbitionId; to: AmbitionId; reason: string; evidence: string[] }>;
  alternatives: Array<{ id: AmbitionId; score: number; eligible: boolean; reason: string }>;
};
export const AMBITIONS: Record<AmbitionId, { name: string; weights: Partial<Record<Domain, number>>; purpose: string }> = {
  'artisan-collector': { name: 'Equipment maker and collector', weights: { crafting: 3, gathering: 1.5, exploration: .5 },
    purpose: 'Make useful equipment, obtain materials and investigate missing recipes/items; combat can support this ambition without replacing it.' },
  'resource-specialist': { name: 'Resource and gathering mastery', weights: { gathering: 3, crafting: 1, exploration: .5 },
    purpose: 'Improve reliable resource trips and the skills/tools that unlock better materials.' },
  'world-explorer': { name: 'World exploration and discovery', weights: { exploration: 3, gathering: .5, combat: .5 },
    purpose: 'Investigate meaningful places and learn safe access; preparation and combat remain supporting capabilities.' },
  'all-skill-mastery': { name: 'All-skill mastery', weights: { combat: 1.5, crafting: 1.5, gathering: 1.5, exploration: 1 },
    purpose: 'Pursue broad progression toward mastering all skills, using supported methods now and recording missing capabilities rather than inventing executors.' },
  'combat-mastery': { name: 'Unrestricted combat mastery', weights: { combat: 3, crafting: .5, gathering: .5 },
    purpose: 'Develop useful combat skills, including Defence and Prayer, without imposing pure restrictions; supplies and equipment serve that progression.' },
  'combat-build-experiment': { name: 'Compare a restricted combat build', weights: { combat: 3, exploration: .5 },
    purpose: 'Test a deliberately restricted build against personally observed unrestricted training; eligibility alone is not a reason to adopt it.' },
};
const domains: Domain[] = ['combat', 'crafting', 'gathering', 'exploration', 'social'];
const safeWeight = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.max(-2, Math.min(2, n)) : 0;
function completed(memory: Memory): Review[] {
  // A support action, idle wait or abandoned goal is not evidence of a new life ambition.
  return memory.reviews.filter(r => r.result === 'success' && r.evidence.length > 0
    && typeof r.goal?.id === 'string' && typeof r.goal?.target?.fact === 'string'
    && r.goal.priority !== 'maintenance' && !r.goal.id.startsWith('supply-')
    && !r.goal.id.startsWith('live:') && !r.goal.target.fact.startsWith('action:'));
}
function buildQuestion(memory: Memory, state: Record<string, any>) {
  const defence = (state.skills ?? []).find((s: any) => String(s.name).toLowerCase() === 'defence');
  const trials = completed(memory).filter(r => r.goal.domain === 'combat'
    && r.goal.ambitionId === 'combat-mastery' && r.goal.deaths === 0 && r.goal.lostGp === 0
    && /^xp:(strength|ranged|magic)$/.test(r.goal.target.fact)).slice(-8);
  const preferences = memory.preferences;
  const combatInterest = safeWeight(preferences.combat) > Math.max(safeWeight(preferences.crafting), safeWeight(preferences.gathering));
  const eligible = combatInterest && Number(defence?.baseLevel ?? defence?.level) === 1
    && trials.length >= 4 && new Set(trials.map(r => r.goal.target.fact)).size >= 2;
  return { eligible, trials, reason: eligible
    ? 'Several successful, loss-free trials in different offensive skills provide a personal baseline for comparing a restricted build while one Defence remains possible.'
    : 'No personal comparative-build question yet: a weapon, a temporary combat task or template eligibility is insufficient.' };
}
export function rankAmbitions(memory: Memory, state: Record<string, any>): Ambition['alternatives'] {
  const successes = completed(memory).slice(-24), question = buildQuestion(memory, state);
  const activityDomains = new Set(successes.map(r => r.goal.domain));
  const preferences = domains.map(d => safeWeight(memory.preferences[d]));
  const balanced = Math.max(...preferences) - Math.min(...preferences.slice(0, 4)) <= .5;
  return (Object.keys(AMBITIONS) as AmbitionId[]).map(id => {
    const profile = AMBITIONS[id];
    let score = domains.reduce((n, d) => n + safeWeight(memory.preferences[d]) * (profile.weights[d] ?? 0), 0);
    // A broad ambition is a real candidate even before any skill becomes available.
    if (id === 'all-skill-mastery') score += (balanced ? 3 : 0) + (activityDomains.size >= 3 ? (successes.length >= 8 && [...activityDomains].every(d => successes.filter(r => r.goal.domain === d).length >= 2) ? 7 : 4) : 0);
    else score += Math.min(2, successes.filter(r => (profile.weights[r.goal.domain] ?? 0) >= 3).length * .2);
    if (id === 'combat-build-experiment') score = question.eligible ? score + 3 : 0;
    const eligible = id !== 'combat-build-experiment' || question.eligible;
    return { id, score, eligible, reason: id === 'combat-build-experiment' ? question.reason : profile.purpose };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
function evidenceFor(memory: Memory, state: Record<string, any>, id: AmbitionId): string[] {
  const relevant = id === 'combat-build-experiment' ? buildQuestion(memory, state).trials : completed(memory).slice(-8);
  return [`own-ambition-observation:${state.player?.lifeId}:${state.tick}`,
    ...Object.entries(memory.preferences).map(([d, v]) => `role-preference:${d}:${safeWeight(v)}`),
    ...relevant.map(r => `own-completed-objective:${r.at}:${r.goal.id}`)];
}
/** No name-based assignment, no peer-memory sharing, no change during an active objective. */
export function reviewAmbition(memory: Memory, state: Record<string, any>, now: number): Ambition | undefined {
  if (memory.pending || (memory.active && memory.ambition) || state.inGame !== true || state.player?.combat?.inCombat === true) return memory.ambition;
  const alternatives = rankAmbitions(memory, state), best = alternatives.find(a => a.eligible)!;
  const current = memory.ambition;
  if (current && current.id !== best.id) {
    const recent = completed(memory).filter(r => r.at > current.chosenAt);
    const prior = alternatives.find(a => a.id === current.id)!;
    if (recent.length < 4 || best.score < prior.score + 2) return current;
  }
  if (current?.id === best.id) return { ...current, alternatives };
  const profile = AMBITIONS[best.id], evidence = evidenceFor(memory, state, best.id);
  const reason = (current ? 'Reconsidered after completed personal objectives: ' : 'Initial role-informed ambition: ') + best.reason;
  return { version: 1, id: best.id, name: profile.name, chosenAt: now, reason, evidence, alternatives,
    history: current ? [...current.history, { at: now, from: current.id, to: best.id, reason, evidence }].slice(-32) : [] };
}
/** Pure adoption requires a deliberate experiment and an attributable personal baseline. */
export function motivatedPureTrial(memory: Memory): boolean {
  const a = memory.ambition;
  return a?.id === 'combat-build-experiment' && !!a.reason.trim()
    && a.evidence.some(e => e.startsWith('own-completed-objective:'));
}
/** Bias strategic selection only. Never remove support methods or relax safety/budgets. */
export function ambitionPriority(memory: Memory, goal: Opportunity, facts: Record<string, number>): number {
  const a = memory.ambition; if (!a || goal.priority === 'maintenance') return 0;
  let value = (AMBITIONS[a.id].weights[goal.domain] ?? 0) * 2;
  if (a.id === 'all-skill-mastery') {
    const skill = goal.target.fact.startsWith('xp:') ? goal.target.fact.slice(3) : undefined;
    const level = skill ? facts['level:' + skill] : undefined;
    const levels = Object.entries(facts).filter(([k, v]) => k.startsWith('level:') && Number.isFinite(v) && v >= 1).map(([, v]) => v);
    if (level !== undefined && levels.length && level <= Math.min(...levels) + 5) value += 2;
    if (goal.domain === 'crafting' || goal.domain === 'gathering') {
      const group = goal.domain === 'crafting' ? ['smithing','crafting','fletching'] : ['mining','fishing','woodcutting'];
      if (group.some(k => Number.isFinite(facts['level:' + k]) && facts['level:' + k]! <= Math.min(...levels) + 5)) value += 2;
    }
  }
  return Math.max(0, Math.min(8, value));
}
