import type { Ambition } from './ambitions.ts';
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
  investigates?:string[];
  id: string;
  domain: Domain;
  target: Requirement;
  reason: string;
  evidence: string[];
  /** A supported, observed unlock can justify changing specialization. */
  source: 'need' | 'collection' | 'unlock' | 'frontier' | 'investigation';
  /** Reserve maintenance competes only when substantive work has no executable plan. */
  priority?: 'strategic' | 'maintenance';
};
export type Observation = Identity & {
  at: number;
  /** Equipment/skill/access bucket; NOT a tick, location or consumable count. */
  context: string;
  facts: Facts;
  budget: Budget;
  /** Registered executable capabilities, not prose supplied by another player. */
  capabilities: string[];
  /** Incremented by verified learning, not ticks, movement or untested messages. */
  knowledgeRevision?: number;
  strategy?: { id: string; protectedSkills: string[] };
  /** Fresh own balances; bank funds are not spendable at a shop until withdrawn. */
  funding?: { carriedGp: number; bankGp: number; reserveGp: number; evidence: string[] };
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
export type Step = {
  methodId: string; capability: string; prerequisites: Requirement[];
  /** Root objective followed by the dependency this method is intended to satisfy. */
  lineage?: Requirement[];
  goalKey?: string;
  supportGoalId?: string;
};
export type SupportGoal = {
  id: string; parentId: string; target: Requirement;
  purpose: 'prerequisite' | 'investigate-blocker';
  reason: string; status: 'pending' | 'active' | 'satisfied';
  evidence: string[];
};
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
  strategyId?: string;
  ambitionId?: Ambition['id'];
  workingReserveGp?: number;
  plan?: Plan;
  planContext?: string;
  lastObjectiveProgressAt?: number;
  lastSupportProgressAt?: number;
  supportGoals?: SupportGoal[];
  investigation?: Opportunity;
  requestedSupport?: { target: Requirement; reason: string; evidence: string[] };
  blocker?: { at: number; reason: string; recheckAt: number };
  fundingGrants?: Array<{ at: number; ceilingGp: number; evidence: string[] }>;
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
  idleObservationMs?: number;
  interrupted?: number;
  viability?: 'viable' | 'uncertain' | 'temporarily-poor' | 'disproven';
  knowledgeRevision?: number;
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
  supportGoalId?: string;
  knowledgeRevision?: number;
};
export type Memory = Identity & {
  schema: 1;
  /** Durable motivation; combat build restrictions live separately. */
  ambition?: Ambition;
  /** Initial roles are small scoring preferences, never capability restrictions. */
  preferences: Partial<Record<Domain, number>>;
  active?: Goal;
  pending?: Pending;
  sequence: number;
  learningRevision?: number;
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
  status: 'verified' | 'progress' | 'rejected' | 'unknown' | 'interrupted';
  at: number;
  facts: Facts;
  spentGp: number;
  lostGp: number;
  deaths: number;
  elapsedMs: number;
  evidence: string[];
  observationOnly?: boolean;
};
