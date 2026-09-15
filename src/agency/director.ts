import type { Budget, Decision, Facts, Goal, Identity, Memory, Method, MethodStats, Observation, Opportunity, Outcome, Plan, Requirement, SupportGoal } from './types.ts';

import { createHash } from 'node:crypto';
const MAX_STEPS = 48;
const COOLDOWN_MS = 5 * 60_000;
const key = (...parts: string[]) => JSON.stringify(parts);
const amount = (facts: Facts, fact: string) => facts[fact] ?? 0;
const met = (facts: Facts, requirement: Requirement) => amount(facts, requirement.fact) >= requirement.minimum;
const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const sameIdentity = (a: Identity, b: Identity) => a.agent === b.agent && a.world === b.world && a.revision === b.revision;
const methodKey = (context: string, id: string) => key(context, id);
export const outcomeTarget = (r: Requirement) => typeof r?.fact === 'string' && !!r.fact.trim() && !/^(action:|goal:)/.test(r.fact) && Number.isFinite(r.minimum);
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
  const protectedSkills = view.strategy?.protectedSkills ?? [];
  return !protectedSkills.some(skill => (method.effects['xp:' + skill] ?? 0) > 0)
    && Object.keys(method.effects).every(fact => !/^(action:|goal:)/.test(fact)) && view.capabilities.includes(method.capability) && method.risk !== 'pvp' && method.risk !== 'unknown'
    && (method.risk === 'safe' || view.budget.maxDeaths > 0)
    && [method.costGp, method.lossBoundGp, method.durationMs].every(finiteNonnegative)
    && method.durationMs > 0 && Object.values(method.effects).every(finiteNonnegative)
    && Object.values(method.consumes ?? {}).every(finiteNonnegative)
    && method.prerequisites.every(p => finiteNonnegative(p.minimum));
}
function fits(plan: Plan, budget: Budget): boolean {
  return plan.costGp <= budget.spendableGp && plan.lossBoundGp <= budget.maxLossGp && plan.durationMs <= budget.maxDurationMs;
}
function available(memory: Memory, view: Observation, method: Method): boolean {
  const stats = memory.methods[methodKey(view.context, method.id)];
  return permitted(method, view) && (!stats || stats.cooldownUntil <= view.at
    || (stats.viability !== 'disproven' && (view.knowledgeRevision ?? 0) > (stats.knowledgeRevision ?? 0)));
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
  if (!outcomeTarget(goal.target)) return;
  const candidates = methods.filter(m => available(memory, view, m))
    .sort((a, b) => methodScore(memory, view.context, a) - methodScore(memory, view.context, b) || a.id.localeCompare(b.id));
  let facts = { ...view.facts };
  let plan: Plan = { steps: [], costGp: 0, lossBoundGp: 0, durationMs: 0 };
  let visits = 0;
  const achieve = (requirement: Requirement, stack: Set<string>, ancestors: Requirement[] = []): boolean => {
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
          .every(p => achieve(p, path, [...ancestors, requirement]));
        viable = viable && method.prerequisites.every(p => met(facts, p))
          && Object.entries(method.consumes ?? {}).every(([fact, quantity]) => amount(facts, fact) >= quantity);
        if (!viable || plan.steps.length >= MAX_STEPS) { viable = false; break; }
        plan.steps.push({ methodId: method.id, capability: method.capability, prerequisites: structuredClone(method.prerequisites),
          lineage: structuredClone([...ancestors, requirement]) });
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

  private attach(goal: Goal, plan: Plan, view: Observation, purpose: SupportGoal['purpose'] = 'prerequisite'): Decision {
    const nodes = new Map<string, SupportGoal>((goal.supportGoals ?? []).filter(n=>met(view.facts,n.target)).slice(-8).map(n => [n.id, { ...n, status:'satisfied' as const }]));
    for (const step of plan.steps) {
      step.goalKey = goal.key;
      const lineage = step.lineage ?? [goal.target];
      // An investigative plan has its own target but remains beneath the original objective.
      const chain = lineage[0]?.fact === goal.target.fact && lineage[0]?.minimum === goal.target.minimum ? lineage.slice(1) : lineage;
      let parentId = goal.key;
      for (const target of chain) {
        const id = 'support:'+createHash('sha256').update(key(parentId,target.fact,String(target.minimum))).digest('hex').slice(0,24);
        const node: SupportGoal = { id, parentId, target: { ...target }, purpose,
          reason: purpose === 'investigate-blocker' ? 'Investigate an alternative while preserving the blocked parent objective.' :
            `Prepare ${target.fact} >= ${target.minimum} for ${goal.id}.`,
          evidence: [...(goal.investigation?.evidence ?? goal.evidence)],
          status: met(view.facts, target) ? 'satisfied' : 'pending' };
        nodes.set(id, node); parentId = id;
      }
      step.supportGoalId = parentId === goal.key ? undefined : parentId;
    }
    const first = plan.steps[0]!;
    if (first.supportGoalId) nodes.get(first.supportGoalId)!.status = 'active';
    goal.supportGoals = [...nodes.values()].slice(-20);
    goal.plan = structuredClone(plan); goal.planContext = view.context;
    if (purpose === 'prerequisite') delete goal.blocker;
    return { type: 'execute', goal: structuredClone(goal), plan, step: first };
  }

  /** Obsolete scenery goals are retired only when no executor command is pending. */
  retireObsoleteSurveys(routes:Set<string>,at:number):void {
    if(this.memory.pending)return;
    const g=this.memory.active;if(!g)return;
    if(g.id.startsWith('survey:observed:')&&!routes.has(g.id.slice(7))) {
      this.review(at,'partial','Retired incidental scenery objective; no arrival or task success inferred.',[]);return;
    }
    g.supportGoals=(g.supportGoals??[]).filter(n=>!n.target.fact.startsWith('visited:observed:')||routes.has(n.target.fact.slice(8))).slice(-20);
    if(g.investigation?.target.fact.startsWith('visited:observed:')&&!routes.has(g.investigation.target.fact.slice(8)))delete g.investigation;
  }
  /** A failed survey is evidence about that route, not failure of a crafting parent. */
  deferSurvey(routeId:string,at:number,reason:string,evidence:string[]):void {
    if(this.memory.pending)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal=this.memory.active;if(!goal)return;
    this.blocked(at,reason,evidence);
    if(goal.id==='survey:'+routeId)this.review(at,'partial',reason,evidence);
    else if(goal.investigation?.id==='survey:'+routeId)delete goal.investigation;
  }

  /** Retire a bounded attempt that has no executable step in the fresh world state. */
  deferCurrent(at:number,reason:string,evidence:string[]):void {
    if(this.memory.pending)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    if(!this.memory.active)return;
    this.review(at,'partial',reason,evidence);
  }

  /** Refresh the food dependency, not the strategic objective or a pending receipt. */
  reviseFoodNeed(target:number,at:number):void {
    if(this.memory.pending||!Number.isInteger(target)||target<0)return;
    const g=this.memory.active;if(!g)return;
    if(g.id==='supply-food'&&g.target.minimum!==target){
      if(target===0){this.review(at,'partial','Trip re-evaluation no longer requires a food preparation task.',[]);return;}
      g.target={fact:'food',minimum:target};delete g.plan;
    }
    if(g.requestedSupport?.target.fact==='food')g.requestedSupport.target.minimum=target;
  }

  /** Extra preparation is linked to this objective, never installed as a replacement goal. */
  requestSupport(target: Requirement, reason: string, evidence: string[]): void {
    if (this.memory.pending) throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal = this.memory.active;
    if (!goal || !outcomeTarget(target) || !reason.trim() || !evidence.length) throw new Error('INVALID_SUPPORT_GOAL');
    goal.requestedSupport = { target: { ...target }, reason, evidence: [...evidence] };
    if(target.fact==='coins')goal.workingReserveGp=Math.max(goal.workingReserveGp??0,target.minimum);
  }

  next(view: Observation, opportunities: Opportunity[], methods: Method[]): Decision {
    validateView(this.memory, view);
    if (this.memory.pending) return { type: 'reconcile', pending: structuredClone(this.memory.pending) };
    const active = this.memory.active;
    if (active) {
      if (met(view.facts, active.target)) {
        this.review(view.at, 'success', 'The goal predicate is now satisfied by a fresh own observation.', ['fresh-observation:' + view.at]);
      } else if (view.at - active.startedAt >= active.budget.maxDurationMs) {
        this.review(view.at, active.attempts ? 'partial' : 'failure', 'Bounded attempt exhausted; choose an alternative instead of looping.', []);
      } else if (active.blocker?.reason.startsWith('The same strategic method repeated preparation')) {
        // A causal-chain blocker is deliberately held out of the same plan
        // until a fresh observation/recheck. Reopening that plan immediately
        // would recreate the bank/interface loop we just diagnosed.
        if (view.at < active.blocker.recheckAt) return { type: 'blocked', reason: active.blocker.reason, missingCapabilities: [] };
        active.blocker.attempts=(active.blocker.attempts??0)+1;
        active.blocker.at=view.at;active.blocker.recheckAt=view.at+30_000;
        if ((active.blocker.attempts??0)>=3) {
          this.review(view.at,'partial','The preparation chain remained non-productive after bounded rechecks; select a fresh method from current evidence.',[active.blocker.reason]);
          return this.next(view,opportunities,methods);
        }
        return { type: 'blocked', reason: active.blocker.reason, missingCapabilities: [] };
      } else {
        // Newly verified funds can finance preparation. Existing expenditure is never reset,
        // and bank withdrawal is still required before a shop may spend those coins.
        if (view.funding?.evidence.length) {
          const f = view.funding;
          if (![f.carriedGp, f.bankGp, f.reserveGp].every(finiteNonnegative)
            || view.budget.spendableGp !== Math.max(0, f.carriedGp + f.bankGp - f.reserveGp)) throw new Error('INVALID_FUNDING_EVIDENCE');
          const ceiling = active.spentGp + view.budget.spendableGp;
          if (ceiling > active.budget.spendableGp) {
            active.budget.spendableGp = ceiling;
            active.fundingGrants = [...(active.fundingGrants ?? []), { at: view.at, ceilingGp: ceiling, evidence: f.evidence }].slice(-64);
          }
        }
        const remaining = { ...view, budget: {
          spendableGp: Math.min(view.budget.spendableGp, Math.max(0, active.budget.spendableGp - active.spentGp)),
          maxLossGp: Math.min(view.budget.maxLossGp, Math.max(0, active.budget.maxLossGp - active.lostGp)),
          maxDeaths: Math.min(view.budget.maxDeaths, Math.max(0, active.budget.maxDeaths - active.deaths)),
          maxDurationMs: Math.min(view.budget.maxDurationMs, Math.max(0, active.budget.maxDurationMs - (view.at - active.startedAt))),
        } };
        if (active.requestedSupport && met(view.facts, active.requestedSupport.target)) delete active.requestedSupport;
        if (active.investigation && met(view.facts, active.investigation.target)) delete active.investigation;
        const focus: Opportunity = active.requestedSupport ? { ...active, ...active.requestedSupport } : active.investigation ?? active;
        const plan = makePlan(this.memory, remaining, focus, methods);
        if (plan?.steps[0]) return this.attach(active, plan, view, active.investigation ? 'investigate-blocker' : 'prerequisite');
        // A failed research method may yield to a different lead, but not erase the parent.
        delete active.investigation;
         const previousBlocker=active.blocker;
         if(!previousBlocker) active.blocker={at:view.at,reason:'Current methods or prerequisites are unavailable; objective retained.',recheckAt:view.at+30_000,attempts:0};
         else if(view.at>=previousBlocker.recheckAt) {
           previousBlocker.attempts=(previousBlocker.attempts??0)+1;
           previousBlocker.at=view.at;previousBlocker.recheckAt=view.at+30_000;
           // A blocked method is a bounded experiment, not a permanent session
           // state. Reconsider the normal opportunity set after three rechecks.
           if((previousBlocker.attempts??0)>=3) {
             this.review(view.at,'partial','The current plan remained non-executable after bounded rechecks; reconsider goals from fresh evidence.',[previousBlocker.reason]);
             return this.next(view,opportunities,methods);
           }
         }
        const leads = opportunities.filter(g => g.source==='investigation' && g.investigates?.includes(active.target.fact)
          && outcomeTarget(g.target) && g.evidence.length && g.reason.trim() && !met(view.facts, g.target));
        for (const lead of leads) {
          const research = makePlan(this.memory, remaining, lead, methods);
          if (!research?.steps.length) continue;
          active.investigation = structuredClone(lead);
          return this.attach(active, research, view, 'investigate-blocker');
        }
        return { type: 'blocked', reason: active.blocker?.reason ?? 'Current methods or prerequisites are unavailable; objective retained.', missingCapabilities:
          [...new Set(methods.filter(m => !view.capabilities.includes(m.capability)).map(m => m.capability))] };
      }
    }
    const ranked = opportunities.filter(goal => outcomeTarget(goal.target) && goal.evidence.length && goal.reason.trim()
      && Number.isFinite(goal.target.minimum) && !met(view.facts, goal.target)
      && (this.memory.goalCooldowns[goalKey(view, goal)] ?? 0) <= view.at)
      .map(goal => {
        const plan = makePlan(this.memory, view, goal, methods);
        // Role preference cannot outweigh survival or feasibility, nor mandate a specific target.
        const role = Math.max(-2, Math.min(2, this.memory.preferences[goal.domain] ?? 0));
        const need = goal.source === 'need' ? 30 : goal.source === 'unlock' ? 6 : 0;
        const curiosity = goal.source === 'frontier' || goal.source === 'investigation' ? 2 : 0;
        const score = (goal.priority === 'maintenance' ? -100 : 0) + need + role + curiosity - (plan ? plan.costGp + 3 * plan.lossBoundGp + plan.durationMs / 1000 : Infinity) / 100;
        return { goal, plan, score };
      }).filter(entry => entry.plan?.steps[0]).sort((a, b) => b.score - a.score || a.goal.id.localeCompare(b.goal.id));
    const selected = ranked[0];
    if (!selected?.plan) return { type: 'blocked', reason: 'No safe, affordable executable goal; record a capability/research request rather than inventing a command.',
      missingCapabilities: [...new Set(methods.filter(m => !view.capabilities.includes(m.capability)).map(m => m.capability))] };
    const goal: Goal = { ...structuredClone(selected.goal), key: goalKey(view, selected.goal), context: view.context,
      budget: { ...view.budget }, startedAt: view.at, baseline: amount(view.facts, selected.goal.target.fact),
      spentGp: 0, lostGp: 0, deaths: 0, elapsedMs: 0, attempts: 0, noProgress: 0, strategyId: view.strategy?.id };
    if (this.memory.currentDomain !== goal.domain) {
      this.memory.domainChanges.push({ at: view.at, from: this.memory.currentDomain, to: goal.domain, reason: goal.reason, evidence: [...goal.evidence] });
      this.memory.domainChanges = this.memory.domainChanges.slice(-128);
      this.memory.currentDomain = goal.domain;
    }
    this.memory.active = goal;
    return this.attach(goal, selected.plan, view);
  }

  /** An executable method can discover a missing prerequisite without dispatching. */
  blocked(at: number, reason: string, evidence: string[] = []): void {
    if (this.memory.pending) throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal = this.memory.active;
    if (!goal) return;
    goal.blocker = { at, reason, recheckAt: at + COOLDOWN_MS };
    const step = goal.plan?.steps[0];
    if (step) {
      const stats = this.memory.methods[methodKey(goal.planContext ?? goal.context, step.methodId)] ??= emptyStats();
      stats.viability = 'temporarily-poor'; stats.cooldownUntil = at + COOLDOWN_MS;
      stats.knowledgeRevision = this.memory.learningRevision ?? 0;
    }
    // No dispatch occurred. Keep the goal, its budget, and preparation history.
  }

  /** Save memory AFTER this call and BEFORE handing the command to the live arbiter. */
  begin(view: Observation, decision: Decision, method: Method, commandId: string): void {
    validateView(this.memory, view);
    if (this.memory.pending) throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal = this.memory.active;
    if (decision.type !== 'execute' || !goal || decision.goal.key !== goal.key || method.id !== decision.step.methodId || method.capability !== decision.step.capability
      || (goal.plan?.steps[0]?.methodId !== method.id)
      || goal.plan?.steps[0]?.supportGoalId !== decision.step.supportGoalId
      || !outcomeTarget(goal.target) || !commandId.trim() || !available(this.memory, view, method) || !method.prerequisites.every(p => met(view.facts, p))
      || !Object.entries(method.consumes ?? {}).every(([fact, quantity]) => amount(view.facts, fact) >= quantity)) throw new Error('INVALID_OR_STALE_PLAN');
    if ((method.risk === 'bounded' && goal.deaths >= goal.budget.maxDeaths) || view.at - goal.startedAt + method.durationMs > goal.budget.maxDurationMs
      || goal.spentGp + method.costGp > goal.budget.spendableGp || method.costGp > view.budget.spendableGp
      || goal.lostGp + method.lossBoundGp > goal.budget.maxLossGp || method.lossBoundGp > view.budget.maxLossGp) throw new Error('BUDGET_EXCEEDED');
    this.memory.pending = { commandId, goalKey: goal.key, context: view.context, method: structuredClone(method),
      before: { ...view.facts }, status: 'pending', supportGoalId: decision.step.supportGoalId, knowledgeRevision: view.knowledgeRevision ?? 0 };
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
    // A bank-open, route, or interface step is only preparation. Repeated
    // preparation under the same strategic method must eventually yield the
    // method's measurable target, otherwise the controller is likely circling
    // a prerequisite instead of making causal progress. Exploration legs are
    // exempt because movement itself is the selected measurable result.
    const measurableIntermediate=Object.entries(outcome.facts).some(([fact,value])=>
      !['hp','free-slots'].includes(fact)&&Number(value)>amount(pending.before,fact));
    const preparationAction=outcome.actionType===undefined
      || ['interactNpc','closeModal','closeShop','bankDeposit','bankWithdraw','clickDialogOption','useItemOnItem','useItemOnLoc'].includes(outcome.actionType);
    if (outcome.status === 'progress' && !productive && !measurableIntermediate && preparationAction && pending.method.capability !== 'exploration') {
      goal.preparationOnlyStreak = goal.lastPreparationMethodId === pending.method.id
        ? (goal.preparationOnlyStreak ?? 0) + 1 : 1;
      goal.lastPreparationMethodId = pending.method.id;
    } else if (productive || measurableIntermediate || outcome.status !== 'progress') {
      goal.preparationOnlyStreak = 0;
      goal.lastPreparationMethodId = undefined;
    }
    // A verified route leg/interface transition advances a method; it is not
    // a failed training trial and does not satisfy a quantitative goal.
    if (preparation) stats.preparationMs = (stats.preparationMs ?? 0) + outcome.elapsedMs;
    else { stats.attempts++; stats.productive += Number(productive); stats.rejected += Number(outcome.status === 'rejected'); }
    stats.spentGp += outcome.spentGp; stats.lostGp += outcome.lostGp; stats.elapsedMs += outcome.elapsedMs;
    if (outcome.status === 'interrupted') {
      stats.interrupted = (stats.interrupted ?? 0) + 1; stats.viability = 'uncertain';
      stats.cooldownUntil = outcome.at + Math.min(COOLDOWN_MS, 30_000 * stats.interrupted);
    } else if (!preparation) {
      stats.cooldownUntil = productive ? 0 : outcome.at + COOLDOWN_MS;
      stats.viability = productive ? 'viable' : 'temporarily-poor';
    }
    stats.idleObservationMs=outcome.observationOnly&&!productive?(stats.idleObservationMs??0)+outcome.elapsedMs:0;
    if(stats.idleObservationMs>=60_000){
      stats.viability='temporarily-poor';stats.cooldownUntil=outcome.at+30_000;
      goal.blocker={at:outcome.at,reason:'Read-only observations produced no objective effect for 60 seconds; recheck this method after a bounded cooldown.',recheckAt:outcome.at+30_000};
      stats.idleObservationMs=0;
    }
    stats.knowledgeRevision = pending.knowledgeRevision ?? 0;
    if (productive) {
      this.memory.learningRevision = (this.memory.learningRevision ?? 0) + 1;
      if (amount(outcome.facts,goal.target.fact)>amount(pending.before,goal.target.fact)) goal.lastObjectiveProgressAt=outcome.at;
      else goal.lastSupportProgressAt=outcome.at;
    }
    let supportSatisfied=false;
    const newlySatisfiedPrerequisite=(pending.method.prerequisites??[]).some(p=>met(outcome.facts,p)&&!met(pending.before,p));
    for (const support of goal.supportGoals ?? []) {
      if (met(outcome.facts, support.target) && outcome.status !== 'rejected' && outcome.status !== 'interrupted') {
        supportSatisfied = supportSatisfied || support.status !== 'satisfied';
        support.status = 'satisfied'; support.evidence = [...outcome.evidence];
      }
    }
    // Reaching a prerequisite is causal progress, even though the parent
    // outcome is not complete yet. Start the preparation watchdog again for
    // the next dependency rather than counting the old support chain.
    if (supportSatisfied || newlySatisfiedPrerequisite) {
      goal.preparationOnlyStreak = 0;
      goal.lastPreparationMethodId = undefined;
    }
    // `progress` is the journal's terminal status for a verified but
    // non-productive action. It is not objective progress: bank/interface
    // preparation can verify successfully while the selected production or
    // combat target remains unchanged. Count only a method effect, a
    // measurable intermediate fact, or a newly satisfied dependency as
    // progress so repeated setup cycles reach the bounded replan path.
    const causalProgress = productive || measurableIntermediate || supportSatisfied || newlySatisfiedPrerequisite;
    goal.attempts++; goal.noProgress = causalProgress ? 0 : goal.noProgress + 1;
    goal.spentGp += outcome.spentGp; goal.lostGp += outcome.lostGp; goal.deaths += outcome.deaths; goal.elapsedMs += outcome.elapsedMs;
    this.memory.sequence = outcome.sequence;
    delete this.memory.pending;
    if ((goal.preparationOnlyStreak ?? 0) >= 3 && !met(outcome.facts, goal.target)
      && !supportSatisfied && !newlySatisfiedPrerequisite) {
      goal.blocker={at:outcome.at,
        reason:'The same strategic method repeated preparation without measurable target progress; replan its causal chain instead of repeating the setup.',
        recheckAt:outcome.at+30_000,attempts:0};
      delete goal.plan;goal.planContext=undefined;
    }
    if (goal.spentGp > goal.budget.spendableGp || goal.lostGp > goal.budget.maxLossGp || goal.deaths > goal.budget.maxDeaths
      || goal.elapsedMs > goal.budget.maxDurationMs) {
      this.review(outcome.at, 'failure', 'Observed cost or risk exceeded the experiment budget.', outcome.evidence);
    } else if (outcome.status === 'verified' && met(outcome.facts, goal.target)) {
      this.review(outcome.at, 'success', 'The planned goal predicate was verified, not merely an individual click.', outcome.evidence);
    }
  }
}
