import type { Budget, Decision, Facts, Goal, Identity, Memory, Method, MethodStats, Observation, Opportunity, Outcome, Plan, Requirement } from './types.ts';

const MAX_STEPS = 48;
const COOLDOWN_MS = 5 * 60_000;
const key = (...parts: string[]) => JSON.stringify(parts);
const amount = (facts: Facts, fact: string) => facts[fact] ?? 0;
const met = (facts: Facts, requirement: Requirement) => amount(facts, requirement.fact) >= requirement.minimum;
const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const sameIdentity = (a: Identity, b: Identity) => a.agent === b.agent && a.world === b.world && a.revision === b.revision;
const methodKey = (context: string, id: string) => key(context, id);
const goalKey = (view: Observation, goal: Opportunity) => key(view.context, goal.id, goal.target.fact, String(goal.target.minimum));
const emptyStats = (): MethodStats => ({ attempts: 0, productive: 0, rejected: 0, spentGp: 0, lostGp: 0, elapsedMs: 0, cooldownUntil: 0 });

export function createMemory(identity: Identity, preferences: Memory['preferences'] = {}): Memory {
  return { ...identity, schema: 1, preferences: { ...preferences }, sequence: 0, methods: {}, goalCooldowns: {}, reviews: [], domainChanges: [] };
}

function validateView(memory: Memory, view: Observation): void {
  if (!sameIdentity(memory, view)) throw new Error('AGENT_WORLD_OR_REVISION_MISMATCH');
  if (!view.context.trim() || !Number.isFinite(view.at) || !Object.values(view.facts).every(Number.isFinite)
    || !Object.values(view.budget).every(finiteNonnegative) || !Number.isInteger(view.budget.maxDeaths)) throw new Error('INVALID_OBSERVATION');
}
function permitted(method: Method, view: Observation): boolean {
  return view.capabilities.includes(method.capability) && method.risk !== 'pvp' && method.risk !== 'unknown'
    && (method.risk === 'safe' || view.budget.maxDeaths > 0)
    && [method.costGp, method.lossBoundGp, method.durationMs].every(finiteNonnegative)
    && method.durationMs > 0 && Object.values(method.effects).every(finiteNonnegative)
    && Object.values(method.consumes ?? {}).every(finiteNonnegative)
    && method.prerequisites.every(p => finiteNonnegative(p.minimum));
}
function fits(plan: Plan, budget: Budget): boolean {
  return plan.costGp <= budget.spendableGp && plan.lossBoundGp <= budget.maxLossGp && plan.durationMs <= budget.maxDurationMs;
}
function methodScore(memory: Memory, context: string, method: Method): number {
  const stats = memory.methods[methodKey(context, method.id)];
  const measuredCost = stats ? (stats.spentGp + 3 * stats.lostGp + stats.elapsedMs / 1000) / Math.max(1, stats.productive) : 0;
  const failurePenalty = stats ? (stats.attempts - stats.productive) / Math.max(1, stats.attempts) * 40 : 0;
  return method.costGp + 3 * method.lossBoundGp + method.durationMs / 1000 + measuredCost + failurePenalty;
}

/** Bounded prerequisite planning. The executor re-observes after every step. */
export function makePlan(memory: Memory, view: Observation, goal: Opportunity, methods: Method[]): Plan | undefined {
  validateView(memory, view);
  const candidates = methods.filter(m => permitted(m, view)
    && (memory.methods[methodKey(view.context, m.id)]?.cooldownUntil ?? 0) <= view.at)
    .sort((a, b) => methodScore(memory, view.context, a) - methodScore(memory, view.context, b) || a.id.localeCompare(b.id));
  let facts = { ...view.facts };
  let plan: Plan = { steps: [], costGp: 0, lossBoundGp: 0, durationMs: 0 };
  let visits = 0;
  const achieve = (requirement: Requirement, stack: Set<string>): boolean => {
    if (++visits > 512) return false;
    if (met(facts, requirement)) return true;
    if (stack.has(requirement.fact) || stack.size >= 12 || plan.steps.length >= MAX_STEPS) return false;
    for (const method of candidates.filter(m => (m.effects[requirement.fact] ?? 0) > 0)) {
      const oldFacts = { ...facts }, oldPlan = structuredClone(plan);
      const count = Math.ceil((requirement.minimum - amount(facts, requirement.fact)) / method.effects[requirement.fact]!);
      if (!Number.isFinite(count) || count < 1 || count + plan.steps.length > MAX_STEPS) continue;
      let viable = true;
      for (let n = 0; n < count && viable; n++) {
        const path = new Set([...stack, requirement.fact]);
        viable = [...method.prerequisites, ...Object.entries(method.consumes ?? {}).map(([fact, minimum]) => ({ fact, minimum }))]
          .every(p => achieve(p, path));
        viable = viable && method.prerequisites.every(p => met(facts, p))
          && Object.entries(method.consumes ?? {}).every(([fact, quantity]) => amount(facts, fact) >= quantity);
        if (!viable || plan.steps.length >= MAX_STEPS) { viable = false; break; }
        plan.steps.push({ methodId: method.id, capability: method.capability, prerequisites: structuredClone(method.prerequisites) });
        plan.costGp += method.costGp; plan.lossBoundGp += method.lossBoundGp; plan.durationMs += method.durationMs;
        if (!fits(plan, view.budget)) { viable = false; break; }
        for (const [fact, quantity] of Object.entries(method.consumes ?? {})) facts[fact] = amount(facts, fact) - quantity;
        for (const [fact, delta] of Object.entries(method.effects)) facts[fact] = amount(facts, fact) + delta;
      }
      if (viable && met(facts, requirement)) return true;
      facts = oldFacts; plan = oldPlan;
    }
    return false;
  };
  return achieve(goal.target, new Set()) && fits(plan, view.budget) ? plan : undefined;
}

