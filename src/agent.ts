#!/usr/bin/env bun
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Navigator, position } from './navigation/controller';
import { dialogueOption, bankOption, bowArrowCap, hasUsableArrows, isFood, isThreatened, harvestLevel, verifyBankTransfer } from './runtime-policy';
import { bankAt, economyNext, productionDialog, shouldHeal, combatDisposition, meleeTrainingSkill, nearbyAmmoRecovery, quiverRefill, activeOpponent, isApprovedNpcTarget, foodCount, type EconomyMemory } from './progression-policy';
import { loadCatalog } from './training/catalog';
import { TrainingDiscovery } from './training/discovery';
import { acquireController } from './controller-lease';
import { callSkill } from './skill-cli';
import { actionReady } from './action-cooldown';
import { advanceFoodBatch, loweDoor, rawFish, bankFood, type FoodBatch } from './food-batch';
import { mustEscape } from './escape-policy';
import {basicKit, canDefend} from './economy/defence';
import { loadGearCatalog } from './goals/catalog';
import { EquipmentGoals, usable } from './goals/planner';
import { PeerMarket } from './economy/market';
import { metalDialog, validateMetal } from './economy/metalworking';
import { mayPickpocketForAmmo } from './supply-policy';
import { chooseResourceGoal, shouldBankResource, type ResourceGoal } from './economy/resource-agent';
import { selectWork, observeWork, objectives } from './economy/objectives';
import { bowNext, bowReserve, validateBow, observeBow, bowBlocked } from './economy/bowmaking';
import { mission, outcomeReward } from './goals/outcomes';
import { saveGoalJson } from './goals/persistence';
import { preferActive, passive, progressTimedOut, recordAutonomy, type AutonomyMemory } from './autonomy';
import { shouldCloseAfterFoodWithdrawal } from './banking-policy';
import { preferRangedSupply } from './action-priority';
import { dropLearningCandidates, knowledgeSummary, recordObservedDrops, runeDiscoveryCandidates } from './world-knowledge';
import { foodCount as learnedFoodCount, foodBankReserve, learnedFoodReserve, recordFoodExperience, type FoodExperience } from './food-policy';
import { isAgentClutter, isUrgentClutter, isBankableResource, isFinishedArrow, surplusArrowAmount } from './inventory-policy';
import { lobsterPreparation, validateFishing, type FishingPreparation } from './fishing-progression';
import { beginActionIntent, finishActionIntent, loadActionIntent, type ActionIntent } from './action-intent';
import { verifyActionOutcome } from './action-outcome';
import { emptyLifecycle, loadLifecycle, saveLifecycle, setGoal, ensureTask, startTask, advance as advanceGoal, recordOutcome as recordGoalOutcome, learn as learnGoal, blockOrRetry as blockGoal, type GoalLifecycle } from './goals/lifecycle';
import { actionGoalKind, actionMatchesGoal, goalTitle, isPreparationAction, meaningfulGoalResult, type ActionGoalKind } from './goals/action-goal';
import { proposalsFromGoals } from './learning-pipeline';
import { observeWorld, recordRouteResult } from './shared-world';
import { recoverLegacyJournals } from './agency/journal-recovery.ts';
import { LiveAgency, isSelection, type Selection, type Verification } from './agency/live-adapter.ts';
import type { Task, TaskKind, Route } from './agency/world-model.ts';
import { randomUUID } from 'node:crypto';

type Json = Record<string, unknown>;
type GameState = {
  tick?: number;
  player?: Json | null;
  skills?: Array<Json>;
  inventory?: Array<Json>;
  equipment?: Array<Json>;
  combatStyle?: Json;
  nearbyNpcs?: Array<Json>;
  nearbyLocs?: Array<Json>;
  groundItems?: Array<Json>;
  dialog?: Json;
  combatEvents?: Array<Json>;
  shop?: Json;
  bank?: Json;
  modalOpen?: boolean;
  inGame?: boolean;
};
type Candidate = { id: string; type: string; fields?: Json; waitTicks: number };
type QTable = Record<string, Record<string, number>>;
type ForumState = {
  sent?: Record<string, string>;
  replies?: Record<string, string>;
  lastChatAt?: number;
  lastChatKey?: string;
  lastPostAt?: number;
  lastPostKey?: string;
  lastIntent?: string;
};
type GitHubLearningState = { queued?: Record<string, string>; published?: Record<string, string>; lastPublishedAt?: string };
type AppearanceMemory = { completed?: boolean; preset?: string; updatedAt?: string };

const root = resolve(import.meta.dir, "..");
// Keep all runner restarts attached to the user's existing online account
// configuration. Previously this lived only in the shell that first launched
// the agents, so a restart silently fell back to the unrelated demo account.
const clawscapeHome = process.env.CLAWSCAPE_HOME ?? resolve(root, "data", "online-home");

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const character = arg("character", "demo");
const steps = Number(arg("steps", "40"));
const alpha = Number(arg("alpha", "0.25"));
const gamma = Number(arg("gamma", "0.90"));
const epsilon = Number(arg("epsilon", "0.15"));
const profile = arg("profile", "default").replace(/[^a-z0-9_-]/gi, "");
const role = arg("role", "brawler").replace(/[^a-z0-9_-]/gi, "");
const build = arg("build", "melee").replace(/[^a-z0-9_-]/gi, "");
const forever = process.argv.includes("--forever");
// Public forum posting is optional. Quiet local learning is the default.
const forumEnabled = process.argv.includes('--forum') && !process.argv.includes('--no-social');
const githubLearnings = process.argv.includes("--github-learnings");
const bulkPickaxes = process.argv.includes("--bulk-pickaxes");
const intervalMs = Number(arg("interval-ms", "5000"));
const BUILD = { attackCap: 40, defenceCap: 1, prayerCap: 1, strengthCheck: 40, foodTripMinimum: 3, foodTripTarget: 8, bankFoodReserve: 100 } as const;
const LONG_TERM_GOALS: Record<string, string> = {
  clawscout: 'Build a sustainable melee character: improve weapon, shield, food and combat levels, then safely trial stronger areas.',
  stinger: 'Build a ranged-first character with reliable arrows and a magic route: complete supply skills, discover profitable drops and grow into stronger monsters.',
  coincrafter: 'Build sustainable wealth through the best available production: maintain woodcutting/fletching, complete the mining-to-smithing tool chain and learn rune production.',
  astra: 'Independently learn the world: finish prerequisites, map safe routes, test viable activities and become stronger through evidence-based choices.',
  featherer: 'Build a steady server supply of feathers: safely farm chickens, bank large batches, then test cow hides and other scarce resources.'
};
const WORLD_ROUTES = {
  lumbridge: { x: 3232, z: 3230 },
  // Verified normal ground knife source used by the economy controller. It
  // enables the same knife-on-log production flow for a self-supplying archer.
  lumbridgeKnife: { x: 3224, z: 3202 },
  // Verified reachable approach beside the ordinary trees on Lumbridge's
  // east side. Keep this on the navigable route; the old south tile produced
  // partial paths and trapped agents in the ammo-recovery loop.
  lumbridgeTrees: { x: 3258, z: 3249 },
  // 2004scape has no Lumbridge bank. Varrock West is a verified usable bank.
  varrockWestBank: { x: 3185, z: 3436 },
  varrockSouthEastMine: { x: 3285, z: 3365 },
  draynorFishing: { x: 3094, z: 3226 },
  lumbridgeCastle: { x: 3222, z: 3218 },
  wizardsTower: { x: 3105, z: 3162 },
  auburysRuneShop: { x: 3253, z: 3402 },
  lowesArchery: { x: 3233, z: 3425 },
  gerrantsFishingShop: { x: 3014, z: 3224 },
  portSarimSailor: { x: 3028, z: 3221 },
  karamjaLobsterFishing: { x: 2923, z: 3179 },
  // The Dwarven Mine is on the +6400 z-plane in this server. It is reached
  // through the verified Falador trapdoor, not by walking directly to the
  // underground coordinate.
  // The collision map reaches the walkable approach at (3018,3450); (3019,3450)
  // is the adjacent blocked footprint. Keep the approach tile in route memory.
  dwarvenMineEntrance: { x: 3018, z: 3450 },
  draynorCooking: { x: 3100, z: 3257 },
  lumbridgeSwamp: { x: 3195, z: 3183 },
  barbarianVillage: { x: 3063, z: 3416 },
  edgeville: { x: 3098, z: 3488 },
  stingerNorthSurvey: { x: 3239, z: 3500 },
  eastChickenResource: { x: 3228, z: 3298 },
  fredChickenResource: { x: 3187, z: 3278 },
  eastCowResource: { x: 3244, z: 3289 },
  westCowResource: { x: 3173, z: 3323 },
} as const;
const dataDir = profile === "" || profile === "default"
  ? resolve(root, "data")
  : resolve(root, "data", profile);
// Changed objective scales must not silently reuse rewards for raw item counts.
// Preserve the former table on disk as history; learn this objective separately.
const qPath = resolve(dataDir, "q-table-outcomes-v2.json");
const experiencePath = resolve(dataDir, "experience.jsonl");
const observationsPath = resolve(dataDir, "world-observations.jsonl");
const forumInboxPath = resolve(dataDir, "forum-inbox.jsonl");
const forumStatePath = resolve(dataDir, "forum-state.json");
const githubLearningPath = resolve(dataDir, "github-learnings.jsonl");
const githubLearningStatePath = resolve(dataDir, "github-learning-state.json");
mkdirSync(dataDir, { recursive: true });

const loadQ = (): QTable => {
  if (!existsSync(qPath)) return {};
  try {
    return JSON.parse(readFileSync(qPath, "utf8")) as QTable;
  } catch {
    return {};
  }
};
const q = loadQ();
let navigator: Navigator | undefined;
let training: TrainingDiscovery | undefined;
let travelAction: Candidate | null = null;
let peerMarket: PeerMarket | undefined;
let agency: LiveAgency | undefined;
let marketRetryAt=0;
const workPath = resolve(dataDir, 'work-state.json');
const actionIntentPath = resolve(dataDir, 'action-intent.json');
const goalLifecyclePath = resolve(dataDir, 'goal-lifecycle.json');
const goalLifecycle: GoalLifecycle = loadLifecycle(goalLifecyclePath);
const work: { foodBatch?: FoodBatch; fishing?: FishingPreparation; economy?: EconomyMemory; resource?: { goal?: ResourceGoal; site?: string; lastBankAt?: number }; autonomy?: AutonomyMemory; learning?: Json & { food?: FoodExperience }; appearance?: AppearanceMemory; foodWithdrawalPending?: boolean | 'raw'; fishingToolFundingUntil?: number; fishingToolTradeAttempted?: boolean; pickpocketStreak?: number; bankReturn?: { x: number; z: number; level: number }; bankReturnReady?: boolean; bankItems?: Json[]; failures: Record<string, { until: number; count: number }> } = (() => {
  try { return { failures: {}, ...JSON.parse(readFileSync(workPath, 'utf8')) }; } catch { return { failures: {} }; }
})();

function agencyFacts(state: GameState): Record<string, number> {
  const facts: Record<string, number> = { hp: Number(state.player?.hp ?? 0), coins: coinsIn((state.inventory ?? []) as Json[]) };
  for (const skill of state.skills ?? []) facts[`skill:${String(skill.name).toLowerCase()}`] = Number(skill.level ?? skill.baseLevel ?? 0);
  return facts;
}

const lifecycleDefinition = () => ({
  id: `${character}:continuous-progression`,
  kind: 'continuous' as const,
  title: LONG_TERM_GOALS[character] ?? `Progress as a ${role}`,
  role, build,
  why: 'make verified progress while learning safer and more efficient methods',
  steps: ['identify the next worthwhile subgoal', 'prepare prerequisites', 'execute and measure one productive cycle', 'review the evidence and adapt'],
  prerequisites: [{ id: 'world-access', description: 'connected character with a usable route', status: 'unknown' as const }],
  success: ['experience, useful items, gold, equipment, or verified exploration increases'],
  partial: ['the attempt produces evidence or a safe partial result'],
  failure: ['death, repeated rejection, or no meaningful progress within the bounded timeout'],
  limits: { deadlineMs: 30 * 60_000, maxRisk: role === 'economy' ? 1 : 3 },
});

function ensureLifecycleGoal(now=Date.now()): void {
  // Keep a concrete goal across controller iterations and restarts. The old
  // implementation recreated the generic bootstrap goal whenever the active
  // goal was concrete, erasing the goal's plan/review/learning context.
  const goal = goalLifecycle.active ?? setGoal(goalLifecycle, lifecycleDefinition(), now);
  if (goal.phase === 'set') advanceGoal(goalLifecycle, 'plan', now);
  if (goal.phase === 'plan') advanceGoal(goalLifecycle, 'prepare', now);
  // The bootstrap goal is only a migration-safe container. Once the planner
  // selects an action, startConcreteGoal replaces it with a real, bounded
  // goal. Never recreate a generic task over an already active concrete one.
  if (goal.kind === 'continuous' || goal.id.endsWith(':continuous-progression')) {
    ensureTask(goalLifecycle, {
      id: `${character}:bootstrap-cycle`,
      target: role === 'economy' ? 'select the first verified production or mining/smithing cycle' : 'select the first verified supply, exploration, or combat cycle',
      method: 'observe-state-and-select-a-concrete-goal',
      dependencies: ['connected observation', 'safe route or observed interaction'],
      resourceBudget: { deaths: 0, noProgressAttempts: 3 },
      stopConditions: ['unsafe health', 'unresolved action outcome', 'three no-effect attempts'],
    }, now);
  }
  saveLifecycle(goalLifecyclePath, goalLifecycle);
}

function activeConcreteGoalKind(): ActionGoalKind | undefined {
  const active = goalLifecycle.active;
  if (!active || active.kind === 'continuous' || active.id.endsWith(':continuous-progression')) return undefined;
  return active.kind as ActionGoalKind;
}

function startConcreteGoal(action: Candidate, now = Date.now()): void {
  let active = goalLifecycle.active;
  // A goal may make route progress without ever producing its promised
  // outcome. Cap that preparation/recovery phase so movement is not confused
  // with learning or completion.
  if (active && active.kind !== 'continuous' && active.task && active.task.attempts >= 20
    && active.learnings.length === 0
    && !active.outcomes.some(outcome => outcome.status === 'success')) {
    recordGoalOutcome(goalLifecycle, {
      at: now,
      status: 'failure',
      evidence: [`goal attempt budget exhausted without a productive result: ${active.task.id}`],
      reason: 'twenty bounded actions without a verified productive outcome',
    });
    blockGoal(goalLifecycle, 'goal attempt budget exhausted; select a different feasible objective');
    if (goalLifecycle.active) {
      goalLifecycle.active.phase = 'suspended';
      goalLifecycle.active.updatedAt = now;
    }
    saveLifecycle(goalLifecyclePath, goalLifecycle);
    active = goalLifecycle.active;
  }
  const actionKind = actionGoalKind(action);
  // Service actions are prerequisites of the current goal. They must not
  // replace it with a new bank/shop goal on every trip.
  const kind = isPreparationAction(action) ? (activeConcreteGoalKind() ?? actionKind) : actionKind;
  const replace = !active
    || active.kind === 'continuous'
    || active.id.endsWith(':continuous-progression')
    || ['learn', 'completed', 'blocked', 'suspended'].includes(active.phase)
    || active.task?.status === 'blocked'
    || !activeConcreteGoalKind();
  if (replace) {
    const id = `${character}:goal:${kind}:${now}`;
    setGoal(goalLifecycle, {
      id,
      kind,
      title: goalTitle(kind),
      role,
      build,
      why: 'choose the highest-value feasible next step from fresh observations and prior evidence',
      steps: ['identify the worthwhile outcome', 'prepare verified prerequisites', 'execute a bounded productive attempt', 'review evidence and learn a better method'],
      prerequisites: [
        { id: 'fresh-observation', description: 'fresh state and reachable target or route', status: 'ready', evidence: `selected from ${action.id}` },
        { id: 'safety', description: 'risk and resource limits remain acceptable', status: 'unknown' },
      ],
      success: ['XP, useful items, gold, equipment, or verified exploration increases'],
      partial: ['a prerequisite or new route is verified without wasting the full budget'],
      failure: ['death, repeated rejection, or no meaningful result within the bounded attempt'],
      limits: { deadlineMs: 30 * 60_000, maxRisk: role === 'economy' ? 1 : 3, maxResource: { deaths: 0, noProgressAttempts: 3 } },
    }, now);
  }
  const goal = goalLifecycle.active;
  if (!goal) return;
  if (goal.phase === 'set') advanceGoal(goalLifecycle, 'plan', now);
  if (goal.phase === 'plan') advanceGoal(goalLifecycle, 'prepare', now);
  ensureTask(goalLifecycle, {
    id: `${goal.id}:attempt`,
    target: goal.title,
    method: action.id,
    dependencies: ['fresh observation', 'verified target or route', 'safe supplies and equipment'],
    resourceBudget: { deaths: 0, noProgressAttempts: 3 },
    stopConditions: ['unsafe health', 'unresolved outcome', 'two repeated no-effect attempts'],
  }, now);
  advanceGoal(goalLifecycle, 'execute', now);
  saveLifecycle(goalLifecyclePath, goalLifecycle);
}

function goalCompatibleOptions(options: Candidate[]): Candidate[] {
  const kind = activeConcreteGoalKind();
  if (!kind || ['learn', 'completed', 'blocked', 'suspended'].includes(goalLifecycle.active?.phase ?? '')) return options;
  const compatible = options.filter(action => actionMatchesGoal(action, kind));
  return compatible.length ? compatible : options;
}
if (bulkPickaxes && role === 'economy') {
  work.economy ??= { bankItems: work.bankItems ?? [] };
  work.economy.metal ??= {};
  if (work.economy.metal.bulkPickaxeAudit !== 'complete') work.economy.metal.bulkPickaxeAudit = 'pending';
}
const saveWork = () => saveGoalJson(workPath,work);
// A controller restart must not resurrect a transient action that was already
// stale when the previous process ended. Re-observe the world and let the
// planner choose a real goal action instead.
const staleStartupAction = work.autonomy?.active?.action ?? '';
const startupRecent = work.autonomy?.recentActions ?? [];
const startupCycle = startupRecent.length >= 4 && new Set(startupRecent.slice(-4)).size === 1
  && (/^autonomy-/i.test(staleStartupAction) || /economy-metal-(secure-gold|withdraw-tool-cash)/i.test(staleStartupAction));
if (startupCycle || /^(peer-message-|await-combat-state-clear$|economy-metal-recovery$|close-(finished|stalled)-shop$|style-)/i.test(staleStartupAction)) {
  work.autonomy ??= {};
  work.autonomy.active = undefined;
  work.autonomy.recentActions = [];
  saveWork();
}

// Appearance is an agent-owned preference, separate from build mechanics. Each
// character gets a stable style once, so restarts do not repeatedly mutate it.
const appearancePresets: Record<string, { name: string; args: string[] }> = {
  clawscout: { name: 'brawler', args: ['looks', 'set', '--gender', 'man', '--hair', 'man_hair_wildspikes', '--jaw', 'man_jaw_goatee', '--torso', 'man_torso_jacket', '--arms', 'man_arms_musclebound', '--legs', 'man_legs_shorts', '--skin', '4', '--hair-colour', '8', '--torso-colour', '12'] },
  stinger: { name: 'ranger', args: ['looks', 'set', '--gender', 'man', '--hair', 'man_hair_long', '--jaw', 'man_jaw_none', '--torso', 'man_torso_shirt', '--arms', 'man_arms_loose_sleeved', '--legs', 'man_legs_flares', '--skin', '2', '--hair-colour', '10', '--torso-colour', '6'] },
  coincrafter: { name: 'merchant-smith', args: ['looks', 'set', '--gender', 'man', '--hair', 'man_hair_cropped', '--jaw', 'man_jaw_moustache', '--torso', 'man_torso_two_toned', '--arms', 'man_arms_large_cuffed', '--legs', 'man_legs_turn_ups', '--skin', '6', '--hair-colour', '5', '--torso-colour', '14'] },
  astra: { name: 'explorer', args: ['looks', 'set', '--gender', 'woman', '--hair', 'woman_hair_long', '--torso', 'woman_torso_simple', '--arms', 'woman_arms_bare_arms', '--legs', 'woman_legs_shorts', '--skin', '3', '--hair-colour', '9', '--torso-colour', '11'] },
};

