/** Planner contracts. A fact is an agent's own observation, never a peer's assertion. */
export type Domain = 'combat' | 'crafting' | 'gathering' | 'exploration' | 'social';
export type Facts = Record<string, number>;
export type Requirement = { fact: string; minimum: number };
export type Budget = {
  /** Gold remaining after reserving food, ammunition, tools and essential equipment. */
  spendableGp: number;
  maxLossGp: number;
  maxDeaths: number;
  maxDurationMs: number;
};
export type Identity = { agent: string; world: string; revision: string };
export type Opportunity = {
  id: string;
  domain: Domain;
  target: Requirement;
  reason: string;
  evidence: string[];
  /** A supported, observed unlock can justify changing specialization. */
  source: 'need' | 'collection' | 'unlock' | 'frontier' | 'investigation';
};
export type Observation = Identity & {
  at: number;
  /** Equipment/skill/access bucket; NOT a tick, location or consumable count. */
  context: string;
  facts: Facts;
  budget: Budget;
  /** Registered executable capabilities, not prose supplied by another player. */
  capabilities: string[];
};
export type Method = {
  id: string;
  capability: string;
  domain: Domain;
  prerequisites: Requirement[];
  /** Predicted positive deltas. Stochastic effects still require outcome verification. */
  effects: Facts;
  /** Consumable inputs are deducted for each repetition in the projected plan. */
  consumes?: Facts;
  costGp: number;
  lossBoundGp: number;
  durationMs: number;
  risk: 'safe' | 'bounded' | 'unknown' | 'pvp';
};
export type Step = { methodId: string; capability: string; prerequisites: Requirement[] };
export type Plan = { steps: Step[]; costGp: number; lossBoundGp: number; durationMs: number };
export type Goal = Opportunity & {
  key: string;
  context: string;
  startedAt: number;
  budget: Budget;
  baseline: number;
  spentGp: number;
  lostGp: number;
  deaths: number;
  elapsedMs: number;
  attempts: number;
  noProgress: number;
};
export type MethodStats = {
  attempts: number;
  productive: number;
  rejected: number;
  spentGp: number;
  lostGp: number;
  elapsedMs: number;
  cooldownUntil: number;
  preparationMs?: number;
};
export type Review = {
  goal: Goal;
  at: number;
  result: 'success' | 'partial' | 'failure';
  reason: string;
  evidence: string[];
};
export type Pending = {
  commandId: string;
  goalKey: string;
  context: string;
  method: Method;
  before: Facts;
  status: 'pending' | 'unknown';
};
export type Memory = Identity & {
  schema: 1;
  /** Initial roles are small scoring preferences, never capability restrictions. */
  preferences: Partial<Record<Domain, number>>;
  active?: Goal;
  pending?: Pending;
  sequence: number;
  methods: Record<string, MethodStats>;
  goalCooldowns: Record<string, number>;
  reviews: Review[];
  currentDomain?: Domain;
  domainChanges: Array<{ at: number; from?: Domain; to: Domain; reason: string; evidence: string[] }>;
};
export type Decision =
  | { type: 'execute'; goal: Goal; plan: Plan; step: Step }
  | { type: 'reconcile'; pending: Pending }
  | { type: 'blocked'; reason: string; missingCapabilities: string[] };
export type Outcome = {
  commandId: string;
  /** Monotonic per-agent event sequence supplied by its action journal. */
  sequence: number;
  status: 'verified' | 'progress' | 'deferred' | 'rejected' | 'unknown';
  at: number;
  facts: Facts;
  spentGp: number;
  lostGp: number;
  deaths: number;
  elapsedMs: number;
  evidence: string[];
};