/** Goal-first policy. It produces commands only through a separately supplied executor. */
export class Director {
  readonly memory: Memory;
  constructor(memory: Memory) { this.memory = memory; }

  private review(at: number, result: 'success' | 'partial' | 'failure', reason: string, evidence: string[]) {
    const goal = this.memory.active;
    if (!goal) return;
    this.memory.reviews.push({ goal: structuredClone(goal), at, result, reason, evidence: [...evidence] });
    // Summaries are bounded; durable method aggregates remain available to future decisions.
    this.memory.reviews = this.memory.reviews.slice(-256);
    if (result !== 'success') this.memory.goalCooldowns[goal.key] = at + COOLDOWN_MS;
    delete this.memory.active;
  }

  next(view: Observation, opportunities: Opportunity[], methods: Method[]): Decision {
    validateView(this.memory, view);
    if (this.memory.pending) return { type: 'reconcile', pending: structuredClone(this.memory.pending) };
    const active = this.memory.active;
    if (active) {
      if (met(view.facts, active.target)) {
        this.review(view.at, 'success', 'The goal predicate is now satisfied by a fresh own observation.', ['fresh-observation:' + view.at]);
      } else if (view.at - active.startedAt >= active.budget.maxDurationMs || active.noProgress >= 3) {
        this.review(view.at, active.attempts ? 'partial' : 'failure', 'Bounded attempt exhausted; choose an alternative instead of looping.', []);
      } else {
        const remaining = { ...view, budget: {
          spendableGp: Math.min(view.budget.spendableGp, Math.max(0, active.budget.spendableGp - active.spentGp)),
          maxLossGp: Math.min(view.budget.maxLossGp, Math.max(0, active.budget.maxLossGp - active.lostGp)),
          maxDeaths: Math.min(view.budget.maxDeaths, Math.max(0, active.budget.maxDeaths - active.deaths)),
          maxDurationMs: Math.min(view.budget.maxDurationMs, Math.max(0, active.budget.maxDurationMs - (view.at - active.startedAt))),
        } };
        const plan = makePlan(this.memory, remaining, active, methods);
        if (plan?.steps[0]) return { type: 'execute', goal: structuredClone(active), plan, step: plan.steps[0] };
        this.review(view.at, 'partial', 'Prerequisites, resources or supported methods changed; replan without losing learned outcomes.', []);
      }
    }
    const ranked = opportunities.filter(goal => goal.evidence.length && goal.reason.trim()
      && Number.isFinite(goal.target.minimum) && !met(view.facts, goal.target)
      && (this.memory.goalCooldowns[goalKey(view, goal)] ?? 0) <= view.at)
      .map(goal => {
        const plan = makePlan(this.memory, view, goal, methods);
        // Role preference cannot outweigh survival or feasibility, nor mandate a specific target.
        const role = Math.max(-2, Math.min(2, this.memory.preferences[goal.domain] ?? 0));
        const need = goal.source === 'need' ? 30 : goal.source === 'unlock' ? 6 : 0;
        const curiosity = goal.source === 'frontier' || goal.source === 'investigation' ? 2 : 0;
        const score = need + role + curiosity - (plan ? plan.costGp + 3 * plan.lossBoundGp + plan.durationMs / 1000 : Infinity) / 100;
        return { goal, plan, score };
      }).filter(entry => entry.plan?.steps[0]).sort((a, b) => b.score - a.score || a.goal.id.localeCompare(b.goal.id));
    const selected = ranked[0];
    if (!selected?.plan) return { type: 'blocked', reason: 'No safe, affordable executable goal; record a capability/research request rather than inventing a command.',
      missingCapabilities: [...new Set(methods.filter(m => !view.capabilities.includes(m.capability)).map(m => m.capability))] };
    const goal: Goal = { ...structuredClone(selected.goal), key: goalKey(view, selected.goal), context: view.context,
      budget: { ...view.budget }, startedAt: view.at, baseline: amount(view.facts, selected.goal.target.fact),
      spentGp: 0, lostGp: 0, deaths: 0, elapsedMs: 0, attempts: 0, noProgress: 0 };
    if (this.memory.currentDomain !== goal.domain) {
      this.memory.domainChanges.push({ at: view.at, from: this.memory.currentDomain, to: goal.domain, reason: goal.reason, evidence: [...goal.evidence] });
      this.memory.domainChanges = this.memory.domainChanges.slice(-128);
      this.memory.currentDomain = goal.domain;
    }
    this.memory.active = goal;
    return { type: 'execute', goal: structuredClone(goal), plan: selected.plan, step: selected.plan.steps[0]! };
  }