async function customizeAppearance(): Promise<void> {
  if (work.appearance?.completed) return;
  const preset = appearancePresets[character];
  if (!preset) return;
  try {
    await cliCall(preset.args);
    work.appearance = { completed: true, preset: preset.name, updatedAt: new Date().toISOString() };
    saveWork();
    console.log(JSON.stringify({ appearance: 'customized', character, preset: preset.name }));
  } catch (error) {
    // Cosmetic failure must never prevent the agent from playing or recovering.
    console.error(JSON.stringify({ appearance: 'deferred', character, error: String(error).slice(0, 240) }));
  }
}
const gearCatalog = loadGearCatalog();
const equipmentGoals = new EquipmentGoals(resolve(dataDir, 'equipment-goals.json'), gearCatalog, role, build === 'ranged-magic');
equipmentGoals.seedBank(work.economy?.bankItems ?? work.bankItems ?? []);
const defensiveGoals = new EquipmentGoals(resolve(dataDir,'defensive-equipment-goals.json'),gearCatalog,'defender',false);
defensiveGoals.seedBank(work.economy?.bankItems ?? work.bankItems ?? []);
function available(options: Candidate[]): Candidate[] {
  // A discovery scan is useful once, but repeating the same empty scan is not
  // progress. After two failed scans, let the higher-level planner choose a
  // different supply, training, banking, or exploration objective.
  const discovery = options.filter(o => /^(scan|map-loading)/i.test(o.id));
  // Discovery exhaustion applies only to those discovery candidates. It must
  // never discard an otherwise eligible ordinary action in the same set.
  const exhaustedDiscovery = discovery.length > 0 && discovery.every(o => (work.failures[o.id]?.count ?? 0) >= 2);
  const eligibleOptions = exhaustedDiscovery ? options.filter(o => !discovery.includes(o)) : options;
  if (options.length > 0 && eligibleOptions.length === 0) return [];
  const ready = eligibleOptions.filter(o => {
    const failure = work.failures[o.id];
    // Two unchanged/rejected attempts are evidence that this exact action is
    // not currently viable. Let exploration, banking or another candidate
    // take over instead of replaying the same route forever.
    return actionReady(failure);
  });
  if (ready.length) return ready;
  // A scan, wait, map load, or explicit recovery is safe to retry when every
  // ordinary action is cooling down. Prefer the planner's specific recovery
  // (for example scan-for-bank or scan-for-Lowe) over a generic local scan.
  const recovery = eligibleOptions.filter(o => /scan|map-loading|recovery|explore|wait/i.test(o.id) && (work.failures[o.id]?.count ?? 0) < 2);
  if (recovery.length) return recovery.slice(0, 1);
  // If no recovery action exists, retry the least recently cooled action so a
  // temporary server rejection cannot make the episode silently idle.
  const retry = eligibleOptions
    .filter(o => (work.failures[o.id]?.until ?? 0) <= Date.now() && (work.failures[o.id]?.count ?? 0) < 2)
    .sort((a, b) => (work.failures[a.id]?.until ?? 0) - (work.failures[b.id]?.until ?? 0))[0];
  return retry ? [retry] : [];
}
function noteFailure(action: Candidate) {
  const count = (work.failures[action.id]?.count ?? 0) + 1;
  work.failures[action.id] = { count, until: Date.now() + Math.min(300_000, 30_000 * count) };
  if(role==='economy'&&work.economy?.objectives?.intent&&action.id.startsWith('economy-')&&count>=2)work.economy.objectives.blocked[work.economy.objectives.intent.id]=Date.now()+300_000;
  if(action.id.startsWith('economy-bow-')&&work.economy&&count>=2)bowBlocked(work.economy,'Repeated action or route failure: '+action.id);
  if (typeof action.fields?.trainingSite === 'string') training?.block(action.fields.trainingSite, 'action-or-route-failed');
  saveWork();
}

function loadForumState(): ForumState {
  if (!existsSync(forumStatePath)) return { sent: {}, replies: {} };
  try { return JSON.parse(readFileSync(forumStatePath, "utf8")) as ForumState; } catch { return { sent: {}, replies: {} }; }
}

function saveForumState(value: ForumState): void {
  writeFileSync(forumStatePath, JSON.stringify(value, null, 2) + "\n");
}

function loadGitHubLearningState(): GitHubLearningState {
  if (!existsSync(githubLearningStatePath)) return { queued: {}, published: {} };
  try { return JSON.parse(readFileSync(githubLearningStatePath, "utf8")) as GitHubLearningState; } catch { return { queued: {}, published: {} }; }
}

async function cliCall(args: string[]): Promise<Json> {
  const result = await callSkill(character, args, clawscapeHome);
  if (result.error || result.success === false) throw new Error(`CLI rejected ${args[1] ?? args[0]}: ${result.reason ?? ''} ${result.message ?? result.error ?? ''}`);
  return result;
}

