import { createHash } from "node:crypto";
import { Episode, PolicyUpdate, type Observation } from "./contracts.ts";
import { Store } from "./store.ts";

export const POLICY = "safe-method-selector-v1";
export const OBJECTIVE = "self-sufficient-pve-v1";
/** Frozen normalization: progress/100 per minute, net GP/100 per minute;
 * unlocks once each, nonmonetary scarcity/10, death penalty 100, failure 2.
 * Coins deposited/withdrawn are never income or expense. */
export function utility(e: Episode, newUnlocks: number): number {
  const m = e.metrics;
  const minutes = Math.max(m.elapsed_ms / 60000, 1 / 60);
  return m.progress / 100 / minutes + newUnlocks * 2
    + (m.income_gp - m.acquisition_gp - m.losses_gp) / 100 / minutes
    - m.scarcity_units / 10 - m.deaths * 100 - m.failures * 2;
}
export function contextKey(o: Observation, methodEnvironment: string): string {
  const body = JSON.stringify({
    profile: o.profile_id, objective: OBJECTIVE,
    // Exact levels avoid incorrectly merging a requirement threshold within a band.
    skills: o.skills.map(s => [s.name, s.base]).sort(),
    equipment: o.equipment.map(i => [i.slot, i.id]).sort(),
    environment: methodEnvironment,
  });
  return createHash("sha256").update(body).digest("hex");
}
export function stats(values: number[]) {
  let n = 0, mean = 0, m2 = 0;
  for (const value of values) {
    n++;
    const delta = value - mean;
    mean += delta / n;
    m2 += delta * (value - mean);
  }
  return { n, mean, m2, variance: n > 1 ? m2 / (n - 1) : null };
}
export type Method = {
  id: string; safe: boolean; supported: boolean; prerequisitesMet: boolean;
  resourceBurden: number; costGp: number;
};
export class Learner {
  constructor(readonly store: Store, public seed = 12345, readonly exploration = 0.1) {
    const prior = store.records<{ next_seed: number }>("decisions").at(-1);
    if (prior) this.seed = prior.next_seed;
    if (exploration < 0 || exploration > 0.1) throw new Error("EXPLORATION_BUDGET");
  }
  record(raw: unknown): boolean {
    const e = Episode.parse(raw);
    if (e.objective_id !== OBJECTIVE || e.policy_version !== POLICY) throw new Error("POLICY_VERSION_MISMATCH");
    if (e.start.profile_id !== e.profile_id || e.end.profile_id !== e.profile_id
      || e.start.character !== e.character || e.end.character !== e.character
      || e.start.world !== e.world || e.end.world !== e.world) throw new Error("EPISODE_IDENTITY_MISMATCH");
    return this.store.db.transaction(() => {
      if (!this.store.append("episodes", e.episode_id, e)) return false;
      // Interrupted/uncertain attempts remain durable but are not comparable complete trips.
      if (!e.full_trip || !["COMPLETED", "FAILED"].includes(e.status)) return true;
      const episodes = this.store.records<Episode>("episodes");
      const priorUnlocks = new Set(episodes.filter(p => p.episode_id !== e.episode_id
        && p.character === e.character && p.world === e.world && p.profile_id === e.profile_id)
        .flatMap(p => p.metrics.new_unlocks));
      const novel = new Set(e.metrics.new_unlocks.filter(u => !priorUnlocks.has(u))).size;
      const value = utility(e, novel);
      const old = this.estimates(e.context, e.method_id).values;
      const next = stats([...old, value]);
      const update = PolicyUpdate.parse({
        schema_version: "1.0", update_id: e.episode_id + ":" + POLICY,
        episode_id: e.episode_id, context: e.context, method_id: e.method_id,
        policy_version: POLICY, utility: value, n: next.n, mean: next.mean, m2: Math.max(0, next.m2),
        seed: this.seed, reason: "Measured complete trip; fixed objective normalization",
      });
      this.store.append("policy_updates", update.update_id, update);
      this.store.append("method_estimates", update.update_id, { context: e.context, method: e.method_id, ...next });
      return true;
    }).immediate();
  }
  estimates(context: string, method: string) {
    const values = this.store.records<ReturnType<typeof PolicyUpdate.parse>>("policy_updates")
      .filter(u => u.context === context && u.method_id === method && u.policy_version === POLICY)
      .map(u => u.utility);
    const recent = values.slice(-20);
    return { values, historical: stats(values), recent: stats(recent), chosen: stats(recent.length >= 3 ? recent : values) };
  }
  private random() {
    this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  select(context: string, methods: Method[], budgetGp: number, frozen = false) {
    const eligible = methods.filter(m => m.safe && m.supported && m.prerequisitesMet
      && Number.isFinite(m.costGp) && m.costGp >= 0 && m.costGp <= budgetGp
      && Number.isFinite(m.resourceBurden) && m.resourceBurden >= 0)
      .sort((a,b) => a.resourceBurden - b.resourceBurden || a.id.localeCompare(b.id));
    if (!eligible.length) return { method: null, reason: "BLOCKED_NO_SAFE_FEASIBLE_METHOD" };
    const seedBefore = this.seed;
    const scored = eligible.map(m => ({ m, stats: this.estimates(context, m.id).chosen }));
    let pick = scored[0]!, reason = "VETTED_BASELINE";
    const warm = scored.filter(s => s.stats.n < 3);
    if (!frozen && warm.length) {
      const min = Math.min(...warm.map(s => s.stats.n));
      const ties = warm.filter(s => s.stats.n === min);
      pick = ties[Math.floor(this.random() * ties.length)]!;
      reason = "BOUNDED_SAFE_WARMUP";
    } else if (!frozen && this.random() < this.exploration) {
      const min = Math.min(...scored.map(s => s.stats.n));
      const ties = scored.filter(s => s.stats.n === min);
      pick = ties[Math.floor(this.random() * ties.length)]!;
      reason = "SEEDED_SAFE_EXPLORATION";
    } else {
      const supported = scored.filter(s => s.stats.n >= 3);
      const rank = (s: typeof pick) => s.stats.mean - Math.sqrt((s.stats.variance ?? 0) / s.stats.n);
      supported.sort((a,b) => rank(b) - rank(a) || a.m.resourceBurden - b.m.resourceBurden || a.m.id.localeCompare(b.m.id));
      if (supported[0]) { pick = supported[0]; reason = "MEASURED_FULL_TRIP_RANK"; }
    }
    if (!frozen) this.store.append("decisions", crypto.randomUUID(), {
      context, method: pick.m.id, reason, seed: seedBefore, next_seed: this.seed, estimates: scored,
    });
    return { method: pick.m.id, reason };
  }
}