  /** An executable method can discover a missing prerequisite without dispatching. */
  blocked(at: number, reason: string, evidence: string[] = []): void {
    if (this.memory.pending) throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    this.review(at, 'partial', reason, evidence);
  }

  /** Save memory AFTER this call and BEFORE handing the command to the live arbiter. */
  begin(view: Observation, decision: Decision, method: Method, commandId: string): void {
    validateView(this.memory, view);
    if (this.memory.pending) throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal = this.memory.active;
    if (decision.type !== 'execute' || !goal || decision.goal.key !== goal.key || method.id !== decision.step.methodId || method.capability !== decision.step.capability
      || !commandId.trim() || !permitted(method, view) || !method.prerequisites.every(p => met(view.facts, p))
      || !Object.entries(method.consumes ?? {}).every(([fact, quantity]) => amount(view.facts, fact) >= quantity)) throw new Error('INVALID_OR_STALE_PLAN');
    if ((method.risk === 'bounded' && goal.deaths >= goal.budget.maxDeaths) || view.at - goal.startedAt + method.durationMs > goal.budget.maxDurationMs
      || goal.spentGp + method.costGp > goal.budget.spendableGp || method.costGp > view.budget.spendableGp
      || goal.lostGp + method.lossBoundGp > goal.budget.maxLossGp || method.lossBoundGp > view.budget.maxLossGp) throw new Error('BUDGET_EXCEEDED');
    this.memory.pending = { commandId, goalKey: goal.key, context: view.context, method: structuredClone(method),
      before: { ...view.facts }, status: 'pending' };
  }

  /** Only attributable, terminal outcomes update learning. Unknown is NOT failed. */
  record(outcome: Outcome): void {
    if (!['verified', 'progress', 'rejected', 'unknown', 'interrupted'].includes(outcome.status) || !Number.isSafeInteger(outcome.sequence) || outcome.sequence <= 0
      || ![outcome.at, outcome.spentGp, outcome.lostGp, outcome.deaths, outcome.elapsedMs].every(finiteNonnegative)
      || !Number.isInteger(outcome.deaths) || !Object.values(outcome.facts).every(Number.isFinite)) throw new Error('INVALID_OUTCOME');
    if (outcome.sequence <= this.memory.sequence) return;
    const pending = this.memory.pending, goal = this.memory.active;
    if (!pending || pending.commandId !== outcome.commandId || !goal || goal.key !== pending.goalKey) throw new Error('OUTCOME_WITHOUT_MATCHING_INTENT');
    if (outcome.status === 'unknown' || (['verified', 'progress', 'interrupted'].includes(outcome.status) && !outcome.evidence.length)) {
      pending.status = 'unknown'; return;
    }
    const stats = this.memory.methods[methodKey(pending.context, pending.method.id)] ??= emptyStats();
    const productive = outcome.status === 'verified' && Object.keys(pending.method.effects)
      .some(fact => amount(outcome.facts, fact) > amount(pending.before, fact));
    const preparation = outcome.status === 'progress' || outcome.status === 'interrupted';
    // A verified route leg/interface transition advances a method; it is not
    // a failed training trial and does not satisfy a quantitative goal.
    if (preparation) stats.preparationMs = (stats.preparationMs ?? 0) + outcome.elapsedMs;
    else { stats.attempts++; stats.productive += Number(productive); stats.rejected += Number(outcome.status === 'rejected'); }
    stats.spentGp += outcome.spentGp; stats.lostGp += outcome.lostGp; stats.elapsedMs += outcome.elapsedMs;
    if (!preparation) stats.cooldownUntil = productive ? 0 : outcome.at + COOLDOWN_MS;
    goal.attempts++; goal.noProgress = productive || outcome.status === 'progress' ? 0 : goal.noProgress + 1;
    goal.spentGp += outcome.spentGp; goal.lostGp += outcome.lostGp; goal.deaths += outcome.deaths; goal.elapsedMs += outcome.elapsedMs;
    this.memory.sequence = outcome.sequence;
    delete this.memory.pending;
    if (goal.spentGp > goal.budget.spendableGp || goal.lostGp > goal.budget.maxLossGp || goal.deaths > goal.budget.maxDeaths
      || goal.elapsedMs > goal.budget.maxDurationMs) {
      this.review(outcome.at, 'failure', 'Observed cost or risk exceeded the experiment budget.', outcome.evidence);
    } else if (outcome.status === 'verified' && met(outcome.facts, goal.target)) {
      this.review(outcome.at, 'success', 'The planned goal predicate was verified, not merely an individual click.', outcome.evidence);
    }
  }
}