function stateFrom(value: Json): GameState {
  const state = value.state;
  const full = (state && typeof state === "object" ? state : value) as GameState;
  if (!full.player || !Array.isArray(full.inventory) || !Array.isArray(full.skills)) {
    throw new Error('Full connected state required; refusing summary or delta');
  }
  return full;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function level(state: GameState, name: string): number {
  const skill = (state.skills ?? []).find((item) => text(item.name) === name);
  return typeof skill?.level === "number" ? skill.level : 1;
}

function progression(state: GameState): Json {
  return {objective:mission(role),longTermGoal:LONG_TERM_GOALS[character] ?? mission(role),autonomy:work.autonomy?.active,...progressionDetails(state),...(role==='economy'?{productionDecision:work.economy?.objectives?.decision}:{} )};
}
function runeMysteriesComplete(): boolean {
  try { return JSON.parse(readFileSync(resolve(dataDir, 'rune-mysteries.json'), 'utf8')).completed === true; } catch { return false; }
}
function progressionDetails(state: GameState): Json {
  const equipment = equipmentGoals.plan(state);
  let runeMysteries: Json = { complete: false, status: 'not yet checked by the quest runner' };
  try { const saved = JSON.parse(readFileSync(resolve(dataDir, 'rune-mysteries.json'), 'utf8')); runeMysteries = { complete: saved.completed === true, stage: saved.stage, checkedAt: saved.journalAt, blocker: saved.blocked }; } catch {}
  const equipmentBrief = { target: equipment.target, phase: equipment.goal?.phase, reason: equipment.goal?.reason, status: equipment.status };
  if (character === 'featherer') {
    const items = [...(work.bankItems ?? []), ...(state.inventory ?? [])];
    const total = (pattern: RegExp) => items.reduce((sum, item) => pattern.test(String(item.name ?? '')) ? sum + Number(item.count ?? 1) : sum, 0);
    const feathers = total(/^feather$/i);
    const hides = total(/^cowhide$/i);
    const resourceGoal = chooseResourceGoal(work.bankItems ?? [], state.inventory ?? []);
    return {
      stage: resourceGoal === 'feathers' ? 'feather-supply' : resourceGoal === 'cow-hides' ? 'cowhide-supply' : 'resource-survey',
      goal: resourceGoal === 'feathers' ? `Bank 500 feathers (${feathers}/500)` : resourceGoal === 'cow-hides' ? `Bank 50 cow hides (${hides}/50)` : 'Survey and supply another scarce resource',
      resourceGoal,
      feathers,
      cowHides: hides,
      safety: 'farm only reachable targets; bank in batches; keep combat fallback available',
      equipment: equipmentBrief,
      runeMysteries,
    };
  }
  if (equipment.target) return { stage: 'equipment-progression', goal: equipment.target, equipment: equipmentBrief, runeMysteries };
  if (equipment.capital && !equipment.capital.complete) return { stage: equipment.capital.targetCoins===null?'realize-production-profit':'fund-upgrades', goal: equipment.capital.targetCoins===null?'Sell unreserved production surplus':'Build liquid upgrade reserve',
    coins: equipment.capital.observedCoins, targetCoins: equipment.capital.targetCoins, reason: equipment.capital.reason, equipment: equipmentBrief, runeMysteries };
  const knowledge = knowledgeSummary(role, build, work.learning);
  const foodMemory = work.learning?.food;
  const foodPolicy = { trainingReserve: learnedFoodReserve(foodMemory), pvpReserve: learnedFoodReserve(foodMemory, true), bankReserve: foodBankReserve(foodMemory), observedEncounters: foodMemory?.encounters ?? 0, observedFoodConsumed: foodMemory?.foodConsumed ?? 0 };
  if (role === "economy") return { stage: "banked-production", goal: work.economy?.goal ?? "recover tools, process stored logs, gather near a bank", reason: work.economy?.reason, selectedSite: work.economy?.selectedSite, woodcutting: level(state, 'woodcutting'), fletching: level(state, 'fletching'), runeMysteries, runeLearning: knowledge, foodPolicy, equipment: equipmentBrief };
  if (build === "ranged-magic") return { stage: "ranged-magic-foundation", goal: runeMysteries.complete ? "Farm verified local rune/arrow sources while maintaining ranged supplies" : "Maintain ranged supplies; complete Rune Mysteries with the single-owner quest runner", runeMysteries, runeLearning: knowledge, foodPolicy, style: "train with the bow while the magic supply route is unavailable", gear: "best useful acquired bow and compatible arrows", equipment: equipmentBrief };
  const attack = level(state, "attack");
  const strength = level(state, "strength");
  const foodCount = (state.inventory ?? []).reduce((sum, item) => /^(shrimp|anchovies|trout|salmon|sardines|herring|tuna|lobster|swordfish|bread|pizza)/i.test(String(item.name)) ? sum + (typeof item.count === "number" ? item.count : 1) : sum, 0);
  if (foodCount < learnedFoodReserve(foodMemory)) return { stage: "food-supply", goal: "Learn the smallest safe cooked-food reserve", style: "fish/cook only when the learned trip reserve is short", gear: "keep current combat gear; resupply before risking it" };
  if (strength < BUILD.strengthCheck) {
    return { stage: "strength-foundation", goal: "Strength 40", style: "strength", gear: "best available one-handed weapon + shield" };
  }
  if (attack < BUILD.attackCap) {
    return { stage: "rune-gate", goal: "Attack 40", style: "attack", gear: "upgrade weapon whenever an exposed shop/drop permits it" };
  }
  return { stage: "combat-growth", goal: "Improve melee capability through useful levels, gear and sustainable encounter choices", style: "strength within the agreed build", gear: "best worthwhile supported upgrade; capped XP alone is not progress" };
}

function forumAnswerEvidence(state: GameState, request: string): string | null {
  const observed = [
    ...(state.inventory ?? []).map((item) => String(item.name)),
    ...(state.equipment ?? []).map((item) => String(item.name)),
    ...(state.nearbyLocs ?? []).filter((loc) => loc.reachable === true).map((loc) => String(loc.name)),
  ].filter(Boolean);
  const requestWords = text(request);
  const relevant = requestWords.includes("arrow") || requestWords.includes("bow") || requestWords.includes("staff") || requestWords.includes("rune") || requestWords.includes("ranged") || requestWords.includes("magic")
    ? observed.filter((name) => /arrow|bow|staff|rune/i.test(name))
    : requestWords.includes("food") || requestWords.includes("fishing") || requestWords.includes("combat") || requestWords.includes("gear") || requestWords.includes("party") || requestWords.includes("meet") || requestWords.includes("fight")
      ? observed.filter((name) => /shrimp|fish|food|sword|scimitar|shield|bow|staff|goblin|rat|skeleton/i.test(name))
      : observed.filter((name) => /tree|ore|mine|bank|range|stove|fire|fishing|shop/i.test(name));
  if (relevant.length === 0) {
    return "I don't know that yet. I haven't tested it in this world, so I would rather not guess.";
  }
  const places = (state.nearbyLocs ?? []).filter((loc) => loc.reachable === true).map((loc) => String(loc.name)).filter(Boolean);
  const place = [...new Set(places)][0];
  return "I can confirm " + [...new Set(relevant)].slice(0, 4).join(", ") + (place ? " near " + place : " nearby") + ".";
}

function socialVoice(): { opener: string; plan: string } {
  if (character === "clawscout") return { opener: "Good shout", plan: "I'm building a hard-hitting melee setup, but I won't throw a trip away without food." };
  if (character === "stinger") return { opener: "That sounds worth checking", plan: "I'm trying the bow first and keeping an eye out for a proper magic route." };
  if (character === "astra") return { opener: "Thanks, that helps", plan: "I'm still mapping the world and testing what I can safely handle." };
  if (character === "featherer") return { opener: "Useful lead", plan: "I'm building a reliable feather supply first, then I'll test cow hides and other scarce resources." };
  return { opener: "Useful lead", plan: "I'm gathering supplies now, so I can bring food or materials once I have a decent batch." };
}

function socialIntent(state: GameState): string {
  const plan = progression(state);
  return `${String(plan.stage ?? "exploring")}:${String(plan.goal ?? "learn the area")}`;
}

async function socialPulse(state: GameState): Promise<void> {
  if (!forumEnabled) return;
  const saved = loadForumState();
  const now = Date.now();
  // Proactive questions are one-shot requests for help, not status updates.
  // Once an agent has asked its role-specific question, do not repeat it when
  // the goal, episode, or supervisor process changes. A future answer can be
  // handled by syncForum(); until then the agent continues from verified local
  // knowledge and prior successful work.
  const displayName = character.charAt(0).toUpperCase() + character.slice(1);
  const alreadyAsked = (saved as any).questionAsked === true || String(saved.lastChatKey ?? '').includes(`${displayName} here.`);
  if (alreadyAsked) {
    saved.lastIntent = socialIntent(state);
    (saved as any).questionAsked = true;
    saveForumState(saved);
    return;
  }
  const intent = socialIntent(state);
  const firstSocial = !saved.lastIntent;
  const plan = progression(state);
  const goal = String(plan.goal ?? "learning the world");
  const messages: Record<string, { chat: string; title: string; body: string }> = {
    clawscout: {
      chat: `ClawScout here. Does anyone know a worthwhile melee monster for my current level?`,
      title: "ClawScout: which melee monster should I test next?",
      body: `I'm ClawScout, a melee brawler working on ${goal}. Which monster would you recommend I test next, and why? Please give one answer. I will report whether I gained XP and useful drops, and whether the food cost was safe.`
    },
    stinger: {
      chat: `Stinger here. Which monster has given you the most useful arrow or rune drops?`,
      title: "Stinger: asking for one arrow or rune source",
      body: `I'm Stinger, building a ranged/magic setup and currently working on ${goal}. What is one reliable monster for arrows or runes in this world? If you have not tested it yourself, please say so. I will verify the drop before relying on it.`
    },
    coincrafter: {
      chat: `CoinCrafter here. Does anyone know the best bank-nearby ore route they have actually tested?`,
      title: "CoinCrafter: asking about one ore route",
      body: `I'm CoinCrafter, trying to turn gathering and processing into steady progress and profit. My current goal is ${goal}. Which one bank-nearby ore route have you personally tested? I am especially interested in the time from mining to banking, not just the mine name.`
    },
    astra: {
      chat: `Astra here. What is one place you tested that was useful for early progression?`,
      title: "Astra: asking for one tested progression place",
      body: `I'm Astra, still learning this world independently. My current goal is ${goal}. What is one place you personally tested that helped progression? Please include what you gained there; I will verify the route and result myself.`
    },
    featherer: {
      chat: `Featherer here. What is one resource that is currently in short supply?`,
      title: "Featherer: asking about one scarce resource",
      body: `I'm Featherer, building a steady supply of feathers for ranged training. My current goal is ${goal}. What is one resource the server currently needs most? Please give one tested answer; I will verify the route and result myself.`
    }
  };
  const message = messages[character] ?? messages.astra;
  const socialKey = `${message.chat}|${intent}`;
  // Party proposals are evidence-based: only report a mine and offer an escort
  // when the same observation contains both the resource and a nearby attackable
  // monster. A message is a proposal, not permission to control the other agent.
  if (character === 'clawscout' && !(saved as any).orePartyProposalAt || character === 'clawscout' && now - Number((saved as any).orePartyProposalAt ?? 0) >= 30 * 60_000) {
    const ore = (state.nearbyLocs ?? []).find(loc => /^(mithril|adamant(?:ite)?|adamant) ore|mithril|adamant/i.test(String(loc.name)) && loc.reachable === true);
    const threat = (state.nearbyNpcs ?? []).find(npc => Number(npc.combatLevel ?? 0) > 0 && npc.optionsWithIndex?.some(option => /^attack$/i.test(String(option.text))));
    if (ore && threat) {
      const body = `I found ${String(ore.name)} nearby. The area is occupied by ${String(threat.name)} (level ${Number(threat.combatLevel)}), so it is not a free mining spot. If you want to test it, I can try to protect the route while you mine; let me know first.`;
      try { await cliCall(["act", "privateMessage", "--json", JSON.stringify({ targetName: "Coincrafter", message: body.slice(0, 220) })]); } catch (error) { console.log(JSON.stringify({ social: 'party-proposal-deferred', error: String(error).slice(0, 180) })); }
      (saved as any).orePartyProposalAt = now;
      (saved as any).orePartyEvidence = { ore: String(ore.name), threat: String(threat.name), combatLevel: Number(threat.combatLevel), at: new Date(now).toISOString() };
      saveForumState(saved);
    }
  }
  // A long-running controller may start a new episode every few minutes. A
  // time-only cooldown therefore still repeats the same question forever.
  // Treat an unchanged question and unchanged goal as already handled; a new
  // goal or a changed observation can produce a new human-like update.
  if ((firstSocial || (saved.lastChatKey !== socialKey && now - (saved.lastChatAt ?? 0) >= 15 * 60_000))) {
    try {
      await cliCall(["act", "say", "--json", JSON.stringify({ message: message.chat.slice(0, 220) })]);
      console.log(JSON.stringify({ social: "chat", character }));
    } catch (error) {
      console.log(JSON.stringify({ social: "chat-deferred", error: String(error).slice(0, 180) }));
    }
    saved.lastChatAt = now;
    saved.lastChatKey = socialKey;
    (saved as any).questionAsked = true;
  }
  const postKey = `${message.title}|${goal}|${intent}`;
  if ((firstSocial || (saved.lastPostKey !== postKey && now - (saved.lastPostAt ?? 0) >= 45 * 60_000))) {
    const bodyPath = resolve(dataDir, "social-update.txt");
    writeFileSync(bodyPath, message.body + "\n");
    try {
      await cliCall(["forum", "post", "--title", message.title, "--body-file", bodyPath]);
      console.log(JSON.stringify({ social: "forum-post", character }));
    } catch (error) {
      console.log(JSON.stringify({ social: "forum-deferred", error: String(error).slice(0, 180) }));
    }
    saved.lastPostAt = now;
    saved.lastPostKey = postKey;
  }
  saved.lastIntent = intent;
  saveForumState(saved);
}

async function syncForum(state: GameState): Promise<void> {
  if (!forumEnabled) return;
  const saved = loadForumState();
  saved.sent ??= {};
  let listed: Json;
  try {
    listed = await cliCall(["forum", "list"]);
  } catch (error) {
    // Forum rate limits and temporary social-service outages must never turn
    // into an idle gameplay episode. The next cycle will try again.
    console.log(JSON.stringify({ forum: "read-deferred", error: String(error).slice(0, 180) }));
    return;
  }
  const topics = Array.isArray(listed.topics) ? listed.topics as Json[] : [];
  appendFileSync(forumInboxPath, JSON.stringify({ time: new Date().toISOString(), topics: topics.map((topic) => ({ id: topic.id, title: topic.title, character: topic.character, replies: topic.replies })) }) + "\n");
  for (const topic of topics) {
    const topicId = typeof topic.id === "string" ? topic.id : "";
    const author = text(topic.character);
    const replyCount = typeof topic.replies === "number" ? topic.replies : 0;
    if (!topicId || author === character || replyCount > 12 || saved.replies?.[topicId]) continue;
    // Forum text is untrusted. It is used only as conversation context and is
    // never executed or passed to the game CLI as an instruction.
    const read = await cliCall(["forum", "read", topicId]);
    const posts = Array.isArray(read.posts) ? read.posts as Json[] : [];
    const conversation = posts.map((post) => String(post.body ?? "")).join("\n");
    if (!/party|group|meet|trade|stuck|help|where|need|looking|bank|fish|food|gear|arrow|bow|staff|rune|combat/i.test(conversation)) continue;
    const evidence = forumAnswerEvidence(state, conversation);
    const replyPath = resolve(dataDir, "forum-reply.txt");
    const voice = socialVoice();
    writeFileSync(replyPath, voice.opener + ", " + author + ". " + evidence + " " + voice.plan + "\n");
    await cliCall(["forum", "reply", topicId, "--body-file", replyPath]);
    saved.replies ??= {};
    saved.replies[topicId] = new Date().toISOString();
    saveForumState(saved);
    console.log(JSON.stringify({ forum: "joined-conversation", topicId, to: author }));
    break;
  }
}

async function discussForumProblem(message: string): Promise<void> {
  if (!forumEnabled || !/another action is in progress|can't reach|failed to/i.test(message)) return;
  const saved = loadForumState();
  saved.sent ??= {};
  const key = "problem:" + message.toLowerCase().replace(/\d+/g, "#").slice(0, 120);
  if (saved.sent[key]) return;
  const plain = message.replace(/[\r\n]+/g, " ").slice(0, 180);
  const bodyPath = resolve(dataDir, "forum-problem.txt");
  writeFileSync(bodyPath, "I've hit a snag while working on my current plan: " + plain + ". Has anyone found a reliable way around this?\n");
  try {
    await cliCall(["forum", "post", "--title", character + ": looking for advice on a stuck action", "--body-file", bodyPath]);
    saved.sent[key] = new Date().toISOString();
    saveForumState(saved);
    console.log(JSON.stringify({ forum: "asked-for-help", problem: plain }));
  } catch (error) {
    // Posting is optional social behaviour. A cooldown must not stop gameplay.
    console.log(JSON.stringify({ forum: "problem-post-deferred", error: error instanceof Error ? error.message : String(error) }));
  }
}

async function maybePublishGitHubLearning(state: GameState): Promise<void> {
  if (!githubLearnings) return;
  const proposals = proposalsFromGoals([...goalLifecycle.history, ...(goalLifecycle.active ? [goalLifecycle.active] : [])] as any);
  if (!proposals.length) return;
  const saved = loadGitHubLearningState();
  saved.queued ??= {};
  saved.published ??= {};
  for (const proposal of proposals) {
    if (saved.queued[proposal.key] || saved.published[proposal.key]) continue;
    const request = { time: new Date().toISOString(), character, proposal, reviewRequired: true, importPolicy: 'agents may import only after maintainer review and merge' };
    appendFileSync(githubLearningPath, JSON.stringify(request) + "\n");
    saved.queued[proposal.key] = new Date().toISOString();
    console.log(JSON.stringify({ github: "knowledge-change-requested", key: proposal.key, reviewRequired: true }));
  }
  writeFileSync(githubLearningStatePath, JSON.stringify(saved, null, 2) + "\n");
}

function economyCandidates(state: GameState): Candidate[] {
  if ((state.inventory?.length ?? 0) >= 28) return [];
  const result: Candidate[] = [];
  for (const loc of state.nearbyLocs ?? []) {
    const name = text(loc.name);
    // Do not continually interrupt gathering or attempt locked skill tiers.
    if (harvestLevel(name) > level(state, 'woodcutting')) continue;
    if (!(state.inventory ?? []).concat(state.equipment ?? []).some(i => /axe/i.test(text(i.name)) && !/pickaxe/i.test(text(i.name)))) continue;
    const options = Array.isArray(loc.optionsWithIndex) ? loc.optionsWithIndex as Json[] : [];
    const action = options.find((option) => /chop|mine|fish|thieve|steal/i.test(text(option.text)));
    if (loc.reachable === true && action && typeof loc.x === "number" && typeof loc.z === "number" && typeof loc.id === "number" && typeof action.opIndex === "number") {
      result.push({ id: "economy-" + name + "-" + loc.id + "-" + loc.x + "-" + loc.z, type: "interactLoc", fields: { x: loc.x, z: loc.z, locId: loc.id, optionIndex: action.opIndex }, waitTicks: 5 });
    }
  }
  return result.sort((a, b) => Number((state.nearbyLocs ?? []).find(l => l.id === a.fields?.locId && l.x === a.fields?.x)?.distance ?? 99) - Number((state.nearbyLocs ?? []).find(l => l.id === b.fields?.locId && l.x === b.fields?.x)?.distance ?? 99));
}

const arrowRank = (name: string): number => {
  if (/rune arrow/i.test(name)) return 6;
  if (/adamant arrow/i.test(name)) return 5;
  if (/mithril arrow/i.test(name)) return 4;
  if (/steel arrow/i.test(name)) return 3;
  if (/iron arrow/i.test(name)) return 2;
  if (/bronze arrow/i.test(name)) return 1;
  return 0;
};

function permittedArrowRank(ranged: number): number {
  if (ranged >= 40) return 6;
  if (ranged >= 30) return 5;
  if (ranged >= 20) return 4;
  if (ranged >= 5) return 3;
  return 2;
}

function economyNeedsFood(state: GameState): boolean {
  if (role !== 'economy') return true;
  if (state.player?.combat?.inCombat === true) return true;
  return (state.nearbyNpcs ?? []).some((npc) => {
    const attack = (npc.optionsWithIndex as Json[] | undefined)?.some((option) => /attack/i.test(text(option.text)));
    return npc.reachable === true && attack && Number(npc.distance ?? 99) <= 6 && Number(npc.combatLevel ?? 0) >= 20;
  });
}

function safeAmmoSupplyCandidates(state: GameState): Candidate[] {
  if (build !== "ranged-magic") return [];
  const inventory = state.inventory ?? [];
  const hasAxe = inventory.concat(state.equipment ?? []).some(i => /axe/i.test(String(i.name)) && !/pickaxe/i.test(String(i.name)));
  if (!hasAxe) {
    const nearTown = Math.hypot(Number(state.player?.worldX) - WORLD_ROUTES.lumbridge.x, Number(state.player?.worldZ) - WORLD_ROUTES.lumbridge.z) < 10;
    return nearTown ? [{ id: 'look-for-income-opportunity', type: 'wait', waitTicks: 5 }]
      : [{ id: 'travel-for-income-opportunity', type: 'walkTo', fields: { ...WORLD_ROUTES.lumbridge, reason: 'find income opportunities; cannot chop without an axe' }, waitTicks: 2 }];
  }
  const shop = state.shop ?? {};
  // If a shop is already open, turn safe gathered/fletched materials into the
  // next arrow fund. Never sell tools, equipped gear, food, or arrows.
  if (shop.isOpen === true) {
    const sale = inventory.find((item) => /logs?|shortbow|longbow|arrow shafts/i.test(text(item.name)) && typeof item.slot === "number");
    if (sale) return [{ id: "sell-safe-ammo-material-" + sale.slot, type: "shopSell", fields: { slot: sale.slot, amount: 10, reason: "safe ammunition fund" }, waitTicks: 2 }];
  }
  // Leave room for the resulting shafts/arrows. A 27-slot bag with logs is a
  // banking event, not a production event; otherwise the agent opens the
  // Make-X dialog with no capacity and can repeat it indefinitely.
  const hasLog = inventory.some((item) => /logs?/i.test(text(item.name)));
  if (inventory.length >= 27 && hasLog) return [];
  // Fletching is attempted only when the live inventory exposes its option;
  // this lets Stinger discover the server's exact recipe/interface instead of
  // assuming it can create finished arrows from logs alone.
  const knifeProcessingBlocked = Object.entries(work.failures)
    .some(([id, failure]) => /^knife-on-ammo-log-/.test(id) && failure.count >= 2 && failure.until > Date.now());
  if (knifeProcessingBlocked) {
    // Do not rotate through every log slot after the same recipe has been
    // rejected. Use the observed arrow shop as a bounded alternative; it can
    // buy a partial batch with whatever cash is currently carried.
    const distanceToLowe = Math.hypot(Number(state.player?.worldX) - WORLD_ROUTES.lowesArchery.x, Number(state.player?.worldZ) - WORLD_ROUTES.lowesArchery.z);
    return distanceToLowe > 1
      ? [{ id: 'ammo-replan-to-arrow-shop', type: 'walkTo', fields: { ...WORLD_ROUTES.lowesArchery, running: true, reason: 'knife-on-log recipe rejected twice; test direct arrow purchase instead' }, waitTicks: 5 }]
      : [{ id: 'ammo-replan-scan-arrow-shop', type: 'scanNearbyLocs', fields: { radius: 30, reason: 'refresh the direct arrow-shop alternative after a rejected recipe' }, waitTicks: 2 }];
  }
  const log = inventory.find((item) => /logs?/i.test(text(item.name)) && typeof item.slot === "number");
  const fletch = (log?.optionsWithIndex as Json[] | undefined)?.find((option) => /fletch/i.test(text(option.text)));
  if (log && typeof fletch?.opIndex === "number") {
    return [{ id: "fletch-ammo-material-" + log.slot, type: "useInventoryItem", fields: { slot: log.slot, optionIndex: fletch.opIndex, reason: "learn self-supplied ammunition inputs" }, waitTicks: 3 }];
  }
  const knife = inventory.find((item) => /^knife$/i.test(text(item.name)) && typeof item.slot === 'number');
  if (log && knife) {
    return [{ id: 'knife-on-ammo-log-' + log.slot, type: 'useItemOnItem', fields: { sourceSlot: knife.slot, targetSlot: log.slot, reason: 'make arrow-shaft inputs from observed logs' }, waitTicks: 3 }];
  }
  if (log) {
    const groundKnife = (state.groundItems ?? []).find((item) => /^knife$/i.test(text(item.name)) && item.reachable === true && typeof item.x === 'number' && typeof item.z === 'number' && typeof item.id === 'number');
    if (groundKnife) return [{ id: 'pickup-ammo-knife', type: 'pickupItem', fields: { x: groundKnife.x, z: groundKnife.z, itemId: groundKnife.id, reason: 'recover the tool required to turn logs into arrow inputs' }, waitTicks: 2 }];
    const distanceToKnife = Math.hypot(Number(state.player?.worldX) - WORLD_ROUTES.lumbridgeKnife.x, Number(state.player?.worldZ) - WORLD_ROUTES.lumbridgeKnife.z);
    if (distanceToKnife > 6) return [{ id: 'travel-for-ammo-knife', type: 'walkTo', fields: { ...WORLD_ROUTES.lumbridgeKnife, reason: 'recover a verified knife before processing gathered ammunition materials' }, waitTicks: 2 }];
    return [{ id: 'scan-for-ammo-knife', type: 'scanNearbyLocs', fields: { radius: 12, reason: 'find the verified ground knife at the observed source' }, waitTicks: 2 }];
  }
  // The nearest tree-like object may be a stump or a hollow/dead tree without
  // a live Chop option. Search for a complete actionable observation instead
  // of letting that first decorative object mask the usable tree behind it.
  const tree = (state.nearbyLocs ?? []).find((loc) => {
    const options = (loc.optionsWithIndex as Json[] | undefined) ?? [];
    return loc.reachable === true && /tree/i.test(text(loc.name)) && typeof loc.x === "number" && typeof loc.z === "number" && typeof loc.id === "number" && options.some((option) => /chop/i.test(text(option.text)) && typeof option.opIndex === "number");
  });
  const chop = (tree?.optionsWithIndex as Json[] | undefined)?.find((option) => /chop/i.test(text(option.text)) && typeof option.opIndex === "number");
  if (tree && typeof chop?.opIndex === "number") {
    return [{ id: "gather-safe-ammo-material-" + tree.id + "-" + tree.x + "-" + tree.z, type: "interactLoc", fields: { x: tree.x, z: tree.z, locId: tree.id, optionIndex: chop.opIndex, reason: "safe ammunition supply" }, waitTicks: 5 }];
  }
  const distance = Math.hypot(Number(state.player?.worldX) - WORLD_ROUTES.lumbridgeTrees.x, Number(state.player?.worldZ) - WORLD_ROUTES.lumbridgeTrees.z);
  if (distance > 8) return [{ id: "travel-to-safe-ammo-trees", type: "walkTo", fields: { ...WORLD_ROUTES.lumbridgeTrees, reason: "reach an observed safe tree approach before gathering arrow materials" }, waitTicks: 2 }];
  return [{ id: "scan-safe-ammo-supply", type: "scanNearbyLocs", fields: { radius: 12, reason: "refresh the local tree observation at the verified approach" }, waitTicks: 2 }];
}

function arrowProductionCandidates(state: GameState): Candidate[] {
  if (build !== 'ranged-magic') return [];
  // A bank transaction owns the character until it is complete. Previously
  // this planner ran while the bank was open, selected the knife/log recipe,
  // and then sent Stinger straight back to the trees without depositing his
  // large arrow-shaft stack.
  if (state.bank?.isOpen === true || state.shop?.isOpen === true) return [];
  const inventory = state.inventory ?? [];
  const headless = inventory.find(item => /headless arrow/i.test(text(item.name)) && typeof item.slot === 'number');
  const tips = inventory.find(item => /arrowtips?|arrowheads?/i.test(text(item.name)) && typeof item.slot === 'number');
  if (headless && tips && headless.slot !== tips.slot) {
    return [{ id: `finish-arrows-${headless.slot}-${tips.slot}`, type: 'useItemOnItem', fields: {
      sourceSlot: headless.slot, targetSlot: tips.slot,
      reason: 'turn observed headless arrows and arrowheads into complete ammunition',
    }, waitTicks: 3 }];
  }
  const shafts = inventory.find(item => /arrow shaft/i.test(text(item.name)) && typeof item.slot === 'number');
  const feathers = inventory.find(item => /^feather$/i.test(text(item.name)) && typeof item.slot === 'number');
  if (shafts && feathers && shafts.slot !== feathers.slot) {
    return [{ id: `make-headless-arrows-${feathers.slot}-${shafts.slot}`, type: 'useItemOnItem', fields: {
      sourceSlot: feathers.slot, targetSlot: shafts.slot,
      reason: 'attach observed feathers to arrow shafts before adding arrowheads',
    }, waitTicks: 3 }];
  }
  return [];
}

function lobsterProgressionCandidates(state: GameState): Candidate[] {
  // Owner's current priority is a Black Knight trial using existing bank food.
  if(character==='clawscout')return [];
  if (character !== 'clawscout' || role === 'economy' || build === 'ranged-magic' || level(state, 'fishing') < 40) return [];
  const inv = state.inventory ?? [];
  const prep=lobsterPreparation(state,work.fishing??={},work.bankItems??[],()=>bankAt(state).map(a=>({...a,id:'lobster-'+a.id})));
  saveWork();
  if(prep.status!=='ready')return prep.actions;
  // An upgrade is not an endless fishing mandate. With food in reserve,
  // return ownership to gear acquisition and combat progression.
  const storedFood=(work.bankItems??[]).filter(i=>/^(shrimps|anchovies|trout|salmon|lobster|swordfish)$/i.test(String(i.name))).reduce((n,i)=>n+Number(i.count),0);
  if(learnedFoodCount(inv)>=learnedFoodReserve(work.learning?.food)&&storedFood>=foodBankReserve(work.learning?.food))return [];
  if(inv.length>=28||inv.some(i=>/^raw lobster$/i.test(String(i.name))))return [];

  const spot = (state.nearbyNpcs ?? []).find(npc => /fishing\s*spot/i.test(text(npc.name)) && npc.reachable === true && (npc.optionsWithIndex as Json[] | undefined)?.some(option => /^cage$/i.test(text(option.text))));
  const cage = (spot?.optionsWithIndex as Json[] | undefined)?.find(option => /^cage$/i.test(text(option.text)));
  if (spot && typeof spot.index === 'number' && typeof cage?.opIndex === 'number') return [{ id: `lobster-fish-${spot.index}`, type: 'interactNpc', fields: { npcIndex: spot.index, optionIndex: cage.opIndex, reason: 'fish lobsters at the observed Karamja cage spot' }, waitTicks: 5 }];

  const sailor = (state.nearbyNpcs ?? []).find(npc => /seaman|captain tobias/i.test(text(npc.name)) && npc.reachable === true);
  const talk = (sailor?.optionsWithIndex as Json[] | undefined)?.find(option => /talk/i.test(text(option.text)));
  if (sailor && typeof sailor.index === 'number' && typeof talk?.opIndex === 'number') return [{ id: 'sail-to-karamja-lobster-fishing', type: 'interactNpc', fields: { npcIndex: sailor.index, optionIndex: talk.opIndex, reason: 'take the verified Port Sarim route to Karamja' }, waitTicks: 4 }];

  const player = state.player ?? {};
  const distanceToSailor = Math.hypot(Number(player.worldX) - WORLD_ROUTES.portSarimSailor.x, Number(player.worldZ) - WORLD_ROUTES.portSarimSailor.z);
  if (distanceToSailor > 8) return [{ id: 'travel-to-karamja-sailor', type: 'walkTo', fields: { ...WORLD_ROUTES.portSarimSailor, running: true, reason: 'reach the verified Port Sarim sailor before crossing to Karamja' }, waitTicks: 4 }];
  const distanceToSpot = Math.hypot(Number(player.worldX) - WORLD_ROUTES.karamjaLobsterFishing.x, Number(player.worldZ) - WORLD_ROUTES.karamjaLobsterFishing.z);
  if (distanceToSpot > 8) return [{ id: 'travel-to-karamja-lobster-spot', type: 'walkTo', fields: { ...WORLD_ROUTES.karamjaLobsterFishing, running: true, reason: 'survey the guide-listed Karamja cage spot' }, waitTicks: 4 }];
  return [{ id: 'scan-for-lobster-spot', type: 'scanNearbyLocs', fields: { radius: 24, reason: 'find the live cage fishing spot after arriving in Karamja' }, waitTicks: 3 }];
}

function cautiousPickpocketCandidates(state: GameState): Candidate[] {
  if (build !== "ranged-magic") return [];
  const player = state.player ?? {};
  const hp = typeof player.hp === "number" ? player.hp : 0;
  const maxHp = typeof player.maxHp === "number" ? player.maxHp : 1;
  const food = (state.inventory ?? []).some((item) => (item.optionsWithIndex as Json[] | undefined)?.some((option) => text(option.text) === "eat"));
  // Pickpocketing is allowed as an observed money source, but never as a
  // gamble at low health or without an immediate recovery option.
  if (!food || hp * 100 / Math.max(1, maxHp) < 70) return [];
  const mark = (state.nearbyNpcs ?? []).find((npc) => npc.reachable === true && typeof npc.index === "number" && (npc.optionsWithIndex as Json[] | undefined)?.some((option) => /pickpocket/i.test(text(option.text))));
  const option = (mark?.optionsWithIndex as Json[] | undefined)?.find((item) => /pickpocket/i.test(text(item.text)));
  if (mark && typeof option?.opIndex === "number") return [{ id: "cautious-pickpocket-" + mark.index, type: "interactNpc", fields: { npcIndex: mark.index, optionIndex: option.opIndex, reason: "earn arrow funds only while health is protected" }, waitTicks: 4 }];
  return [];
}

function ammoCandidates(state: GameState): Candidate[] {
  if (build !== "ranged-magic") return [];
  const inventory = state.inventory ?? [];
  const maxArrowRank = Math.min(permittedArrowRank(level(state, 'ranged')), bowArrowCap(String(state.combatStyle?.weaponName ?? '')));
  const arrows = [...inventory, ...(state.equipment ?? [])]
    .filter((item) => arrowRank(String(item.name)) > 0 && arrowRank(String(item.name)) <= maxArrowRank)
    .reduce((total, item) => total + (typeof item.count === "number" ? item.count : 1), 0);
  // Aim to restock to 50. Do not abandon a safe beginner fight until the
  // quiver is genuinely low; then ammunition takes priority over combat.
  if (arrows >= 15) return [];
  const ranged = level(state, "ranged");
  const coins = (state.inventory ?? []).filter((item) => /coins/i.test(text(item.name)))
    .reduce((total, item) => total + (typeof item.count === "number" ? item.count : 1), 0);
  // Lowe's live world stock prices bronze arrows at 10 coins each. A minimum
  // reserve of 15 is enough to resume ranged training; do not force a risky
  // money-making loop merely to afford the ideal batch of 50.
  const minimumPurchaseBudget = Math.max(0, (15 - arrows) * 10);
  const shop = state.shop ?? {};
  const stock = Array.isArray(shop.shopItems) ? shop.shopItems as Json[] : [];
  const player = state.player ?? {};
  const distanceToLowe = Math.hypot((Number(player.worldX) || 0) - WORLD_ROUTES.lowesArchery.x, (Number(player.worldZ) || 0) - WORLD_ROUTES.lowesArchery.z);
  if (shop.isOpen === true) {
    const choice = stock
      .filter((item) => arrowRank(String(item.name)) > 0 && arrowRank(String(item.name)) <= maxArrowRank && typeof item.slot === "number" && Number(item.count) > 0)
      .filter((item) => typeof item.buyPrice !== "number" || Number(item.buyPrice) <= coins)
      .sort((a, b) => arrowRank(String(b.name)) - arrowRank(String(a.name)))[0];
    const unitPrice = typeof choice?.buyPrice === "number" ? Math.max(1, choice.buyPrice) : 1;
    const affordable = Math.min(50 - arrows, Math.floor(coins / unitPrice));
    if (choice && affordable > 0 && typeof choice.slot === "number") return [{ id: "buy-arrows-" + choice.slot, type: "shopBuy", fields: { slot: choice.slot, amount: affordable, reason: "maintain ranged ammunition reserve" }, waitTicks: 2 }];
    return [];
  }
  if (coins < minimumPurchaseBudget && distanceToLowe > 1) {
    const hp = typeof player.hp === "number" ? player.hp : 0;
    const maxHp = typeof player.maxHp === "number" ? player.maxHp : 1;
    // Give banking priority when carrying money at dangerous health.
    if (coins > 0 && hp * 100 / Math.max(1, maxHp) <= 55) return [];
    const safeSupply = safeAmmoSupplyCandidates(state);
    const pickpocket = cautiousPickpocketCandidates(state);
    // A full bag cannot safely absorb a new tool or a recovery item.  In that
    // state, and after a short funding experiment, use the reproducible
    // gathering/fletching route rather than risking an endless thief loop.
    if (mayPickpocketForAmmo(inventory.length, work.pickpocketStreak ?? 0) && pickpocket.length > 0) return pickpocket;
    return safeSupply;
  }
  const door = loweDoor(state);
  if (door.length && actionReady(work.failures['open-lowes-door'])) return door;
  const lowe = (state.nearbyNpcs ?? []).find((npc) => npc.reachable === true && /lowe/i.test(text(npc.name)) && typeof npc.index === "number");
  const trade=(lowe?.optionsWithIndex as Json[]|undefined)?.find(o=>/^trade$/i.test(String(o.text)));
  if (lowe && typeof trade?.opIndex==='number') return [{ id: "trade-with-lowe-" + lowe.index, type: "interactNpc", fields: { npcIndex: lowe.index, optionIndex:trade.opIndex, reason: "buy ranged ammunition" }, waitTicks: 3 }];
  if (distanceToLowe > 1) return [{ id: "walk-to-lowes-archery", type: "walkTo", fields: { ...WORLD_ROUTES.lowesArchery, running: true, reason: "reach the shop entrance before looking for a reachable merchant" }, waitTicks: 5 }];
  return [{ id: "scan-for-lowes-archery", type: "scanNearbyLocs", fields: { radius: 30, reason: "locate Lowe's Archery Emporium" }, waitTicks: 2 }];
}

function coinsIn(inventory: Json[]): number {
  return inventory.filter((item) => /coins/i.test(text(item.name)))
    .reduce((total, item) => total + (typeof item.count === "number" ? item.count : 1), 0);
}

function workingCashReserve(state: GameState): number {
  const player = state.player ?? {};
  const hp = typeof player.hp === "number" ? player.hp : 0;
  const maxHp = typeof player.maxHp === "number" ? player.maxHp : 1;
  // When an agent cannot safely recover, bank every coin immediately. Its
  // next trip can withdraw/buy again; a death cannot reclaim carried money.
  if (hp * 100 / Math.max(1, maxHp) <= 55) return 50;
  if (role === "economy") return 0;
  // Stinger keeps enough for a 50-arrow bronze refill. Other fighters retain
  // a small amount for basic supplies, but bank the rest against death/loss.
  return build === "ranged-magic" ? 500 : 250;
}

function bankingCandidates(state: GameState): Candidate[] {
  const inventory = state.inventory ?? [];
  const equippedNames = (state.equipment ?? []).map(item => text(item.name));
  const carriedWeapons = inventory.filter(item => /^(bronze|iron|steel|mithril|adamant|rune) (sword|scimitar|longsword|battleaxe|mace|dagger|warhammer)$/i.test(text(item.name)));
  const weaponRank = (name: string) => ({bronze:1, iron:2, steel:3, mithril:4, adamant:5, rune:6}[String(name).toLowerCase().split(' ')[0]] ?? 0);
  const keepWeaponName = carriedWeapons.sort((a,b) => weaponRank(text(b.name)) - weaponRank(text(a.name)))[0]?.name;
  const carriedArrows = inventory.filter(item => isFinishedArrow(text(item.name))).reduce((sum, item) => sum + Number(item.count ?? 1), 0);
  const equippedArrows = (state.equipment ?? []).filter(item => isFinishedArrow(text(item.name))).reduce((sum, item) => sum + Number(item.count ?? 1), 0);
  const surplusArrows = surplusArrowAmount(carriedArrows + equippedArrows);
  const foodMemory = work.learning?.food;
  const tripFood = agency?.policy.foodTarget ?? (character==='clawscout'?Math.max(3,learnedFoodReserve(foodMemory)):learnedFoodReserve(foodMemory));
  const foodTotal = learnedFoodCount(inventory);
  const surplusFood = Math.max(0, foodTotal - tripFood);
  // Raw fish is an input and can always be stored. Cooked food is stored only
  // above the learned trip reserve, so a bank visit never causes a withdraw /
  // redeposit oscillation.
  const bankableItems = inventory.filter((item) => {
    const edible = isFood(item);
    const itemName = text(item.name);
    if (isAgentClutter(item, build, equippedNames, keepWeaponName)) return true;
    if (isFinishedArrow(itemName)) return surplusArrows > 0;
    return edible ? surplusFood > 0 : isBankableResource(String(item.name));
  });
  const coins = coinsIn(inventory);
  const surplusCoins = Math.max(0, coins - workingCashReserve(state));
  const inventoryFull = inventory.length >= 28;
  const urgentClutter = inventory.some(item => isUrgentClutter(item, build, equippedNames,inventory.length));
  // A large shaft stack is useful, but it must not crowd out feathers,
  // arrowheads, food or exploration supplies while Stinger searches for the
  // remaining recipe inputs.
  const excessArrowInputs = inventory.some(item => /arrow shaft/i.test(text(item.name)) && Number(item.count ?? 0) >= 100);
  const recoveryCash = role !== 'economy' && !inventory.some(isFood) && !inventory.some(i => /small fishing net/i.test(String(i.name))) && coins < 5;
  // A full inventory is banked only when it actually holds materials. This
  // avoids pointless banking trips with nothing but essential equipment.
  const bank = state.bank ?? {};
  if (bank.isOpen === true) {
    work.bankItems = Array.isArray(bank.items) ? bank.items as Json[] : []; saveWork();
    if(character==='stinger' && !inventory.some(i=>/small fishing net/i.test(String(i.name))) && coinsIn(inventory)<5) {
      const cash=work.bankItems.find(i=>/^coins$/i.test(String(i.name))&&Number(i.count)>0);
      if(cash)return [{id:'withdraw-net-budget',type:'bankWithdraw',fields:{slot:cash.slot,amount:Math.min(50,Number(cash.count))},waitTicks:2}];
    }
    if(work.fishing?.bankVisit&&character==='clawscout'){
      const preparation=lobsterPreparation(state,work.fishing,work.bankItems,()=>[]);
      saveWork();return preparation.actions;
    }
    if (work.foodWithdrawalPending === 'raw' && inventory.some((item) => /^raw /i.test(String(item.name)))) {
      work.foodBatch = {phase: 'cook', startedAt: Date.now()}; saveWork();
      return [{ id: 'close-bank-to-cook-withdrawn-fish', type: 'closeModal', fields: { reason: 'cook the raw fish batch withdrawn from the bank' }, waitTicks: 1 }];
    }
    if (shouldCloseAfterFoodWithdrawal(work.foodWithdrawalPending === true, inventory.some(isFood))) {
      return [{ id: 'close-bank-with-food-trip', type: 'closeModal', fields: { reason: 'keep deliberately withdrawn food for the next trip' }, waitTicks: 1 }];
    }
    // Finish the transaction even after the first deposit frees inventory slots.
    const resource = bankableItems.find((item) => typeof item.slot === 'number');
    if (resource) {
      const resourceName = text(resource.name);
      const amount = isFood(resource)
        ? Math.min(surplusFood, Number(resource.count ?? 1))
        : isFinishedArrow(resourceName)
          ? Math.min(surplusArrows, Number(resource.count ?? 1))
          : -1;
      if (amount > 0 || amount === -1) return [{ id: "bank-deposit-" + resource.slot, type: "bankDeposit", fields: { slot: resource.slot, amount, reason: isFood(resource) ? "store cooked-food surplus while retaining the learned trip reserve" : "store gathered materials for batch processing" }, waitTicks: 2 }];
    }
    const coinStack = inventory.find((item) => /coins/i.test(text(item.name)) && typeof item.slot === "number");
    if (coinStack && surplusCoins > 0) return [{ id: "bank-surplus-coins-" + coinStack.slot, type: "bankDeposit", fields: { slot: coinStack.slot, amount: surplusCoins, reason: "protect surplus coins while retaining operating funds" }, waitTicks: 2 }];
    const food = work.bankItems.find(i => /^(shrimps|anchovies|trout|salmon|bread|lobster|swordfish|cooked fish)$/i.test(String(i.name)) && !/^raw /i.test(String(i.name)));
    if (foodTotal < tripFood && food && inventory.length < 28) {
      work.foodWithdrawalPending = true; saveWork();
      return [{ id: 'withdraw-learned-food-reserve', type: 'bankWithdraw', fields: { slot: food.slot, amount: Math.min(tripFood - foodTotal, 28 - inventory.length, Number(food.count)) }, waitTicks: 2 }];
    }
    const rawFood = work.bankItems.find(i => /^raw (shrimps|anchovies|trout|salmon|sardines|herring|tuna|lobster|swordfish)$/i.test(String(i.name)));
    if (foodTotal < tripFood && rawFood && inventory.length < 28) {
      work.foodWithdrawalPending = 'raw'; saveWork();
      return [{ id: 'withdraw-raw-fish-for-cooking', type: 'bankWithdraw', fields: { slot: rawFood.slot, amount: Math.min(24, 28 - inventory.length, Number(rawFood.count)) }, waitTicks: 2 }];
    }
    const net = work.bankItems.find(i => /small fishing net/i.test(String(i.name)));
    if (role !== 'economy' && !inventory.some(isFood) && !inventory.some(i => /small fishing net/i.test(String(i.name))) && net) return [{ id: 'withdraw-food-tool', type: 'bankWithdraw', fields: { slot: net.slot, amount: 1 }, waitTicks: 2 }];
    const bankCoins = work.bankItems.find(i => /^coins$/i.test(String(i.name)));
    if (role !== 'economy' && !inventory.some(isFood) && coins < 5 && bankCoins) return [{ id: 'withdraw-recovery-cash', type: 'bankWithdraw', fields: { slot: bankCoins.slot, amount: Math.min(50, Number(bankCoins.count)) }, waitTicks: 2 }];
    if (work.foodBatch?.phase === 'bank') { delete work.foodBatch; saveWork(); }
    return [{ id: "close-bank-after-deposit", type: "closeModal", fields: { reason: "resume work after banking" }, waitTicks: 1 }];
  }
  // One free slot is not enough for a safe ranged resupply or a dropped tool.
  // Bank a near-full bag of materials before processing it, while still
  // retaining a deliberate food trip until the bag is genuinely full.
  const nearFullMaterials = inventory.length >= 27 && bankableItems.length > 0;
  if ((!inventoryFull || bankableItems.length === 0) && !nearFullMaterials && !urgentClutter && !excessArrowInputs && surplusFood === 0 && surplusCoins === 0 && !recoveryCash) return [];
  const banker = (state.nearbyNpcs ?? []).find((npc) => npc.reachable === true && /banker/i.test(text(npc.name)) && typeof npc.index === "number");
  if (banker) {
    const option = (banker.optionsWithIndex as Json[] | undefined)?.find((item) => /bank|use/i.test(text(item.text)));
    if (typeof option?.opIndex === "number") return [{ id: "open-bank-npc-" + banker.index, type: "interactNpc", fields: { npcIndex: banker.index, optionIndex: option.opIndex, reason: "bank gathered materials" }, waitTicks: 3 }];
  }
  const booth = (state.nearbyLocs ?? []).find((loc) => loc.reachable === true && /bank booth|bank chest|bank table/i.test(text(loc.name)) && typeof loc.x === "number" && typeof loc.z === "number" && typeof loc.id === "number");
  if (booth) {
    const option = bankOption((booth.optionsWithIndex as Json[] | undefined) ?? []);
    const player = state.player ?? {};
    const adjacent = Math.max(Math.abs(Number(player.worldX) - Number(booth.x)), Math.abs(Number(player.worldZ) - Number(booth.z))) <= 1;
    if (typeof option?.opIndex === "number" && adjacent) return [{ id: "open-bank-loc-" + booth.id + "-" + booth.x + "-" + booth.z, type: "interactLoc", fields: { x: booth.x, z: booth.z, locId: booth.id, optionIndex: option.opIndex, reason: "bank gathered materials" }, waitTicks: 3 }];
    if (!adjacent) return [{ id: "walk-to-bank-booth-" + booth.x + "-" + booth.z, type: "walkTo", fields: { x: Number(booth.x) - 1, z: booth.z, level: Number(booth.level ?? 0), running: true, reason: "move adjacent to the observed bank booth before interacting" }, waitTicks: 3 }];
  }
  // A nearby bank can be inside a building. If the service NPC is visible but
  // unreachable, open only an observed adjacent door before attempting a
  // distant-bank route; this is a real local discovery action, not a guessed
  // arrival through the wall.
  const bankVisible = (state.nearbyNpcs ?? []).some((npc) => /banker/i.test(text(npc.name)));
  const entryDoor = bankVisible ? (state.nearbyLocs ?? []).find((loc) => {
    const open = (loc.optionsWithIndex as Json[] | undefined)?.find((option) => /^open$/i.test(text(option.text)));
    return loc.reachable === true && /door|gate/i.test(text(loc.name)) && typeof loc.x === 'number' && typeof loc.z === 'number' && typeof loc.id === 'number' && typeof open?.opIndex === 'number';
  }) : undefined;
  if (entryDoor) {
    const open = (entryDoor.optionsWithIndex as Json[]).find((option) => /^open$/i.test(text(option.text)))!;
    return [{ id: `open-bank-entry-${entryDoor.id}-${entryDoor.x}-${entryDoor.z}`, type: 'interactLoc', fields: { x: entryDoor.x, z: entryDoor.z, locId: entryDoor.id, optionIndex: open.opIndex, reason: 'reach a visible local bank service' }, waitTicks: 2 }];
  }
  const player = state.player ?? {};
  const distance = Math.hypot((Number(player.worldX) || 0) - WORLD_ROUTES.varrockWestBank.x, (Number(player.worldZ) || 0) - WORLD_ROUTES.varrockWestBank.z);
  if (distance > 8) return [{ id: "walk-to-varrock-west-bank", type: "walkTo", fields: { ...WORLD_ROUTES.varrockWestBank, running: true, reason: "bank materials or surplus coins" }, waitTicks: 5 }];
  return [{ id: "scan-for-bank", type: "scanNearbyLocs", fields: { radius: 40, reason: "find bank before depositing" }, waitTicks: 2 }];
}

function localEconomyDiscovery(state: GameState): Candidate[] {
  if ((state.inventory?.length ?? 0) >= 28) return [];
  const tree = (state.nearbyLocs ?? [])
    .filter((loc) => loc.reachable === true && /^(tree|oak|willow|maple|yew|magic)$/i.test(String(loc.name)) && level(state, 'woodcutting') >= harvestLevel(String(loc.name)))
    .filter((loc) => {
      const id = `autonomy-harvest-${loc.id}-${loc.x}-${loc.z}`;
      return (work.failures[id]?.until ?? 0) <= Date.now();
    })
    .map((loc) => ({ loc, chop: (loc.optionsWithIndex as Json[] | undefined)?.find((option) => /^chop/i.test(text(option.text))) }))
    .filter((entry): entry is { loc: Json; chop: Json } => Boolean(entry.chop) && typeof entry.loc.x === 'number' && typeof entry.loc.z === 'number' && typeof entry.loc.id === 'number' && typeof entry.chop.opIndex === 'number')
    .sort((a, b) => Number(a.loc.distance ?? 999) - Number(b.loc.distance ?? 999))[0];
  if (!tree) return [];
  return [{
    id: `autonomy-harvest-${tree.loc.id}-${tree.loc.x}-${tree.loc.z}`,
    type: 'interactLoc',
    fields: { x: tree.loc.x, z: tree.loc.z, locId: tree.loc.id, optionIndex: tree.chop.opIndex, reason: 'Fresh reachable resource evidence; measure a local production alternative' },
    waitTicks: 5,
  }];
}

function stateKey(state: GameState): string {
  const player = state.player ?? {};
  const inv = state.inventory ?? [];
  const npcs = state.nearbyNpcs ?? [];
  const locs = state.nearbyLocs ?? [];
  const dialog = state.dialog ?? {};
  const phase = state.inGame === false
    ? "login"
    : player === null
      ? "no-player"
      : (player.isDead === true ? "dead" : "alive");
  const names = [...npcs, ...locs]
    .map((item) => text(item.name))
    .filter((name) => name.includes("tree") || name.includes("guide"))
    .sort()
    .join(",");
  const enemyTypes = npcs.map((item) => text(item.name)).filter(Boolean).sort().join(",");
  const hasAxe = inv.some((item) => text(item.name).includes("axe"));
  const dialogOpen = dialog.isOpen === true ? "dialog" : "quiet";
  const hp = typeof player.hp === "number" ? player.hp : 0;
  const maxHp = typeof player.maxHp === "number" ? player.maxHp : 1;
  const hpBand = hp * 100 / Math.max(1, maxHp) <= 40 ? "low-hp" : "safe-hp";
  const combat = player.combat as Json | undefined;
  const fighting = combat?.inCombat === true ? "fighting" : "free";
  const safeTargets = npcs.filter((npc) => {
    const options = Array.isArray(npc.optionsWithIndex) ? npc.optionsWithIndex : [];
    return npc.reachable === true && npc.inCombat !== true &&
      options.some((option) => text((option as Json).text).includes("attack"));
  }).length;
  const worldX = typeof player.worldX === "number" ? Math.floor(player.worldX / 10) : -1;
  const worldZ = typeof player.worldZ === "number" ? Math.floor(player.worldZ / 10) : -1;
  return [phase, dialogOpen, hpBand, fighting, `targets${safeTargets}`, inv.length >= 28 ? "full" : `inv${inv.length}`, hasAxe ? "axe" : "no-axe", names, `enemies:${enemyTypes}`, `${worldX},${worldZ}`].join("|");
}

function dialogCandidates(state: GameState): Candidate[] {
  const dialog = state.dialog ?? {};
  if (dialog.isOpen !== true) return [];
  const options = Array.isArray(dialog.options) ? dialog.options : [];
  if (dialog.isWaiting === true) return [{ id: 'wait-dialog-ready', type: 'wait', waitTicks: 2 }];
  // A ranged agent can open a Make X production dialog while experimenting
  // with self-supplied ammunition. Select the observed Arrow Shafts product
  // when present; repeatedly clicking the generic Make X button is a
  // zero-progress loop. Close only an unrecognizable production dialog.
  if (build === 'ranged-magic' && options.some((option) => /^make x$/i.test(text((option as Json).text)))) {
    const arrowShafts = options.find((option) => /arrow\s*shafts/i.test(text((option as Json).text)) && Number.isInteger((option as Json).index));
    if (arrowShafts) return [{
      id: `select-arrow-shafts-${(arrowShafts as Json).index}`,
      type: 'clickDialogOption',
      fields: { optionIndex: (arrowShafts as Json).index },
      waitTicks: 2,
    }];
    return [{ id: 'close-unselected-production-dialog', type: 'closeModal', waitTicks: 2 }];
  }
  const option = role === 'economy' && work.economy?.product
    ? productionDialog(options, work.economy.product) ?? dialogueOption(options)
    : dialogueOption(options);
  if (!option) return [{ id: 'close-unrecognized-dialog', type: 'closeModal', waitTicks: 2 }];
  return [{
    id: `dialog-${option.index}-${String(option.text).slice(0, 35)}`,
    type: "clickDialogOption",
    fields: { optionIndex: option.index },
    waitTicks: role === 'economy' && work.economy?.product ? 4 : 2,
  }];
}

async function goalCandidates(state: GameState): Promise<Candidate[]> {
  return training ? training.next(state, (from, to) => navigator!.assess(from, to))
    : await autonomousRecovery(state, 'training-unavailable');
}

function nearbyCombatRecovery(state: GameState): Candidate[] {
  // Economy characters only defend themselves through the normal combat
  // arbitration path. They must not turn a safe mining/gathering fallback
  // into unsolicited combat.
  if (role === 'economy') return [];
  const combatLevel = Number(state.player?.combatLevel ?? 1);
  const minimum = build === 'ranged-magic' ? 10 : Math.max(10, Math.floor(combatLevel * 0.35));
  const maximum = Math.max(minimum, Math.floor(combatLevel * 0.80));
  const targets = (state.nearbyNpcs ?? [])
    .filter(npc => npc.reachable === true && typeof npc.index === 'number')
    .filter(npc => Number(npc.combatLevel ?? 0) >= minimum && Number(npc.combatLevel ?? 0) <= maximum)
    .map(npc => ({ npc, attack: (npc.optionsWithIndex as Json[] | undefined)?.find(o => /^attack$/i.test(String(o.text))) }))
    .filter(row => typeof row.attack?.opIndex === 'number')
    .sort((a, b) => Number(b.npc.combatLevel ?? 0) - Number(a.npc.combatLevel ?? 0));
  const target = targets[0];
  if (!target) return [];
  return [{
    id: `autonomy-attack-${target.npc.index}`,
    type: 'interactNpc',
    fields: {
      npcIndex: target.npc.index,
      optionIndex: target.attack!.opIndex,
      reason: `use a fresh reachable level-${Number(target.npc.combatLevel)} combat trial instead of repeating navigation`
    },
    waitTicks: 5,
  }];
}

function featherResourceCandidates(state: GameState): Candidate[] {
  if (character !== 'featherer') return [];
  const inventory = state.inventory ?? [];
  const bank = work.bankItems ?? [];
  const goal = chooseResourceGoal(bank, inventory);
  work.resource ??= {};
  work.resource.goal = goal;

  if (state.bank?.isOpen === true && !shouldBankResource(goal, inventory)) {
    return [{ id: 'featherer-close-completed-bank', type: 'closeModal', fields: { reason: 'no further resource deposit is required' }, waitTicks: 1 }];
  }

  if (shouldBankResource(goal, inventory)) {
    work.resource.lastBankAt = Date.now();
    saveWork();
    return bankAt(state);
  }

  const desiredDrop = goal === 'feathers' ? /^feather$/i : goal === 'cow-hides' ? /^cowhide$/i : null;
  const drop = desiredDrop && (state.groundItems ?? [])
    .filter(item => item.reachable === true && Number(item.distance ?? 99) <= 8 && desiredDrop.test(String(item.name ?? ''))
      && typeof item.id === 'number' && typeof item.x === 'number' && typeof item.z === 'number')
    .sort((a, b) => Number(a.distance ?? 99) - Number(b.distance ?? 99))[0];
  if (drop) {
    return [{
      id: `resource-pickup-${goal}-${drop.id}-${drop.x}-${drop.z}`,
      type: 'pickupItem',
      fields: { x: drop.x, z: drop.z, itemId: drop.id, reason: `collect the ${goal === 'feathers' ? 'feather' : 'cowhide'} drop before starting another combat cycle` },
      waitTicks: 2,
    }];
  }

  if (goal === 'resource-survey') {
    const sites = [WORLD_ROUTES.eastCowResource, WORLD_ROUTES.varrockSouthEastMine, WORLD_ROUTES.lumbridgeTrees];
    const site = sites[(work.failures['resource-survey']?.count ?? 0) % sites.length]!;
    work.resource.site = 'resource-survey';
    saveWork();
    const player = state.player ?? {};
    if (Math.max(Math.abs(Number(player.worldX) - site.x), Math.abs(Number(player.worldZ) - site.z)) > 8) {
      return [{ id: 'resource-survey-route', type: 'walkTo', fields: { ...site, running: true, reason: 'survey a different resource area after completing the feather and hide reserves' }, waitTicks: 4 }];
    }
    return [{ id: 'resource-survey-scan', type: 'scanNearbyLocs', fields: { radius: 24, reason: 'look for a scarce or useful resource near the surveyed site' }, waitTicks: 3 }];
  }

  const isChicken = goal === 'feathers';
  if (isChicken) {
    // The chicken route has a real transition at the pen entrance. Prefer the
    // currently observed reachable gate/door over scanning from the outside;
    // the option index is copied from this fresh observation.
    const gate = (state.nearbyLocs ?? []).find(loc => {
      const open = (loc.optionsWithIndex as Json[] | undefined)?.find(option => /^open$/i.test(text(option.text)));
      return loc.reachable === true && /gate|door/i.test(text(loc.name)) && typeof loc.id === 'number' && typeof loc.x === 'number' && typeof loc.z === 'number' && typeof open?.opIndex === 'number';
    });
    const open = (gate?.optionsWithIndex as Json[] | undefined)?.find(option => /^open$/i.test(text(option.text)));
    if (gate && typeof open?.opIndex === 'number') {
      return [{ id: `open-chicken-gate-${gate.id}-${gate.x}-${gate.z}`, type: 'interactLoc', fields: { x: gate.x, z: gate.z, locId: gate.id, optionIndex: open.opIndex, reason: 'open the observed chicken-farm gate before selecting a reachable target' }, waitTicks: 2 }];
    }
  }
  const pattern = isChicken ? /^chicken$/i : /^cow$/i;
  const attackable = (state.nearbyNpcs ?? [])
    .filter(npc => pattern.test(String(npc.name)) && npc.reachable === true && npc.inCombat !== true && typeof npc.index === 'number')
    .map(npc => ({ npc, attack: (npc.optionsWithIndex as Json[] | undefined)?.find(option => /^attack$/i.test(text(option.text))) }))
    .filter(row => typeof row.attack?.opIndex === 'number')
    .sort((a, b) => Number(a.npc.distance ?? 99) - Number(b.npc.distance ?? 99));
  const target = attackable[0];
  const hp = Number(state.player?.hp ?? 0), maxHp = Math.max(1, Number(state.player?.maxHp ?? 1));
  const hasFood = foodCount(state) > 0;
  // Chickens are a deliberately low-risk resource loop; cows require an
  // actual food reserve before the first trial. Combat arbitration still
  // handles healing and retreat after the action begins.
  if (target && (hasFood || (isChicken && hp > maxHp * .85))) {
    work.resource.site = isChicken ? 'chickens' : 'cows';
    saveWork();
    return [{ id: `resource-attack-${isChicken ? 'chicken' : 'cow'}-${target.npc.index}`, type: 'interactNpc', fields: { npcIndex: target.npc.index, optionIndex: target.attack!.opIndex, reason: isChicken ? 'farm feathers from a fresh reachable chicken' : 'test cowhide supply after the feather reserve is healthy' }, waitTicks: 6 }];
  }

  const route = isChicken
    ? ((work.failures['resource-scan-fred-chickens']?.count ?? 0) >= 2 ? WORLD_ROUTES.fredChickenResource : WORLD_ROUTES.eastChickenResource)
    : ((work.failures['resource-scan-west-cows']?.count ?? 0) >= 2 ? WORLD_ROUTES.westCowResource : WORLD_ROUTES.eastCowResource);
  work.resource.site = isChicken ? 'chickens' : 'cows';
  saveWork();
  const player = state.player ?? {};
  if (Math.max(Math.abs(Number(player.worldX) - route.x), Math.abs(Number(player.worldZ) - route.z)) > 8) {
    return [{ id: `resource-route-${isChicken ? 'chickens' : 'cows'}`, type: 'walkTo', fields: { ...route, running: true, reason: isChicken ? 'reach a verified chicken enclosure for a steady feather batch' : 'reach a verified cattle field for a bounded cowhide trial' }, waitTicks: 4 }];
  }
  return [{ id: `resource-scan-${isChicken ? 'chickens' : 'cows'}`, type: 'scanNearbyLocs', fields: { radius: 24, reason: isChicken ? 'refresh the verified chicken enclosure before choosing a target' : 'refresh the verified cattle field before choosing a target' }, waitTicks: 3 }];
}

// This is used only after the normal goal planner has no executable action.
// Each waypoint is a known, collision-checked area that can reveal a new NPC,
// resource, shop, or route; it is never treated as proof that a target exists.
async function autonomousRecovery(state: GameState, blockedGoal: string): Promise<Candidate[]> {
  const here = position(state);
  const nearbyCombat = nearbyCombatRecovery(state);
  if (nearbyCombat.length && /no-candidates|no-executable|action-cycle|training-unavailable/i.test(blockedGoal)) return nearbyCombat;
  // CoinCrafter can end up at the bank after a failed metalworking route with
  // a valid tool kit already carried. A local scan has no new information in
  // that state; resume the verified mine route directly.
  if (role === 'economy' && /no-executable|economy-recovery|mine-route|action-cycle/i.test(blockedGoal)
    && here.level === WORLD_ROUTES.varrockSouthEastMine.level
    && Math.max(Math.abs(here.x - WORLD_ROUTES.varrockWestBank.x), Math.abs(here.z - WORLD_ROUTES.varrockWestBank.z)) <= 2) {
    return [{ id: 'autonomy-resume-mining-from-bank', type: 'walkTo', fields: { ...WORLD_ROUTES.varrockSouthEastMine, running: true, reason: 'resume metalworking from the bank after a blocked route' }, waitTicks: 3 }];
  }
  const routes = /full-inventory|bank-route/i.test(blockedGoal)
    ? [['bank', WORLD_ROUTES.varrockWestBank]] as const
    : role === 'economy'
    ? [['trees', WORLD_ROUTES.lumbridgeTrees], ['mine', WORLD_ROUTES.varrockSouthEastMine], ['bank', WORLD_ROUTES.varrockWestBank]] as const
    : build === 'ranged-magic'
      ? [['north-survey', WORLD_ROUTES.stingerNorthSurvey], ['barbarians', WORLD_ROUTES.barbarianVillage], ['edgeville', WORLD_ROUTES.edgeville], ['food', WORLD_ROUTES.draynorFishing], ['knife', WORLD_ROUTES.lumbridgeKnife], ['archery', WORLD_ROUTES.lowesArchery], ['runes', WORLD_ROUTES.wizardsTower]] as const
      : [['food', WORLD_ROUTES.draynorFishing], ['barbarians', WORLD_ROUTES.barbarianVillage], ['bank', WORLD_ROUTES.varrockWestBank]] as const;
  const from = here;
  let loadingMap = false;
  for (const [name, target] of routes) {
    if (from.level !== target.level || Math.max(Math.abs(from.x - target.x), Math.abs(from.z - target.z)) > 2) {
      const route = await navigator!.assess(from, target);
      if (route.status === 'loading-map') { loadingMap = true; continue; }
      if (route.status === 'ready') return [{
        id: `autonomy-explore-${name}`,
        type: 'walkTo',
        fields: { ...target, running: true, reason: `No executable ${blockedGoal}; survey a verified ${name} area for the next safe action` },
        waitTicks: 2,
      }];
    }
  }
  // A scan is useful once, but becomes another infinite loop when the map
  // contains no actionable rows. After repeated scan failures, force a
  // different known waypoint so the next observation has genuinely new
  // context. The direct dispatch is still verified by Navigator.step.
  const scanFailures = work.failures['autonomy-scan-current-area']?.count ?? 0;
  if (scanFailures >= 2 || /action-cycle/i.test(blockedGoal)) {
    const start = scanFailures % routes.length;
    for (let offset = 0; offset < routes.length; offset++) {
      const [name, target] = routes[(start + offset) % routes.length]!;
      if (from.level === target.level && Math.max(Math.abs(from.x - target.x), Math.abs(from.z - target.z)) <= 2) continue;
      return [{
        id: `autonomy-force-${name}`,
        type: 'walkTo',
        fields: { ...target, running: true, reason: `Repeated recovery scans; relocate to a different verified ${name} area` },
        waitTicks: 3,
      }];
    }
  }
  if (loadingMap) return [{ id: 'autonomy-map-loading', type: 'wait', waitTicks: 3 }];
  return [{ id: 'autonomy-scan-current-area', type: 'scanNearbyLocs', fields: { radius: 32, reason: `No executable ${blockedGoal}; refresh local world evidence` }, waitTicks: 2 }];
}

function gearCandidates(state: GameState, selectedSkill?: string): Candidate[] {
  const inventory = state.inventory ?? [];
  const equipment = state.equipment ?? [];
  const combatStyle = state.combatStyle;
  const weaponName = text(combatStyle?.weaponName);
  const hasShield = equipment.some((item) => text(item.name).includes("shield"));

  const weaponRank = (name: string): number => {
    const tier = ["bronze", "iron", "steel", "mithril", "adamant", "rune"]
      .findIndex((metal) => name.includes(metal));
    const type = name.includes("scimitar") ? 5 : name.includes("longsword") ? 4 :
      name.includes("sword") ? 3 : name.includes("mace") ? 2 : name.includes("dagger") ? 1 : 0;
    return Math.max(0, tier) * 10 + type;
  };

  if (build === "ranged-magic") {
    const bowQuality = (id: unknown) => gearCatalog.items.find(i => i.id === id && i.family === 'bow' && usable(i, state))?.quality ?? 0;
    const currentBowQuality = Math.max(0, ...equipment.map(i => bowQuality(i.id)));
    const bow = inventory.filter(i => bowQuality(i.id) > currentBowQuality).sort((a,b) => bowQuality(b.id)-bowQuality(a.id))[0];
    if (bow && weaponName !== text(bow.name)) {
      const wield = (bow.optionsWithIndex as Json[] | undefined)?.find((option) => /wield|equip/i.test(text(option.text)));
      if (typeof bow.slot === "number" && typeof wield?.opIndex === "number") return [{ id: "wield-ranged-" + bow.slot, type: "useInventoryItem", fields: { slot: bow.slot, optionIndex: wield.opIndex }, waitTicks: 2 }];
    }
    const compatible = (item: Json) => arrowRank(String(item.name)) > 0 && arrowRank(String(item.name)) <= bowArrowCap(weaponName);
    const arrowsEquipped = equipment.some(compatible);
    const arrows = inventory.find(compatible);
    if (!arrowsEquipped && arrows) {
      const wield = (arrows.optionsWithIndex as Json[] | undefined)?.find((option) => /wield|equip/i.test(text(option.text)));
      if (typeof arrows.slot === "number" && typeof wield?.opIndex === "number") return [{ id: "wield-ammo-" + arrows.slot, type: "useInventoryItem", fields: { slot: arrows.slot, optionIndex: wield.opIndex }, waitTicks: 2 }];
    }
  }

  // Early main-account plan: equip the strongest available one-handed weapon,
  // then a shield. Future gear upgrades use the same rule at level milestones.
  const weapon = build === "ranged-magic" ? undefined : inventory
      .filter((item) => !text(item.name).includes("axe") && !text(item.name).includes("pickaxe") &&
        !text(item.name).includes("shield") &&
        (text(item.name).includes("sword") || text(item.name).includes("scimitar") || text(item.name).includes("mace") || text(item.name).includes("dagger")))
      .sort((a, b) => weaponRank(text(b.name)) - weaponRank(text(a.name)))[0];
  const groundUpgrade = (state as GameState & { groundItems?: Array<Json> }).groundItems
    ?.filter((item) => item.reachable === true && /sword|scimitar|mace|dagger|shield/i.test(text(item.name)))
    .sort((a, b) => weaponRank(text(b.name)) - weaponRank(text(a.name)))[0];
  if (groundUpgrade && typeof groundUpgrade.x === "number" && typeof groundUpgrade.z === "number" && typeof groundUpgrade.id === "number" && weaponRank(text(groundUpgrade.name)) > weaponRank(weaponName)) {
    return [{ id: `pickup-upgrade-${groundUpgrade.id}-${groundUpgrade.x}-${groundUpgrade.z}`, type: "pickupItem", fields: { x: groundUpgrade.x, z: groundUpgrade.z, itemId: groundUpgrade.id, reason: "equipment upgrade" }, waitTicks: 3 }];
  }
  if (weaponName === "unarmed" || (weapon !== undefined && weaponRank(text(weapon.name)) > weaponRank(weaponName))) {
    const wield = (weapon?.optionsWithIndex as Json[] | undefined)?.find((option) => text(option.text).includes("wield"));
    if (weapon && typeof weapon.slot === "number" && typeof wield?.opIndex === "number") {
      return [{ id: `wield-${weapon.slot}`, type: "useInventoryItem", fields: { slot: weapon.slot, optionIndex: wield.opIndex }, waitTicks: 2 }];
    }
  }
  if (build !== "ranged-magic" && weaponName !== "unarmed" && !hasShield) {
    const shield = inventory.find((item) => text(item.name).includes("shield"));
    const wield = (shield?.optionsWithIndex as Json[] | undefined)?.find((option) => text(option.text).includes("wield"));
    if (shield && typeof shield.slot === "number" && typeof wield?.opIndex === "number") {
      return [{ id: `wield-shield-${shield.slot}`, type: "useInventoryItem", fields: { slot: shield.slot, optionIndex: wield.opIndex }, waitTicks: 2 }];
    }
  }

  const styles = Array.isArray(combatStyle?.styles) ? combatStyle.styles as Json[] : [];
  const attack = (state.skills ?? []).find((skill) => text(skill.name) === "attack");
  const strength = (state.skills ?? []).find((skill) => text(skill.name) === "strength");
  const attackLevel = typeof attack?.level === "number" ? attack.level : 1;
  const strengthLevel = typeof strength?.level === "number" ? strength.level : 1;
  // Brawler progression: keep Defence and Prayer at 1, build Strength first,
  // briefly train Attack to 40 for rune-tier weapons, then return to Strength.
  const desiredSkill = selectedSkill ?? (build === "ranged-magic" ? "ranged" : meleeTrainingSkill(attackLevel, strengthLevel));
  const strengthStyle = styles.find((style) => {
    const trains = Array.isArray(style.trainsSkills) ? style.trainsSkills : [];
    const normalized = trains.map((skill) => text(skill).toLowerCase());
    const forbidden = selectedSkill ? ['prayer'] : build === 'ranged-magic' ? ['defence', 'prayer', 'attack', 'strength'] : ['defence', 'prayer'];
    return normalized.includes(desiredSkill) && !normalized.some(skill => forbidden.includes(skill));
  });
  if (typeof strengthStyle?.index === "number" && combatStyle?.currentStyle !== strengthStyle.index) {
    return [{ id: `style-${desiredSkill}-${strengthStyle.index}`, type: "setCombatStyle", fields: { style: strengthStyle.index }, waitTicks: 1 }];
  }
  return [];
}

function combatLoadoutCandidates(state: GameState): Candidate[] {
  // A bow occupies both hands. Do not run melee shield/2H experiments while
  // Stinger is following the ranged/magic build; staff experiments are added
  // only after a staff and spell metadata have been observed.
  if (build === "ranged-magic") return [];
  const target = (state.nearbyNpcs ?? []).find((npc) => npc.reachable === true && npc.inCombat !== true && Array.isArray(npc.optionsWithIndex) && (npc.optionsWithIndex as Json[]).some((o) => /attack/i.test(text(o.text))));
  if (!target) return [];
  const targetName = text(target.name);
  const inventory = state.inventory ?? [];
  const equipment = state.equipment ?? [];
  const weaponName = text(state.combatStyle?.weaponName);
  const shieldEquipped = equipment.some((item) => /shield/i.test(text(item.name)));
  const twoHanded = inventory.find((item) => /two-handed|2h|battleaxe|warhammer|halberd|godsword/i.test(text(item.name)));
  const options: Candidate[] = [];
  if (twoHanded && weaponName !== text(twoHanded.name) && typeof twoHanded.slot === "number") {
    const wield = (twoHanded.optionsWithIndex as Json[] | undefined)?.find((o) => /wield|equip/i.test(text(o.text)));
    if (typeof wield?.opIndex === "number") options.push({ id: "experiment-2h-" + twoHanded.slot, type: "useInventoryItem", fields: { slot: twoHanded.slot, optionIndex: wield.opIndex }, waitTicks: 2 });
  }
  if (!shieldEquipped) {
    const shield = inventory.find((item) => /shield|defender/i.test(text(item.name)));
    const wield = (shield?.optionsWithIndex as Json[] | undefined)?.find((o) => /wield|equip/i.test(text(o.text)));
    if (shield && typeof shield.slot === "number" && typeof wield?.opIndex === "number") options.push({ id: "experiment-shield-" + shield.slot, type: "useInventoryItem", fields: { slot: shield.slot, optionIndex: wield.opIndex }, waitTicks: 2 });
  }
  return options;
}

function foodCandidates(state: GameState): Candidate[] {
  if (!shouldHeal(state, build === 'ranged-magic')) return [];
  return (state.inventory ?? []).flatMap((item): Candidate[] => {
    const eat = (item.optionsWithIndex as Json[] | undefined)?.find((option) => text(option.text) === "eat");
    return typeof item.slot === "number" && typeof eat?.opIndex === "number"
      ? [{ id: `eat-${item.slot}`, type: "useInventoryItem", fields: { slot: item.slot, optionIndex: eat.opIndex }, waitTicks: 1 }]
      : [];
  }).slice(0, 1);
}

function productionCandidates(state: GameState, requestedFood = false): Candidate[] {
  // Economy work still needs a small learned food reserve for mine travel and
  // exploration. If that reserve is missing, allow the ordinary fish/cook
  // recovery route to take ownership temporarily, then resume production.
  const inv = state.inventory ?? [];
  // CoinCrafter can mine, cut and process safely without carrying food. Do
  // not let an old food-recovery checkpoint send him through Gerrant's shop
  // forever; food becomes relevant again when combat or a dangerous site is
  // actually observed.
  if (!requestedFood && role === 'economy' && !economyNeedsFood(state)) return [];
  const locs = state.nearbyLocs ?? [];
  const foodMemory = work.learning?.food;
  const requiredFood = agency?.policy.foodTarget ?? (character==='clawscout'?Math.max(3,learnedFoodReserve(foodMemory)):learnedFoodReserve(foodMemory));
  const carriedFood = learnedFoodCount(inv);
  if (!work.foodBatch && carriedFood < requiredFood) {
    // Cached stock is a lead; opening the bank refreshes quantities before withdrawal.
    if ((work.bankItems ?? []).some(i => Number(i.count) > 0 && (bankFood(i) || rawFish(i)))) {
      work.economy ??= {};
      const route=bankAt(state,undefined,id=>!actionReady(work.failures[id]),work.economy.bankCooldowns??={});
      saveWork();return route;
    }
    work.foodBatch = {phase: 'gather', startedAt: Date.now()}; saveWork();
  }
  if (work.foodBatch) { advanceFoodBatch(work.foodBatch, inv); saveWork(); }
  if (work.foodBatch?.phase === 'bank') return bankAt(state);
  const cookBatch = work.foodBatch?.phase === 'cook';
  const raw = inv.find((item) => /^raw (shrimps|anchovies|sardines|herring|trout|salmon|tuna|lobster|swordfish)$/i.test(String(item.name)));
  const tinderbox = inv.find((item) => /^tinderbox$/i.test(String(item.name)) && typeof item.slot === 'number');
  const heatSource = locs.find((loc) => {
    if (!/^(fireplace|fire|range|stove|cooking pot)$/i.test(String(loc.name)) || typeof loc.x !== 'number' || typeof loc.z !== 'number') return false;
    const distance = Math.max(Math.abs(Number(state.player?.worldX) - loc.x), Math.abs(Number(state.player?.worldZ) - loc.z));
    return loc.reachable === true || distance <= 1;
  });
  const fire = heatSource?.reachable === true ? heatSource : undefined;
  const canBurnHigherTierLogs = level(state, 'firemaking') >= 15;
  const logs = inv.find((item) => (canBurnHigherTierLogs ? /^(logs|oak logs|willow logs|maple logs|yew logs|magic logs)$/i : /^logs$/i).test(String(item.name)) && typeof item.slot === 'number');
  // A live fire is preferable to making another one. Walk back to it when
  // the player has drifted away while gathering a compatible normal log.
  if (raw && cookBatch && fire && typeof fire.x === 'number' && typeof fire.z === 'number') {
    const distanceToFire = Math.max(Math.abs(Number(state.player?.worldX) - fire.x), Math.abs(Number(state.player?.worldZ) - fire.z));
    if (distanceToFire > 2) return [{ id: `walk-to-local-fire-${fire.x}-${fire.z}`, type: 'walkTo', fields: { x: fire.x, z: fire.z, level: Number(fire.level ?? 0), reason: 'return to the reachable fire before cooking the survival reserve' }, waitTicks: 3 }];
  }
  if (raw && cookBatch && heatSource && typeof raw.slot === 'number' && typeof heatSource.x === 'number' && typeof heatSource.z === 'number') {
    const distanceToHeat = Math.max(Math.abs(Number(state.player?.worldX) - heatSource.x), Math.abs(Number(state.player?.worldZ) - heatSource.z));
    if (distanceToHeat <= 1) return [{ id: `cook-${raw.slot}-${heatSource.x}-${heatSource.z}`, type: 'useItemOnLoc', fields: { itemSlot: raw.slot, x: heatSource.x, z: heatSource.z, locId: heatSource.id }, waitTicks: 4 }];
  }
  // If cooking needs a heat source but the observed fireplace is unreachable,
  // make a safe local fire first. Gather a reachable log when necessary, then
  // use the tinderbox on it. This keeps ClawScout progressing instead of
  // retrying the same unreachable item-on-location action.
  if (raw && cookBatch && tinderbox) {
    const lightId = logs ? `light-fire-${logs.slot}` : undefined;
    const lightBlocked = lightId !== undefined && (work.failures[lightId]?.until ?? 0) > Date.now();
    if (lightBlocked) {
      return [{ id: 'travel-to-cooking-source', type: 'walkTo', fields: { ...WORLD_ROUTES.draynorCooking, reason: 'the local tile rejected firemaking; use a verified cooking source instead' }, waitTicks: 2 }];
    }
    if (logs) return [{ id: `light-fire-${logs.slot}`, type: 'useItemOnItem', fields: { sourceSlot: tinderbox.slot, targetSlot: logs.slot, reason: 'make a reachable fire before cooking the survival food reserve' }, waitTicks: 4 }];
    const tree = locs.find((loc) => {
      const options = (loc.optionsWithIndex as Json[] | undefined) ?? [];
      return loc.reachable === true && /^tree$/i.test(String(loc.name)) && typeof loc.x === 'number' && typeof loc.z === 'number' && typeof loc.id === 'number' && options.some((option) => /chop/i.test(text(option.text)) && typeof option.opIndex === 'number');
    });
    const chop = (tree?.optionsWithIndex as Json[] | undefined)?.find((option) => /chop/i.test(text(option.text)) && typeof option.opIndex === 'number');
    if (tree && typeof chop?.opIndex === 'number') return [{ id: `gather-fire-log-${tree.id}-${tree.x}-${tree.z}`, type: 'interactLoc', fields: { x: tree.x, z: tree.z, locId: tree.id, optionIndex: chop.opIndex, reason: 'gather one reachable log for a local cooking fire' }, waitTicks: 5 }];
  }
  // Optionless cooking locations can report reachable:false despite being
  // usable via item-on-location. Try a directly adjacent source and verify it.
  if (raw && cookBatch && fire && typeof raw.slot === 'number' && typeof fire.x === 'number' && typeof fire.z === 'number') {
    return [{ id: `cook-${raw.slot}-${fire.x}-${fire.z}`, type: 'useItemOnLoc', fields: { itemSlot: raw.slot, x: fire.x, z: fire.z, locId: fire.id }, waitTicks: 4 }];
  }
  const rawCount = inv.filter(i => /^raw /i.test(String(i.name))).reduce((n, i) => n + Number(i.count ?? 1), 0);
  if (raw && cookBatch) return [{ id: 'travel-to-cooking-source', type: 'walkTo', fields: { ...WORLD_ROUTES.draynorCooking, reason: 'cook the entire gathered batch before storing surplus' }, waitTicks: 2 }];
  const hasNet = inv.some(i => /small fishing net/i.test(String(i.name)));
  if (!hasNet && !inv.some(isFood)) {
    const shop = state.shop ?? {};
    const stock = (shop.shopItems as Json[] | undefined) ?? [];
    if (shop.isOpen === true) {
      const net = stock.find(i => /small fishing net/i.test(String(i.name)) && Number(i.count) > 0 && Number(i.buyPrice) <= coinsIn(inv));
      if (net) { delete work.fishingToolFundingUntil; delete work.fishingToolTradeAttempted; saveWork(); return [{ id: 'buy-recovery-net', type: 'shopBuy', fields: { slot: net.slot, amount: 1 }, waitTicks: 2 }]; }
      // Gerrant may be open while the character has no carried cash. Close the
      // shop, fund the purchase at the bank, then return; never re-trade the
      // same NPC indefinitely.
      work.fishingToolFundingUntil=Date.now()+10*60_000;saveWork();
      return [{ id: 'close-fishing-shop-for-funds', type: 'closeModal', fields: { reason: 'bank for the fishing-tool purchase budget' }, waitTicks: 1 }];
    }
    if ((work.fishingToolFundingUntil??0)>Date.now()) {
      if (state.bank?.isOpen===true) {
        const bankCoins=(state.bank.items??[]).find((i:any)=>/^coins$/i.test(String(i.name))&&Number(i.count)>0);
        if (bankCoins) return [{ id: 'withdraw-fishing-tool-funds', type: 'bankWithdraw', fields: { slot: bankCoins.slot, amount: Math.min(50,Number(bankCoins.count)) }, waitTicks: 2 }];
        return [{ id: 'close-bank-after-fishing-tool-funds', type: 'closeModal', fields: { reason: 'resume after checking fishing-tool funds' }, waitTicks: 1 }];
      }
      if (coinsIn(inv)<5) return [{ id: 'bank-for-fishing-tool-funds', type: 'walkTo', fields: { ...WORLD_ROUTES.varrockWestBank, running: true, reason: 'withdraw cash for Gerrant fishing tool' }, waitTicks: 3 }];
      // We may already be at Gerrant after the funding trip. Re-read the
      // visible NPC before issuing another walk, otherwise the agent loops on
      // an arrived route and never opens the shop.
      const fundedGerrant = (state.nearbyNpcs ?? []).find(n => /gerrant/i.test(String(n.name)) && n.reachable === true);
      const fundedTrade = (fundedGerrant?.optionsWithIndex as Json[] | undefined)?.find(o => /trade/i.test(String(o.text)));
      if (fundedGerrant && typeof fundedGerrant.index === 'number' && typeof fundedTrade?.opIndex === 'number') {
        work.fishingToolTradeAttempted = true; saveWork();
        return [{ id: 'trade-for-fishing-tool-funded', type: 'interactNpc', fields: { npcIndex: fundedGerrant.index, optionIndex: fundedTrade.opIndex }, waitTicks: 3 }];
      }
      return [{ id: 'return-to-fishing-tool-shop', type: 'walkTo', fields: { ...WORLD_ROUTES.gerrantsFishingShop, reason: 'buy the fishing tool after funding the trip' }, waitTicks: 2 }];
    }
    if(work.fishingToolTradeAttempted){
      work.fishingToolFundingUntil=Date.now()+10*60_000;saveWork();
      return [{ id: 'bank-after-fishing-shop-trade-failure', type: 'walkTo', fields: { ...WORLD_ROUTES.varrockWestBank, running: true, reason: 'Gerrant trade did not open; fund the fishing-tool purchase at the bank' }, waitTicks: 3 }];
    }
    const gerrant = (state.nearbyNpcs ?? []).find(n => /gerrant/i.test(String(n.name)) && n.reachable === true);
    const trade = (gerrant?.optionsWithIndex as Json[] | undefined)?.find(o => /trade/i.test(String(o.text)));
    if (gerrant && trade) { work.fishingToolTradeAttempted=true;saveWork(); return [{ id: 'trade-for-fishing-tool', type: 'interactNpc', fields: { npcIndex: gerrant.index, optionIndex: trade.opIndex }, waitTicks: 3 }]; }
    return [{ id: 'travel-for-fishing-tool', type: 'walkTo', fields: WORLD_ROUTES.gerrantsFishingShop, waitTicks: 2 }];
  }
  // Fishing spots are NPCs in this server, not locations.
  const fish = (state.nearbyNpcs ?? []).find((npc) => /fishing\s*spot/i.test(String(npc.name)) && npc.reachable === true && typeof npc.index === "number" &&
    !(Number(npc.x) >= 3076 && Number(npc.x) <= 3094 && Number(npc.z) >= 3229 && Number(npc.z) <= 3247));
  if (fish && hasNet && inv.length < 28 && (work.foodBatch?.phase === 'gather' || carriedFood < requiredFood)) {
    const option = (fish.optionsWithIndex as Json[] | undefined)?.find((candidate) => /^net$/i.test(text(candidate.text)));
    if (typeof option?.opIndex === "number") return [{ id: `fish-${fish.index}`, type: "interactNpc", fields: { npcIndex: fish.index, optionIndex: option.opIndex, reason: "fish safe starter food" }, waitTicks: 5 }];
  }
  // Food is a hard survival requirement. Search a wider area instead of
  // falling back to combat or idle waiting when the reserve is exhausted.
  if (work.foodBatch?.phase === 'gather' || carriedFood < requiredFood) {
    const player = state.player ?? {};
    const distanceToDraynor = Math.hypot((Number(player.worldX) || 0) - WORLD_ROUTES.draynorFishing.x, (Number(player.worldZ) || 0) - WORLD_ROUTES.draynorFishing.z);
    if (distanceToDraynor > 8) return [{ id: "walk-to-draynor-fishing", type: "walkTo", fields: { ...WORLD_ROUTES.draynorFishing, running: true, reason: "safe level-1 food recovery" }, waitTicks: 5 }];
    return [{ id: "scan-for-draynor-fishing", type: "scanNearbyLocs", fields: { radius: 40, reason: "find fishing-spot NPC" }, waitTicks: 2 }];
  }
  return [];
}

async function candidates(state: GameState): Promise<Candidate[]> {
  if(role==='economy'){
    work.economy??={bankItems:work.bankItems??[]};
    const previous=work.economy.objectives?.intent?.id,intent=selectWork(state,work.economy);
    if(previous!==intent?.id)travelAction=null;
    const memory=objectives(work.economy),reserve:Record<number,number>=bowReserve(work.economy);
    for(const need of memory.needs)if(need.verified&&need.downstreamReady&&need.expires>Date.now())reserve[need.outputId]=Math.max(reserve[need.outputId]??0,need.quantity);
    const inv=state.inventory??[],processing=inv.some(i=>String(i.name).toLowerCase()===work.economy!.processing);
    const unfinished=intent?.mode==='finish'||processing||intent?.mode!=='logs'&&inv.some(i=>/^(.*logs|logs|.*ore|.*bar)$/i.test(String(i.name)));
    // A metalworking tool visit is an active prerequisite, not a liquidation
    // opportunity. Let metalNext buy the observed hammer/pickaxe before the
    // generic capital planner can close the shop and reopen it indefinitely.
    equipmentGoals.setWorkIntent(intent?{track:intent.track,outputId:intent.outputId,reserve,prices:memory.prices,allowLiquidation:intent.track!=='metalworking'&&!unfinished&&Number(state.player?.animId??-1)<0}:undefined);
    saveWork();
  }
  if(Date.now()>=marketRetryAt)try{peerMarket?.observe(state, equipmentGoals.memory.bank, equipmentGoals.memory.bankCheckedAt,work.economy?.objectives?.decision);}
  catch(error){marketRetryAt=Date.now()+60_000;console.error(JSON.stringify({marketError:String(error),policy:'Keep normal goals running; retry market later'}));}
  // Until transfer primitives are verified, never let the generic dialog
  // chooser accidentally accept a trade (including unsolicited requests).
  if((state as any).trade?.isOpen)return [{id:'decline-unverified-trade',type:'closeModal',waitTicks:2}];
  if (state.player?.isDead === true) return [{ id: "wait-respawn", type: "wait", waitTicks: 5 }];
  if (state.modalOpen === true && state.inventory?.length === 0) {
    return [{ id: "accept-design", type: "acceptCharacterDesign", waitTicks: 2 }];
  }
  // Survival arbitration is global: crafting, smithing, dialogue and shop
  // preparation must not bypass an urgent heal merely because their branch
  // appears earlier in the planner.
  const urgentFoodBeforePreparation = foodCandidates(state);
  if (urgentFoodBeforePreparation.length > 0) {
    equipmentGoals.interrupt('heal before ordinary preparation');
    return state.bank?.isOpen === true || state.shop?.isOpen === true
      ? [{ id: 'close-modal-to-heal', type: 'closeModal', waitTicks: 1 }]
      : urgentFoodBeforePreparation;
  }
  const metalWorkingSelected = role === 'economy' &&
    (work.economy?.objectives?.intent?.track === 'metalworking' || work.economy?.objectives?.decision?.chosen?.track === 'metalworking');
  if (equipmentGoals.crafting() && state.dialog?.isOpen === true && state.dialog?.isWaiting !== true && !metalWorkingSelected) {
    const recipe = await equipmentGoals.next(state, (from,to) => navigator!.assess(from,to));
    if (recipe) return [recipe];
  }
  if(role==='economy'&&work.economy){const recipe=metalDialog(state,work.economy);if(recipe){saveWork();return [recipe];}}
  const dialogs = dialogCandidates(state);
  // Survival arbitration precedes ordinary dialogue and transaction work.
  const urgentFood = foodCandidates(state);
  if (urgentFood.length > 0) {
    equipmentGoals.interrupt('heal');
    return state.bank?.isOpen === true || state.shop?.isOpen === true
      ? [{ id: 'close-modal-to-heal', type: 'closeModal', waitTicks: 1 }] : urgentFood;
  }
  if (role === 'economy') {
    if (!economyNeedsFood(state)) {
      const staleRecovery = work.autonomy?.active?.action ?? '';
      if (/^(bank-for-fishing-tool-funds|return-to-fishing-tool-shop|trade-for-fishing-tool(?:-funded)?|bank-after-fishing-shop-trade-failure|travel-for-fishing-tool)$/.test(staleRecovery)) {
        delete work.autonomy?.active;
        delete work.fishingToolFundingUntil;
        delete work.fishingToolTradeAttempted;
        work.economy ??= { bankItems: work.bankItems ?? [] };
        work.economy.goal = 'independent-production-fallback';
        work.economy.reason = 'safe production does not require a carried food reserve';
        saveWork();
      }
    }
    work.learning ??= {};
    const escape = (work.learning.escape ??= {}) as {active?:boolean;safeSince?:number};
    const opponent=activeOpponent(state);
    if (!escape.active && canDefend(state,opponent)) return [{id:'continue-combat',type:'wait',waitTicks:1}];
    if (mustEscape(state, escape)) {
      work.learning.unsafeAuburyUntil = Date.now()+30*60_000;
      saveWork(); travelAction=null;
      return [{id:'escape-combat',type:'retreat',waitTicks:2}];
    }
    saveWork();
  }
  if (dialogs.length > 0) return dialogs;

  // Once a non-economy agent has opened the bank, finish that transaction
  // before ammunition, cooking, or exploration candidates can take control.
  // Otherwise Stinger can open the bank successfully and immediately return
  // to the trees without depositing the accumulated arrow shafts.
  if (role !== 'economy' && state.bank?.isOpen === true) {
    const transaction = available(bankingCandidates(state));
    return transaction.length ? transaction : [{ id: 'close-bank-after-transaction', type: 'closeModal', waitTicks: 1 }];
  }

  // Stinger needs a reliable food path for ranged exploration. Do not wait
  // until the current food reserve is empty before acquiring fishing gear:
  // otherwise a tree/combat candidate can keep him stationary while the
  // recovery route remains unreachable. Fishing gear is a real progression
  // prerequisite, so route to Gerrant whenever it is missing.
  if(character==='stinger' && coinsIn(state.inventory??[])<5 && !(state.inventory??[]).some(i=>/small fishing net/i.test(String(i.name)))) {
    if(state.shop?.isOpen)return [{id:'close-unfunded-fishing-shop',type:'closeShop',waitTicks:1}];
    return bankAt(state);
  }
  if (character === 'stinger' && !(state.inventory ?? []).some((item) =>
    /small fishing net|fishing rod|lobster pot|harpoon/i.test(String(item.name)))) {
    if (state.shop?.isOpen === true) {
      const net = (state.shop.shopItems as Json[] ?? []).find(item => /small fishing net/i.test(String(item.name)) && Number(item.count)>0 && Number(item.buyPrice)<=coinsIn(state.inventory??[]));
      if (net) return [{id:'buy-recovery-net',type:'shopBuy',fields:{slot:net.slot,amount:1},waitTicks:2}];
      return [{id:'close-unhelpful-fishing-shop',type:'closeShop',waitTicks:1}];
    }
    const gerrant = (state.nearbyNpcs ?? []).find((npc) => /gerrant/i.test(String(npc.name)) && npc.reachable === true);
    const trade = (gerrant?.optionsWithIndex as Json[] | undefined)?.find((option) => /trade/i.test(text(option.text)));
    if (gerrant && typeof gerrant.index === 'number' && typeof trade?.opIndex === 'number') {
      return [{ id: 'stinger-trade-for-fishing-gear', type: 'interactNpc', fields: { npcIndex: gerrant.index, optionIndex: trade.opIndex }, waitTicks: 3 }];
    }
    const player = state.player ?? {};
    const distance = Math.hypot((Number(player.worldX) || 0) - WORLD_ROUTES.gerrantsFishingShop.x,
      (Number(player.worldZ) || 0) - WORLD_ROUTES.gerrantsFishingShop.z);
    if (distance > 8) return [{ id: 'stinger-go-fishing-shop', type: 'walkTo', fields: { ...WORLD_ROUTES.gerrantsFishingShop, running: true, reason: 'obtain fishing gear for reliable food recovery' }, waitTicks: 3 }];
  }

  // Tutorial progression is mandatory: without the guide the character has no
  // starter tools or food, so do not route toward the wider world yet.
  if ((state.inventory?.length ?? 0) === 0) {
    const guide = (state.nearbyNpcs ?? []).find((npc) => /runescape guide|tutorial guide|guide/i.test(text(npc.name)) && typeof npc.index === "number");
    if (guide) return [{ id: "tutorial-guide-" + guide.index, type: "talkToNpc", fields: { npcIndex: guide.index }, waitTicks: 3 }];
  }

  // CoinCrafter can safely mine, bank and smith without carrying food. Food
  // recovery is still available through an explicit production goal, but it
  // must not pre-empt a safe economy cycle merely because the combat reserve
  // is empty.
  if (role !== 'economy') {
    const food = foodCandidates(state);
    if (food.length > 0) {
      equipmentGoals.interrupt('heal');
      return state.bank?.isOpen === true || state.shop?.isOpen === true
        ? [{ id: 'close-modal-to-heal', type: 'closeModal', waitTicks: 1 }] : food;
    }
  }

  // Refilling a depleted quiver from carried ammunition is part of combat,
  // not an equipment experiment. Do this before an empty quiver causes retreat.
  if (build === 'ranged-magic') {
    const reload = available(quiverRefill(state));
    if (reload.length) return state.bank?.isOpen || state.shop?.isOpen
      ? [{id:'close-modal-to-reload',type:'closeModal',waitTicks:1}] : reload;
  }

  const disposition = combatDisposition(state, role === 'economy', build === 'ranged-magic', work.learning?.food?.maxObservedDamage);
  if (training?.timedOut(state)) { travelAction = null; return [{ id: 'escape-encounter-timeout', type: 'retreat', waitTicks: 2 }]; }
  if (disposition !== 'quiet') {
    equipmentGoals.interrupt(disposition === 'engaged' ? 'finish current combat' : 'escape danger');
    travelAction = null;
    if (disposition === 'engaged') return [{ id: 'continue-combat', type: 'wait', waitTicks: 2 }];
    return [{ id: 'escape-combat', type: 'retreat', waitTicks: 2 }];
  }
  // The server can leave inCombat=true for a short period after a kill. Do
  // not let a prepared gathering or travel action run through that window.
  // Waiting gives the next observation a chance to confirm the encounter has
  // actually ended without interrupting a legitimate combat action.
  if (state.player?.combat?.inCombat === true && (state.player?.combat?.targetType === 'player' || isApprovedNpcTarget(activeOpponent(state)))) {
    travelAction = null;
    return [{ id: 'await-combat-state-clear', type: 'wait', waitTicks: 1 }];
  }

  // Featherer is a supply specialist. Once immediate combat safety is clear,
  // its chicken/cow objective outranks generic starter-kit cleanup and gear
  // acquisition; those items are useful fallback equipment in the field.
  if (character === 'featherer') {
    const resource = available(featherResourceCandidates(state));
    if (resource.length > 0) {
      travelAction = null;
      return resource;
    }
  }

  // Featherer must not reopen the bank indefinitely after a completed
  // deposit.  Once the resource transaction has no further observed work,
  // close the interface and let the resource selector choose the next site.
  if (character === 'featherer' && state.bank?.isOpen === true) {
    return [{ id: 'featherer-close-completed-bank', type: 'closeModal', fields: { reason: 'resume gathering after the observed bank transaction' }, waitTicks: 1 }];
  }

  // ClawScout's weapon recovery is a prerequisite for any combat plan.  Do
  // this before funding/shop logic so an item already owned cannot leave him
  // unarmed in a service loop.  The option index is always copied from the
  // current observation.
  if (character === 'clawscout' && !(state.equipment ?? []).some(item => /sword|scimitar|longsword|battleaxe|mace|dagger|warhammer/i.test(text(item.name)))) {
    const weapon = (state.inventory ?? []).filter(item => /sword|scimitar|longsword|battleaxe|mace|dagger|warhammer/i.test(text(item.name)))
      .sort((a, b) => Number(b.slot ?? 99) - Number(a.slot ?? 99))[0];
    const wield = (weapon?.optionsWithIndex as Json[] | undefined)?.find(option => /^(wield|wear|equip)$/i.test(text(option.text)));
    if (weapon && typeof weapon.slot === 'number' && typeof wield?.opIndex === 'number') {
      return state.bank?.isOpen || state.shop?.isOpen
        ? [{ id: 'clawscout-close-to-equip', type: 'closeModal', waitTicks: 1 }]
        : [{ id: `clawscout-equip-${weapon.id}`, type: 'useInventoryItem', fields: { slot: weapon.slot, optionIndex: wield.opIndex, reason: 'equip the strongest currently owned weapon before combat' }, waitTicks: 1 }];
    }
  }

  // Cleanup is a prerequisite for food recovery: otherwise a stale cooking
  if(role==='economy' && !basicKit(state)) {
    // Equip only catalog-validated, level-usable pieces; retain the mining tools.
    const kit=(state.inventory??[]).find(i=>gearCatalog.items.some(g=>g.id===i.id&&['melee','shield','body'].includes(g.family)&&usable(g,state))
      && !(state.equipment??[]).some(e=>gearCatalog.items.some(g=>g.id===e.id&&g.family===gearCatalog.items.find(k=>k.id===i.id)?.family)));
    const op=(kit?.optionsWithIndex as Json[]|undefined)?.find(o=>/^(wear|wield)$/i.test(String(o.text)));
    if(kit&&op) return state.bank?.isOpen||state.shop?.isOpen?[{id:'defence-close-to-equip',type:'closeModal',waitTicks:1}]
      :[{id:'defence-equip-'+kit.id,type:'useInventoryItem',fields:{slot:kit.slot,optionIndex:op.opIndex},waitTicks:1}];
    const defence=await defensiveGoals.next(state,(from,to)=>navigator!.assess(from,to));
    if(defence){travelAction=null;return [{...defence,fields:{...defence.fields,defensiveGoal:true}}];}
  }

  // Cleanup is a prerequisite for food recovery: otherwise a stale cooking
  if (work.foodBatch && !state.shop?.isOpen) {
    const batch = available(productionCandidates(state));
    if (batch.length) { travelAction = null; return batch; }
  }

  // Cleanup is a prerequisite for food recovery: otherwise a stale cooking
  // itinerary can keep the agent carrying obsolete items while it tries to
  // solve a full/dirty inventory. This is deliberately limited to explicit
  // clutter or oversized arrow-material stacks.
  const equippedNames = (state.equipment ?? []).map(item => text(item.name));
  const urgentInventoryCleanup = (state.inventory ?? []).some(item => isUrgentClutter(item, build, equippedNames,state.inventory?.length??0)) ||
    (state.inventory ?? []).some(item => /arrow shaft/i.test(text(item.name)) && Number(item.count ?? 0) >= 100);
  if (urgentInventoryCleanup && !state.bank?.isOpen && !state.shop?.isOpen) {
    const cleanup = available(bankingCandidates(state));
    if (cleanup.length) {
      equipmentGoals.interrupt('bank obsolete gear and excess arrow materials before resupply');
      travelAction = null;
      return cleanup;
    }
  }

  // Safety and current combat precede acquisitions. Food recovery interrupts,
  // but never deletes, the persistent equipment/funding goal.
  const learnedTripFood = character==='clawscout'?Math.max(3,learnedFoodReserve(work.learning?.food)):learnedFoodReserve(work.learning?.food);
  if (role !== 'economy' && learnedFoodCount(state.inventory ?? []) < learnedTripFood && !state.bank?.isOpen && !state.shop?.isOpen) {
    const supplies = available(productionCandidates(state));
    if (supplies.length) { equipmentGoals.interrupt(`replenish learned food reserve (${learnedTripFood})`); travelAction = null; return supplies; }
    // Never convert an unavailable food route into an idle wait loop. Preserve
    // the equipment goal, but switch to bounded world discovery so a different
    // fishing spot, bank, food source, or safe training site can be learned.
    const foodRecovery = await autonomousRecovery(state, 'food-route-unavailable');
    if (foodRecovery.length) return available(foodRecovery);
    return [{ id: 'explore-food-alternative', type: 'scanNearbyLocs', fields: { radius: 30, reason: 'find an alternative food or productive route' }, waitTicks: 2 }];
  }
  const arrowProduction = available(arrowProductionCandidates(state));
  if (arrowProduction.length) {
    equipmentGoals.interrupt('complete ranged ammunition from observed materials');
    travelAction = null;
    return arrowProduction;
  }
  const lobsterProgression = available(lobsterProgressionCandidates(state));
  if (lobsterProgression.length) {
    equipmentGoals.interrupt('progress to level-40 lobster fishing');
    travelAction = null;
    return lobsterProgression;
  }
  // An empty quiver makes combat and funding attempts unsafe. Supply recovery
  // has to precede the gear planner, otherwise a desperate archer can keep
  // pickpocketing, enter combat, and abandon the arrow route it just reached.
  if (character === 'stinger') {
    const arrowCount = (state.inventory ?? []).filter(item => isFinishedArrow(text(item.name)))
      .reduce((sum, item) => sum + Number(item.count ?? 1), 0);
    const carriedCoins = coinsIn(state.inventory ?? []);
    if (arrowCount === 0 && carriedCoins < 10 && state.bank?.isOpen === true) {
      const bankCoins = (work.bankItems ?? []).find(item => /^coins$/i.test(text(item.name)) && Number(item.count ?? 0) > 0);
      if (bankCoins && typeof bankCoins.slot === 'number') {
        return [{ id: 'stinger-withdraw-working-cash', type: 'bankWithdraw', fields: { slot: bankCoins.slot, amount: Math.min(500, Number(bankCoins.count)) , reason: 'fund a safe ammunition or pickaxe purchase from verified surplus bank cash' }, waitTicks: 2 }];
      }
    }
    if (arrowCount === 0 && carriedCoins < 10) {
      const productive = available(productionCandidates(state));
      if (productive.length) {
        equipmentGoals.interrupt('earn working cash or gather missing arrow inputs before ranged training');
        travelAction = null;
        return productive;
      }
    }
  }
  const rangedSupply = preferRangedSupply(
    build === 'ranged-magic',
    available([...nearbyAmmoRecovery(state), ...ammoCandidates(state)]),
    [],
  );
  if (rangedSupply.length) {
    equipmentGoals.interrupt('restore ranged supplies');
    travelAction = null;
    return rangedSupply;
  }
  // Once the economy intent is the staged metal chain, its tool purchase,
  // mining, smelting and Smithing actions must be selected before the generic
  // social/capital planners. This prevents a queued shop-close action from
  // starving a required hammer or pickaxe purchase.
  if (metalWorkingSelected) {
    travelAction = null;
    const recentMetal = (work.autonomy?.recentActions ?? []).slice(-4);
    const capitalOscillation = recentMetal.length === 4
      && recentMetal[0] === recentMetal[2]
      && recentMetal[1] === recentMetal[3]
      && /metal-(secure-gold|withdraw-tool-cash)/.test(recentMetal[0] ?? '')
      && /metal-(secure-gold|withdraw-tool-cash)/.test(recentMetal[1] ?? '');
    if (capitalOscillation) {
      // Moving the same cash between inventory and bank is not preparation.
      // Suspend this metal attempt and select a genuinely productive fallback
      // while retaining the long-term mining/smithing goal for later review.
      const intentId = work.economy?.objectives?.intent?.id;
      if (intentId) work.economy!.objectives!.blocked[intentId] = Date.now() + 30 * 60_000;
      delete work.economy?.objectives?.intent;
      work.economy!.goal = 'independent-production-fallback';
      work.economy!.reason = 'cash preparation oscillated without reaching a purchase or mining step';
      work.autonomy!.recentActions = [];
      saveWork();
      const fallback = available(productionCandidates(state));
      if (fallback.length) return fallback;
    }
    // A persistent metal-recovery blocker must not become an idle objective.
    // After five minutes without verified progress, suspend this attempt and
    // hand control to an independent production or Rune-essence investigation.
    const activeRecovery = work.autonomy?.active;
    if (activeRecovery?.action === 'economy-metal-recovery' && activeRecovery.lastProgress === 0 && Date.now() - Number(activeRecovery.since ?? Date.now()) >= 300_000) {
      if (work.economy?.objectives?.intent?.id) work.economy.objectives.blocked[work.economy.objectives.intent.id] = Date.now() + 30 * 60_000;
      delete work.economy?.objectives?.intent;
      work.economy!.goal = 'independent-production-fallback';
      work.economy!.reason = 'metalworking blocker exceeded bounded recovery window';
      saveWork();
      const runeFallback = Number(work.learning?.unsafeAuburyUntil??0)>Date.now() || (Number(state.player?.maxHp)<20 && learnedFoodCount(state.inventory??[])<3) ? [] : available(runeDiscoveryCandidates(state, WORLD_ROUTES.auburysRuneShop, runeMysteriesComplete(), true) as Candidate[]);
      if (runeFallback.length) return runeFallback;
      const alternate = available(productionCandidates(state));
      if (alternate.length) return alternate;
    }
    // Safe mining does not require carried food. Food recovery is reserved for
    // combat-risk routes; a banked food reserve is still maintained whenever
    // an agent actually needs food for a dangerous activity.
    const metalPlan = available(economyNext(state, work.economy, id => (work.failures[id]?.until ?? 0) > Date.now()));
    saveWork();
    if (metalPlan.length && metalPlan[0]?.id !== 'economy-review-profit-prerequisites') return metalPlan;
    const recovery = available(await autonomousRecovery(state, 'metalworking-recovery-cooldown'));
    return recovery.length ? recovery : [{ id: 'economy-metal-recovery', type: 'wait', waitTicks: 5 }];
  }
  // CoinCrafter keeps production as the main objective, but periodically
  // performs a bounded, observation-driven Rune Mysteries follow-up. This
  // discovers the private server's essence route without replacing the
  // profitable woodcutting/fletching loop.
  if (role === 'economy') {
    work.learning ??= {};
    const probeDue = Number(work.learning.runeProbeAt ?? 0) <= Date.now();
    const runeActions = Number(work.learning?.unsafeAuburyUntil??0)>Date.now() || (Number(state.player?.maxHp)<20 && learnedFoodCount(state.inventory??[])<3) ? [] : available(runeDiscoveryCandidates(state, WORLD_ROUTES.auburysRuneShop, runeMysteriesComplete(), probeDue) as Candidate[]);
    if (runeActions.length) {
      equipmentGoals.interrupt('bounded rune-essence discovery experiment');
      travelAction = null;
      return runeActions;
    }
  }
  // The finite bow chain owns its ingredients and transaction. Safety above
  // still wins; unrelated axe funding must not sell its reserved unstrung bows.
  if(role==='economy'&&work.economy?.objectives?.intent?.mode==='finish'){
    equipmentGoals.interrupt('Complete bounded bowmaking batch');
    if(!state.bank?.isOpen&&!state.shop?.isOpen&&travelAction&&available([travelAction]).length)return [travelAction];
    travelAction=null;
    const plan=available(bowNext(state,work.economy,id=>(work.failures[id]?.until??0)>Date.now()));saveWork();
    return plan.length?plan:[{id:'economy-bow-recovery',type:'wait',waitTicks:5}];
  }
  // Metalworking owns its tool prerequisites end-to-end. If the generic gear
  // planner also runs here, it can close the required shop for a capital audit
  // and reopen it on the next tick, starving the mining/smithing controller.
  if (character === 'featherer') {
    const resource = available(featherResourceCandidates(state));
    if (resource.length > 0) {
      travelAction = null;
      return resource;
    }
  }
  const metalToolChain = metalWorkingSelected;
  // ClawScout has already spent too long retrying the sword-shop route. An
  // iron longsword is no longer allowed to block combat progression: let the
  // training discovery system test the verified Black Knight site instead.
    const equipmentPlan = equipmentGoals.plan(state);
    const activeWeapon = (state.equipment ?? []).find(item => /sword|scimitar|longsword|battleaxe|mace|dagger|warhammer|bow|staff/i.test(text(item.name)));
    const weaponRank = (name: string) => ({bronze:1, iron:2, steel:3, mithril:4, adamant:5, rune:6}[String(name).toLowerCase().split(' ')[0]] ?? 0);
    const planWeapon = typeof equipmentPlan.target === 'string' && /sword|scimitar|longsword|battleaxe|mace|dagger|warhammer|bow|staff/i.test(equipmentPlan.target) ? weaponRank(equipmentPlan.target) : 0;
    // Gear is natural progression: an active weapon is already useful. Do not
    // force a shop/funding loop when the current weapon meets or exceeds the
    // planner's target; drops, crafting, trades and later observations remain
    // valid upgrade paths.
    const satisfiedByCurrentWeapon = !!activeWeapon && planWeapon > 0 && weaponRank(text(activeWeapon.name)) >= planWeapon;
    const acquisition = metalToolChain || satisfiedByCurrentWeapon ? undefined : await equipmentGoals.next(state, (from,to) => navigator!.assess(from,to));
  if (acquisition) {
    // Capital withdrawal hands the batch to the economy transaction. Without
    // this marker, the generic bank logic immediately deposits the same bows
    // and creates a zero-progress withdraw/deposit oscillation.
    if (role === 'economy' && acquisition.id === 'goal-capital-withdraw') {
      work.economy ??= { bankItems: work.bankItems ?? [] };
      work.economy.selling = true;
      saveWork();
    }
    travelAction = null;
    return [acquisition];
  }

  if (role === 'economy') {
    work.economy ??= { bankItems: work.bankItems ?? [] };
    if (!state.bank?.isOpen && !state.shop?.isOpen && travelAction && available([travelAction]).length) return [travelAction];
    travelAction = null;
    const plan = available(economyNext(state, work.economy, id => (work.failures[id]?.until ?? 0) > Date.now()));
    saveWork();
    if (plan.length && plan[0]?.id !== 'economy-review-profit-prerequisites') return plan;
    // A passive profitability review is not a terminal state. Keep learning by
    // surveying a local resource, a different prepared site, or the mine route.
    const freshResource = available(localEconomyDiscovery(state));
    return freshResource.length ? freshResource : available(await autonomousRecovery(state, 'economy-recovery-cooldown'));
  }

  // Bank and shop interfaces own their transaction until explicitly closed.
  if (state.bank?.isOpen === true) return available(bankingCandidates(state)).length ? available(bankingCandidates(state)) : [{ id: 'close-stalled-bank', type: 'closeModal', waitTicks: 2 }];
  if (state.shop?.isOpen === true) {
    const recoveryBuy = (state.inventory ?? []).some(isFood) ? [] : productionCandidates(state).filter(a => a.type === 'shopBuy');
    const purchases = available([...recoveryBuy, ...ammoCandidates(state)]);
    if (purchases.length) return purchases;
    // Use a fresh recovery identity after a rejected close so one stale
    // failure record cannot trap ClawScout inside the shop indefinitely.
    return [{ id: (work.failures['close-finished-shop']?.count ?? 0) > 0 ? 'close-stalled-shop' : 'close-finished-shop', type: 'closeModal', waitTicks: 1 }];
  }
  if (character === 'featherer') {
    const resource = available(featherResourceCandidates(state));
    if (resource.length > 0) {
      travelAction = null;
      return resource;
    }
  }
  // A prepared travel leg must not outrank a newly observed inventory cleanup.
  // Otherwise a stale cooking or resource route can carry obsolete gear and
  // materials across the world indefinitely before the next bank visit.
  const preTravelBanking = available(bankingCandidates(state));
  if (preTravelBanking.length) {
    equipmentGoals.interrupt('bank obsolete gear and excess production materials');
    travelAction = null;
    return preTravelBanking;
  }
  // Featherer has a resource-first objective. A bank/shop route persisted by
  // the generic equipment planner must not survive a role change and replay
  // forever ahead of the chicken/cow selector.
  if (character === 'featherer' && travelAction && /bank|shop|gear|iron|scimitar/i.test(travelAction.id)) travelAction = null;
  // Discovery reevaluates readiness between legs; supplies can invalidate a
  // commitment. Ordinary service trips retain their existing transaction owner.
  if (travelAction && !travelAction.fields?.trainingSite && available([travelAction]).length) return [travelAction];
  travelAction = null;

  if (work.bankReturn && work.bankReturnReady) {
    const home = work.bankReturn;
    if (position(state).level === home.level && Math.max(Math.abs(Number(state.player?.worldX) - home.x), Math.abs(Number(state.player?.worldZ) - home.z)) <= 1) { delete work.bankReturn; delete work.bankReturnReady; saveWork(); }
    else if (available([{ id: 'return-to-work', type: 'walkTo', waitTicks: 2 }]).length) return [{ id: 'return-to-work', type: 'walkTo', fields: home, waitTicks: 2 }];
  }

  const resource = available(featherResourceCandidates(state));
  if (resource.length > 0) return resource;

  const gear = available(gearCandidates(state));
  if (gear.length > 0) return gear;

  if (role !== 'economy' && (state.inventory ?? []).some(i => /^raw shrimps$/i.test(String(i.name)))) {
    const cooking = available(productionCandidates(state)).filter(a => a.id.startsWith('cook-') || a.id === 'travel-to-cooking-source');
    if (cooking.length) return cooking;
  }

  const banking = available(bankingCandidates(state));
  if (banking.length > 0) return banking;

  // Stinger may use guide-listed monsters only when that monster is actually
  // visible, reachable, appropriately levelled, and has a live Attack option.
  // Drops are picked up and measured before the lead becomes trusted.
  const dropLearning = (dropLearningCandidates(state, build) as Candidate[]).filter(a=>(work.failures[a.id]?.until??0)<=Date.now());
  if (dropLearning.length > 0) return dropLearning;

  if (role !== 'economy' && !(state.inventory ?? []).some(isFood)) {
    const recovery = available(productionCandidates(state));
    if (recovery.length) return recovery;
  }

  const ammo = available(ammoCandidates(state));
  if (ammo.length > 0) return ammo;

  // Peer trading is optional social activity. It is deliberately last among
  // actionable work so a queued message cannot starve gear, food, banking,
  // travel, discovery or training.
  const social=process.argv.includes('--peer-trade') && Date.now()>=marketRetryAt?peerMarket?.next(state):undefined;
  if(social)return [social];

  const combatLoadout = combatLoadoutCandidates(state);
  if (combatLoadout.length > 0) return combatLoadout;

  const production = available(productionCandidates(state));
  if (production.length > 0) return production;

  const economy = available(economyCandidates(state));
  if (economy.length > 0) return economy;

  if ((state.inventory?.length ?? 0) >= 28) return available(await autonomousRecovery(state, 'full-inventory-await-bank-route'));

  const goal = available(await goalCandidates(state));
  if (goal.length > 0) {
    // One optional drop-source experiment per ten minutes, only when there is
    // no committed training trip. Never substitute imps for viable training.
    if(goal.every(passive)&&!training?.memory.commitment&&Date.now()>=Number(work.learning?.dropProbeAt??0)){
      const probe=(dropLearningCandidates(state,build,true) as Candidate[]).filter(a=>(work.failures[a.id]?.until??0)<=Date.now());
      if(probe.length)return probe;
    }
    // A source-respawn or map-loading wait must not turn the character into an
    // idle bot. Survey a distinct safe area and let fresh observations select
    // a new goal; the original site remains in cooldown-aware memory.
    if (goal.every(passive)) {
      const recovery = available(await autonomousRecovery(state, goal[0]!.id));
      if (recovery.length) return recovery;
    }
    return goal;
  }

  const result: Candidate[] = [];
  for (const npc of state.nearbyNpcs ?? []) {
    if (text(npc.name).includes("runescape guide") && typeof npc.index === "number") {
      result.push({ id: `talk-guide-${npc.index}`, type: "talkToNpc", fields: { npcIndex: npc.index }, waitTicks: 2 });
    }
  }
  for (const loc of state.nearbyLocs ?? []) {
    if (!text(loc.name).includes("tree")) continue;
    const options = Array.isArray(loc.optionsWithIndex) ? loc.optionsWithIndex : [];
    const chop = options.find((option) => text((option as Json).text).includes("chop"));
    if (
      loc.reachable === true &&
      chop !== undefined &&
      typeof loc.x === "number" &&
      typeof loc.z === "number" &&
      typeof loc.id === "number"
    ) {
      result.push({
        id: `chop-${loc.id}-${loc.x}-${loc.z}`,
        type: "interactLoc",
        fields: { x: loc.x, z: loc.z, locId: loc.id, optionIndex: typeof chop?.opIndex === "number" ? chop.opIndex : 1 },
        waitTicks: 5,
      });
    }
  }
  // If no normal planner action is executable, keep learning the world by
  // moving to a verified fallback area or scanning for a resource. Never leave
  // the character on a bare wait when a recoverable alternative exists.
  const recovery = await autonomousRecovery(state, 'no-executable-action');
  result.push(...recovery);
  return available(result);
}

function reward(before: GameState, after: GameState, action: Candidate): number {
  return outcomeReward(before,after,action,role,build==='ranged-magic',gearCatalog);
}

function choose(key: string, options: Candidate[]): Candidate {
  options = preferActive(options);
  // A lesson belongs to the completed goal that produced it. Do not let a
  // stale lesson from a previous cycle force the same action forever.
  const active = goalLifecycle.active;
  const preferred = active && active.phase === 'execute' && active.kind !== 'continuous'
    ? active.learnings.at(-1)?.behavior?.replace(/^retain-or-refine:/, '')
    : undefined;
  if (preferred && !preferred.includes('undefined')) {
    const learned = options.find(o => o.id === preferred && (work.failures[o.id]?.count ?? 0) < 2);
    if (learned) options = [learned, ...options.filter(o => o !== learned)];
  }
  const values = q[key] ?? {};
  if (Math.random() < epsilon) return options[Math.floor(Math.random() * options.length)]!;
  return options.reduce((best, option) => (values[option.id] ?? 0) > (values[best.id] ?? 0) ? option : best, options[0]!);
}

function learn(key: string, action: Candidate, value: number, nextKey: string, nextOptions: Candidate[]): void {
  q[key] ??= {};
  const nextValues = q[nextKey] ?? {};
  const nextBest = nextOptions.length === 0 ? 0 : Math.max(...nextOptions.map((candidate) => nextValues[candidate.id] ?? 0));
  const old = q[key][action.id] ?? 0;
  q[key][action.id] = Number((old + alpha * (value + gamma * nextBest - old)).toFixed(6));
}

/** Task-specific executors are asked for actions only AFTER the Director chooses a goal. */
async function actionsForTask(state: GameState, task: Task): Promise<Candidate[]> {
  if (state.player?.isDead === true) return [];
  if (state.player?.combat?.inCombat === true) return [{id:'continue-combat',type:'wait',waitTicks:2}];
  if (state.modalOpen === true && state.inventory?.length === 0) return [{id:'accept-design',type:'acceptCharacterDesign',waitTicks:2}];
  if (state.dialog?.isOpen === true) {
    if(task.kind==='production'&&work.economy){
      const metal=metalDialog(state,work.economy);if(metal)return [metal];
      const product=work.economy.product&&productionDialog(state.dialog.options??[],work.economy.product);
      if(product&&Number.isInteger(product.index))return [{id:'select-planned-product',type:'clickDialogOption',fields:{optionIndex:product.index},waitTicks:4}];
    }
    return dialogCandidates(state);
  }
  if ((state.inventory?.length ?? 0) === 0) {
    const guide=(state.nearbyNpcs??[]).find(n=>/runescape guide|tutorial guide/i.test(String(n.name))&&n.reachable===true);
    if(guide)return [{id:'tutorial-guide',type:'talkToNpc',fields:{npcIndex:guide.index},waitTicks:3}];
  }
  if (state.bank?.isOpen === true) { const transaction=bankingCandidates(state);return transaction.length?transaction:[{id:'close-bank',type:'closeModal',waitTicks:1}]; }
  switch(task.kind) {
    case 'food': return productionCandidates(state,true);
    case 'ammunition': return [...quiverRefill(state), ...ammoCandidates(state), ...arrowProductionCandidates(state), ...safeAmmoSupplyCandidates(state)];
    case 'bank': return bankingCandidates(state);
    case 'equipment': return gearCandidates(state);
    case 'combat': {
      if(!state.combatStyle?.styles?.some((s:any)=>s.trainsSkills?.some((k:string)=>k.toLowerCase()===task.skill)))return [];
      const gear=gearCandidates(state,task.skill);
      if(gear.length)return gear;
      return training ? training.next(state,(from,to)=>navigator!.assess(from,to)) : [];
    }
    case 'production': {
      work.economy ??= {bankItems:work.bankItems??[]};
      selectWork(state,work.economy);
      const result=economyNext(state,work.economy,id=>!actionReady(work.failures[id]));
      saveWork(); return result;
    }
    case 'gathering': return [...economyCandidates(state),...localEconomyDiscovery(state)];
    case 'exploration': {
      if(!task.route)return [];
      const route=await navigator!.assess(position(state),task.route);
      if(route.status==='loading-map')return [{id:'observe-map-load',type:'wait',waitTicks:2}];
      if(route.status!=='ready')return [];
      return [{id:task.id,type:'walkTo',fields:{...task.route,running:true,reason:task.route.evidence},waitTicks:2}];
    }
  }
}

function urgentAgencyAction(state:GameState):Candidate|undefined {
  const heal=foodCandidates(state)[0];
  if(heal) return state.bank?.isOpen||state.shop?.isOpen||state.dialog?.isOpen
    ? {id:'close-interface-to-heal',type:'closeModal',waitTicks:1}:heal;
  if(state.player?.combat?.targetType==='player' || combatDisposition(state,false,build==='ranged-magic')==='recover')
    return {id:'emergency-retreat',type:'retreat',waitTicks:2};
}
function verification(value:ReturnType<typeof verifyActionOutcome>):Verification {
  return {status:value.verified?'verified':value.uncertain?'unknown':'rejected',evidence:value.evidence,reason:value.reason};
}
async function executeAgencyAction(state:GameState,action:Candidate):Promise<{next:GameState;result:Json}> {
  if(action.type==='walkTo'||action.type==='retreat') {
    const trip=action.type==='retreat'?await navigator!.escape(state):await navigator!.step({x:Number(action.fields?.x),z:Number(action.fields?.z),level:Number(action.fields?.level??0)},state);
    const next=trip.state.tick===state.tick?stateFrom(await cliCall(['wait','2'])):trip.state;
    return {next,result:{navigation:trip.navigation}};
  }
  if(action.type==='wait') {
    const result=await cliCall(['wait',String(action.waitTicks)]);return {next:stateFrom(result),result};
  }
  const fields:Json={...action.fields,reason:action.fields?.reason??action.id};
  for(const key of ['trainingSite','goalMethod','defensiveGoal','expectedItemId','evidence','id'])delete fields[key];
  if(action.type==='shopBuy'||action.type==='shopSell'){delete fields.itemId;delete fields.expectedPrice;}
  const type=action.type==='closeModal'&&state.shop?.isOpen?'closeShop':action.type;
  const result=await cliCall(['act',type,'--json',JSON.stringify(fields)]);
  return {next:stateFrom(await cliCall(['wait',String(action.waitTicks)])),result};
}
function observeAgencyResult(before:GameState,after:GameState,action:Candidate):void {
  work.learning??={};work.learning.food??={};
  recordFoodExperience(work.learning.food,before,after,action.id);
  recordObservedDrops(work.learning,before,after,action.id);
  training?.afterAction(before,after,action);
  if(action.fields?.defensiveGoal)defensiveGoals.after(before,after,action);
  else equipmentGoals.after(before,after,action);
  if(work.economy){observeWork(before,after,action,work.economy);observeBow(before,after,action,work.economy);}
  if(after.bank?.isOpen===true)work.bankItems=after.bank.items as Json[];
  if(before.bank?.isOpen===true && after.bank?.isOpen===false){delete work.foodWithdrawalPending;if(work.foodBatch?.phase==='bank')delete work.foodBatch;}
  delete work.failures[action.id];saveWork();
}

async function runEpisode(): Promise<void> {
  if(!agency)throw new Error('AGENCY_NOT_INITIALIZED');
  await cliCall(['connect']);
  let state=stateFrom(await cliCall(['state']));
  if(existsSync(actionIntentPath)||existsSync(resolve(dataDir,'agency-memory.json'))) {
    await cliCall(['wait','2']);
    const stable=stateFrom(await cliCall(['state']));
    const recovery=recoverLegacyJournals(dataDir,{agent:character,world:process.env.CLAWSCAPE_SERVER??'clawscape'},
      {state,stable,apply:true});
    if(!recovery.ready) {
      console.error(JSON.stringify({agency:'legacy-reconciliation-required',report:resolve(dataDir,'legacy-recovery.json'),
        unresolved:recovery.entries.filter(e=>e.disposition==='unresolved').map(e=>({commandId:e.commandId,reason:e.reason}))}));
      return; // No uncertain purchase/transfer is replayed and no ordinary action is selected.
    }
    state=stable;
  }
  for(let step=0;step<steps;step++) {
    state=stateFrom(await cliCall(['state']));
    training?.observe(state);
    const safetyPending=agency.pending('safety');
    if(safetyPending) {
      const check=verifyActionOutcome(safetyPending.before,state,safetyPending.action);
      agency.record(safetyPending.commandId,state,verification(check));
      if(agency.pending('safety')){await cliCall(['wait','2']);continue;}
    }
    // Safety can preempt a goal but cannot overwrite its pending action or choose ordinary work.
    const emergency=urgentAgencyAction(state);
    if(emergency) {
      const commandId=agency.beginSafety(emergency,state,randomUUID());
      try {
        const {next,result}=await executeAgencyAction(state,emergency);
        agency.record(commandId,next,verification(verifyActionOutcome(state,next,emergency,result)));
        state=next;
      } catch(error) {
        agency.record(commandId,state,{status:'unknown',evidence:[],reason:String(error)});
      }
      continue;
    }
    const pending=agency.pending();
    if(pending) {
      const check=verifyActionOutcome(pending.before,state,pending.action);
      agency.record(pending.commandId,state,verification(check));
      if(agency.pending()) {
        console.log(JSON.stringify({agency:'reconciling',commandId:pending.commandId,reason:check.reason}));
        await cliCall(['wait','2']);continue;
      }
      if(check.verified)observeAgencyResult(pending.before,state,pending.action as Candidate);
    }
    // No legacy action candidates or synthetic per-click goals are constructed before this selection.
    const planned=agency.plan(state);
    if(!isSelection(planned)) {
      console.log(JSON.stringify({agency:planned.type,detail:planned,goal:agency.summary().goal}));
      await cliCall(['wait','3']);continue;
    }
    const options=available(await actionsForTask(state,planned.task));
    if(!options.length){agency.blocked('Selected task has no feasible current executor step: '+planned.task.id);continue;}
    const action=choose(stateKey(state),options);
    // One-item purchases use the current quoted price; no unbounded bulk purchase estimate.
    if(action.type==='shopBuy')action.fields={...action.fields,amount:1};
    const fresh=stateFrom(await cliCall(['state']));
    if(urgentAgencyAction(fresh)){state=fresh;continue;}
    if(action.fields?.trainingSite&&!training?.validateAction(fresh,action)){state=fresh;continue;}
    if(action.id.startsWith('goal-')&&!equipmentGoals.validate(fresh,action)){state=fresh;continue;}
    if(!validateMetal(fresh,action,state)||!validateBow(fresh,action,state)||!validateFishing(fresh,action,state)){state=fresh;continue;}
    state=fresh;
    const commandId=randomUUID();
    try { agency.begin(planned,action,state,commandId); }
    catch(error) { if(!agency.pending())agency.blocked('Pre-dispatch validation refused '+action.id+': '+String(error));else throw error;continue; }
    training?.beforeAction(state,action);
    try {
      const {next,result}=await executeAgencyAction(state,action);
      const check=verifyActionOutcome(state,next,action,result);
      agency.record(commandId,next,verification(check));
      if(check.verified)observeAgencyResult(state,next,action);
      appendFileSync(experiencePath,JSON.stringify({at:new Date().toISOString(),commandId,goal:planned.decision.goal.id,
        method:planned.method.id,action,outcome:verification(check)})+'\n');
      console.log(JSON.stringify({agency:'step',commandId,goal:agency.summary().goal,outcome:verification(check)}));
      state=next;
    } catch(error) {
      // A transport exception does not prove the server rejected the command.
      agency.record(commandId,state,{status:'unknown',evidence:[],reason:String(error)});
      console.error(JSON.stringify({agency:'outcome-unknown',commandId,error:String(error).slice(0,240)}));
    }
  }
  // Optional public conversation is explicitly enabled, quiet by default, and independent of goal ownership.
  if(forumEnabled&&!agency.pending()&&!agency.pending('safety')&&!urgentAgencyAction(state)){try{await syncForum(state);}catch(error){console.error(JSON.stringify({forum:'deferred',error:String(error).slice(0,160)}));}}
}

async function main(): Promise<void> {
  const releaseController = acquireController(resolve(dataDir, 'controller.lock'));
  try {
  peerMarket = new PeerMarket(resolve(root,'data/shared/market.sqlite'),character,gearCatalog,()=>Date.now(),process.env.CLAWSCAPE_SERVER??'https://clawscape.xyz');
  if (['clawscout', 'stinger', 'coincrafter', 'astra', 'featherer'].includes(character)) {
    training = new TrainingDiscovery(resolve(dataDir, 'training-knowledge.json'), character, loadCatalog(), build === 'ranged-magic', false);
  }
  const policyPath=resolve(dataDir,'agency-policy.json');
  const policy=existsSync(policyPath)?JSON.parse(readFileSync(policyPath,'utf8')):{};
  agency = new LiveAgency(resolve(dataDir,'agency-v2.json'), {agent:character,world:process.env.CLAWSCAPE_SERVER??'clawscape',revision:gearCatalog.namespace}, {
    policy:{foodTarget:Math.max(3,learnedFoodReserve(work.learning?.food)),...policy},
    supported:['food','ammunition','equipment','bank','combat','production','gathering','exploration'],
    preferences:role==='economy'?{crafting:2,gathering:1}:role==='resource'?{gathering:2}:{combat:2},
    routes:Object.entries(WORLD_ROUTES).map(([id,p])=>({id,...p,level:0,evidence:'bundled route lead; arrival not yet personally verified'})),
  });
  navigator = new Navigator({
    state: async () => stateFrom(await cliCall(['state'])),
    act: async (type, fields) => cliCall(['act', type, '--json', JSON.stringify({ ...fields, reason: 'collision-route navigation' })]),
    wait: async ticks => stateFrom(await cliCall(['wait', String(ticks)])),
  }, resolve(dataDir, 'navigation.json'));
  do {
    try {
      await runEpisode();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryInMs = Math.max(30000, intervalMs);
      console.error(JSON.stringify({ episodeError: message, retryInMs }));
      if (!forever) throw error;
      await Bun.sleep(retryInMs);
    }
    if (forever) await Bun.sleep(Math.max(1000, intervalMs));
  } while (forever);
  } finally { navigator?.close(); peerMarket?.close(); releaseController(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
