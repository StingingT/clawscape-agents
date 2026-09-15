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
import { loadBuildRules } from './agency/build-rules.ts';
import { TrainingDiscovery, trainingReadiness } from './training/discovery';
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
import { validateFishing, type FishingPreparation } from './fishing-progression';
import { beginActionIntent, finishActionIntent, loadActionIntent, type ActionIntent } from './action-intent';
import { verifyActionOutcome } from './action-outcome';
import { observeWorld, recordRouteResult } from './shared-world';
import { recoverLegacyJournals } from './agency/journal-recovery.ts';
import { LiveAgency, isSelection, type Selection, type Verification } from './agency/live-adapter.ts';
import type { Task, TaskKind, Route } from './agency/world-model.ts';
import { acquisitionActions, type AcquisitionHint } from './agency/acquisition.ts';
import { incidentalBankable } from './agency/incidental.ts';
import { loadDropIndex } from './agency/drop-leads.ts';
import { bindItems, resolveItems, MissingItem, type ItemRef } from './agency/item-intents.ts';
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
type Candidate = { itemRefs?:ItemRef[]; id: string; type: string; fields?: Json; waitTicks: number };
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
const work: { foodBatch?: FoodBatch; fishing?: FishingPreparation; economy?: EconomyMemory; resource?: { goal?: string; site?: string; lastBankAt?: number }; autonomy?: AutonomyMemory; learning?: Json & { food?: FoodExperience }; appearance?: AppearanceMemory; foodWithdrawalPending?: boolean | 'raw'; fishingToolFundingUntil?: number; fishingToolTradeAttempted?: boolean; pickpocketStreak?: number; bankReturn?: { x: number; z: number; level: number }; bankReturnReady?: boolean; bankItems?: Json[]; failures: Record<string, { until: number; count: number }> } = (() => {
  try { return { failures: {}, ...JSON.parse(readFileSync(workPath, 'utf8')) }; } catch { return { failures: {} }; }
})();

function agencyFacts(state: GameState): Record<string, number> {
  const facts: Record<string, number> = { hp: Number(state.player?.hp ?? 0), coins: coinsIn((state.inventory ?? []) as Json[]) };
  for (const skill of state.skills ?? []) facts[`skill:${String(skill.name).toLowerCase()}`] = Number(skill.level ?? skill.baseLevel ?? 0);
  return facts;
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
  if (result.error || (result.success === false && args[0]!=='act')) throw new Error(`CLI rejected ${args[1] ?? args[0]}: ${result.reason ?? ''} ${result.message ?? result.error ?? ''}`);
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
  const goal=agency?.summary().goal;
  return {objective:goal?.reason??"Observe opportunities",stage:goal?.domain??"observing",goal:goal?.id??"Choose a feasible outcome",target:goal?.target,rolePreference:role};
}
function runeMysteriesComplete(): boolean {
  try { return JSON.parse(readFileSync(resolve(dataDir, 'rune-mysteries.json'), 'utf8')).completed === true; } catch { return false; }
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

function socialVoice(): { opener:string; plan:string } {
  const goal=agency?.summary().goal;
  return {opener:'Useful lead',plan:goal?`I am working on ${goal.id}: ${goal.reason}`:'I am evaluating my next feasible goal.'};
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

function ammoCandidates(state: GameState, target = 50): Candidate[] {
  if (build !== "ranged-magic") return [];
  const inventory = state.inventory ?? [];
  const maxArrowRank = Math.min(permittedArrowRank(level(state, 'ranged')), bowArrowCap(String(state.combatStyle?.weaponName ?? '')));
  const arrows = [...inventory, ...(state.equipment ?? [])]
    .filter((item) => arrowRank(String(item.name)) > 0 && arrowRank(String(item.name)) <= maxArrowRank)
    .reduce((total, item) => total + (typeof item.count === "number" ? item.count : 1), 0);
  // Aim to restock to 50. Do not abandon a safe beginner fight until the
  // quiver is genuinely low; then ammunition takes priority over combat.
  if (arrows >= target) return [];
  const ranged = level(state, "ranged");
  const coins = (state.inventory ?? []).filter((item) => /coins/i.test(text(item.name)))
    .reduce((total, item) => total + (typeof item.count === "number" ? item.count : 1), 0);
  // Lowe's live world stock prices bronze arrows at 10 coins each. A minimum
  // reserve of 15 is enough to resume ranged training; do not force a risky
  // money-making loop merely to afford the ideal batch of 50.
  const minimumPurchaseBudget = Math.max(0, (target - arrows) * 10);
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
    const affordable = Math.min(target - arrows, Math.floor(coins / unitPrice));
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
  if (role === "economy") return agency?.summary().goal?.workingReserveGp ?? 0;
  // Stinger keeps enough for a 50-arrow bronze refill. Other fighters retain
  // a small amount for basic supplies, but bank the rest against death/loss.
  return Math.max(build === "ranged-magic" ? 500 : 250,agency?.summary().goal?.workingReserveGp ?? 0);
}

function bankingCandidates(state: GameState, task?: Task): Candidate[] {
  const inventory = state.inventory ?? [];
  const equippedNames = (state.equipment ?? []).map(item => text(item.name));
  const carriedWeapons = inventory.filter(item => /^(bronze|iron|steel|mithril|adamant|rune) (sword|scimitar|longsword|battleaxe|mace|dagger|warhammer)$/i.test(text(item.name)));
  const weaponRank = (name: string) => ({bronze:1, iron:2, steel:3, mithril:4, adamant:5, rune:6}[String(name).toLowerCase().split(' ')[0]] ?? 0);
  const keepWeaponName = carriedWeapons.sort((a,b) => weaponRank(text(b.name)) - weaponRank(text(a.name)))[0]?.name;
  const carriedArrows = inventory.filter(item => isFinishedArrow(text(item.name))).reduce((sum, item) => sum + Number(item.count ?? 1), 0);
  const equippedArrows = (state.equipment ?? []).filter(item => isFinishedArrow(text(item.name))).reduce((sum, item) => sum + Number(item.count ?? 1), 0);
  const surplusArrows = surplusArrowAmount(carriedArrows + equippedArrows);
  const foodMemory = work.learning?.food;
  const tripFood = (task?.target?.fact==='food'?task.target.minimum:undefined) ?? agency?.tripPreparation(state,task?.kind).foodTarget ?? learnedFoodReserve(foodMemory);
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
    if (incidentalBankable(item, agency?.summary().acquisition?.incidental?.ids)) return true;
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
    if (work.foodWithdrawalPending === 'raw' && inventory.some((item) => /^raw /i.test(String(item.name)))) {
      work.foodBatch = {phase: 'cook', startedAt: Date.now()}; saveWork();
      return [{ id: 'close-bank-to-cook-withdrawn-fish', type: 'closeModal', fields: { reason: 'cook the raw fish batch withdrawn from the bank' }, waitTicks: 1 }];
    }
    if (shouldCloseAfterFoodWithdrawal(work.foodWithdrawalPending === true, foodTotal>=tripFood)) {
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
  const nearFullMaterials = inventory.length >= (task?.kind==='gathering'?Number(state.capacity??28):Number(state.capacity??28)-1) && bankableItems.length > 0;
  if ((!inventoryFull || bankableItems.length === 0) && !nearFullMaterials && !urgentClutter && !excessArrowInputs && (surplusFood === 0||task?.kind==='gathering') && surplusCoins === 0 && !recoveryCash) return [];
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
  if(!selectedSkill)return [];
  const desiredSkill=selectedSkill;
  const strengthStyle = styles.find((style) => {
    const trains = Array.isArray(style.trainsSkills) ? style.trainsSkills : [];
    const normalized = trains.map((skill) => text(skill).toLowerCase());
    return normalized.length===1 && normalized[0]===desiredSkill;
  });
  if (typeof strengthStyle?.index === "number" && combatStyle?.currentStyle !== strengthStyle.index) {
    return [{ id: `style-${desiredSkill}-${strengthStyle.index}`, type: "setCombatStyle", fields: { style: strengthStyle.index }, waitTicks: 1 }];
  }
  return [];
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

function productionCandidates(state: GameState, requestedFood = false, targetFood?: number): Candidate[] {
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
  const requiredFood = targetFood ?? agency?.tripPreparation(state,'gathering').foodTarget ?? learnedFoodReserve(foodMemory);
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
  // A measured food dependency stays linked to its trip. Search a wider area instead of
  // falling back to combat or idle waiting when the reserve is exhausted.
  if (work.foodBatch?.phase === 'gather' || carriedFood < requiredFood) {
    const player = state.player ?? {};
    const distanceToDraynor = Math.hypot((Number(player.worldX) || 0) - WORLD_ROUTES.draynorFishing.x, (Number(player.worldZ) || 0) - WORLD_ROUTES.draynorFishing.z);
    if (distanceToDraynor > 8) return [{ id: "walk-to-draynor-fishing", type: "walkTo", fields: { ...WORLD_ROUTES.draynorFishing, running: true, reason: "safe level-1 food recovery" }, waitTicks: 5 }];
    return [{ id: "scan-for-draynor-fishing", type: "scanNearbyLocs", fields: { radius: 40, reason: "find fishing-spot NPC" }, waitTicks: 2 }];
  }
  return [];
}

function reward(before: GameState, after: GameState, action: Candidate): number {
  return outcomeReward(before,after,action,role,build==='ranged-magic',gearCatalog);
}

function choose(key: string, options: Candidate[]): Candidate {
  options = preferActive(options);
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

function incidentalProcessingCandidates(state:GameState):Candidate[] {
  const raw=(state.inventory??[]).find((i:any)=>/^raw\b/i.test(String(i.name??''))&&Number.isInteger(i.slot));if(!raw)return [];
  const p=state.player??{};
  const heat=(state.nearbyLocs??[]).filter((l:any)=>Number.isInteger(l.x)&&Number.isInteger(l.z)&&/^(fire|fireplace|range|stove|cooking pot)$/i.test(String(l.name??''))&&Math.max(Math.abs(Number(p.worldX)-Number(l.x)),Math.abs(Number(p.worldZ)-Number(l.z)))<=1)[0];
  return heat?[{id:`incidental-process-${raw.id}-${heat.id}`,type:'useItemOnLoc',fields:{itemSlot:raw.slot,x:heat.x,z:heat.z,locId:heat.id,reason:'process a useful incidental raw resource at a freshly observed heat source'},waitTicks:4}]:[];
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
  if(task.kind==='funds') {
    const coins=(state.inventory??[]).filter(i=>Number(i.id)===995||/^coins$/i.test(String(i.name))).reduce((n,i)=>n+Number(i.count??1),0);
    const required=Math.max(0,(task.target?.minimum??0)-coins);
    if(!required)return [];
    if(state.shop?.isOpen===true)return [{id:'close-shop-for-funding',type:'closeShop',waitTicks:1}];
    if(state.bank?.isOpen!==true)return bankAt(state);
    const row=(state.bank.items??[]).find((i:any)=>(Number(i.id)===995||/^coins$/i.test(String(i.name)))&&Number.isInteger(i.slot)&&Number(i.count)>=required);
    return row?[{id:'withdraw-planned-funds',type:'bankWithdraw',fields:{slot:row.slot,amount:required},waitTicks:2}]:[];
  }
  if(task.kind==='acquisition') {
    const result=await acquisitionActions(state,task,{bank:bankAt,route:p=>navigator!.assessApproach(position(state),p),canFight:n=>{
      const monster=training?.catalog.monsters.find(m=>m.id===n.id&&m.name.toLowerCase()===String(n.name).toLowerCase());
      return !!monster&&isApprovedNpcTarget(n)&&!trainingReadiness(state,monster,build==='ranged-magic',agency!.tripPreparation(state,'combat').foodTarget);
    }});
    if(result.reason)agency!.blocked(result.reason);
    return result.actions as Candidate[];
  }
  if (state.bank?.isOpen === true) { const transaction=bankingCandidates(state,task);return transaction.length?transaction:[{id:'close-bank',type:'closeModal',waitTicks:1}]; }
  switch(task.kind) {
    case 'food': return productionCandidates(state,true,task.target?.minimum);
    case 'ammunition': {
      const immediate=[...quiverRefill(state),...arrowProductionCandidates(state),...ammoCandidates(state,task.target?.minimum)];
      if(immediate.some(a=>['useItemOnItem','shopBuy','useInventoryItem'].includes(a.type)))return immediate;
      const inv=state.inventory??[],has=(name:RegExp)=>inv.some(i=>name.test(String(i.name)));
      // Missing ingredients become item requirements, not commands to click a remembered slot.
      const need=has(/^arrow shafts?$/i)&&!has(/^feathers?$/i)?{name:'Feather',minimum:15}
        :has(/^headless arrows?$/i)&&!has(/arrowtips?|arrowheads?/i)?{name:'Bronze arrow',minimum:Math.max(1,task.target?.minimum??15)}
        :has(/^logs$/i)&&!has(/^knife$/i)?{name:'Knife',minimum:1}:undefined;
      if(need){agency!.requestItem(need,state,'Obtain the missing ammunition input or a finished-arrow alternative for the parent objective.');return [];}
      return [...immediate,...safeAmmoSupplyCandidates(state)];
    }
    case 'bank': return bankingCandidates(state,task);
    case 'equipment': return gearCandidates(state);
    case 'combat': {
      if(!state.combatStyle?.styles?.some((s:any)=>s.trainsSkills?.some((k:string)=>k.toLowerCase()===task.skill)))return [];
      const gear=gearCandidates(state,task.skill);
      if(gear.length)return gear;
      return training ? training.next(state,(from,to)=>navigator!.assess(from,to),task.guideLeadIds,task.skill,task.foodTarget??0) : [];
    }
    case 'prayer': {
      const bone=(state.inventory??[]).find((i:any)=>i.optionsWithIndex?.some((o:any)=>/^bury$/i.test(String(o.text))));
      const option=(bone?.optionsWithIndex as Json[]|undefined)?.find(o=>/^bury$/i.test(String(o.text)));
      return bone&&option?[{id:'bury-owned-bone',type:'useInventoryItem',fields:{slot:bone.slot,optionIndex:option.opIndex},waitTicks:2}]:[];
    }
    case 'production': {
      if(task.id==='incidental-process')return incidentalProcessingCandidates(state);
      work.economy ??= {bankItems:work.bankItems??[]};
      work.economy.tripFoodTarget=task.foodTarget??0;
      selectWork(state,work.economy);
      const result=economyNext(state,work.economy,id=>!actionReady(work.failures[id]));
      saveWork(); return result;
    }
    case 'gathering': {
      if((state.inventory?.length??0)>=Number(state.capacity??28))return bankAt(state);
      return [...economyCandidates(state),...localEconomyDiscovery(state)];
    }
    case 'exploration': {
      if(!task.route)return [];
      const route=await navigator!.assessApproach(position(state),task.route);
      if(route.status==='loading-map')return [{id:'observe-map-load',type:'wait',waitTicks:2}];
      if(route.status!=='ready') {agency!.deferSurvey(task.route,state,route.reason??'No verified survey approach');return [];}
      return [{id:task.id,type:'walkTo',fields:{...route.destination,running:true,reason:task.route.evidence},waitTicks:2}];
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
  return {status:value.interrupted?'interrupted':value.verified?'verified':value.uncertain?'unknown':'rejected',evidence:value.evidence,reason:value.reason};
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
  if(result.accepted===false||result.phase==='rejected'||result.success===false&&result.reason==='action_in_progress')return {next:state,result};
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
    agency.catalogue(state);
    const safetyPending=agency.pending('safety');
    if(safetyPending) {
      const check=verifyActionOutcome(safetyPending.before,state,safetyPending.action,safetyPending.execution);
      agency.record(safetyPending.commandId,state,check.uncertain?(agency.settleStep(safetyPending.commandId,state)??verification(check)):verification(check));
      if(agency.pending('safety')){await cliCall(['wait','2']);continue;}
    }
    // Safety can preempt a goal but cannot overwrite its pending action or choose ordinary work.
    const emergency=urgentAgencyAction(state);
    if(emergency) {
      const commandId=agency.beginSafety(emergency,state,randomUUID());
      try {
        const {next,result}=await executeAgencyAction(state,emergency);
        agency.rememberExecution(commandId,result);
        agency.record(commandId,next,verification(verifyActionOutcome(state,next,emergency,result)));
        state=next;
      } catch(error) {
        agency.record(commandId,state,{status:'unknown',evidence:[],reason:String(error)});
      }
      continue;
    }
    const pending=agency.pending();
    if(pending) {
      const check=verifyActionOutcome(pending.before,state,pending.action,pending.execution);
      agency.record(pending.commandId,state,check.uncertain?(agency.settleStep(pending.commandId,state)??verification(check)):verification(check));
      if(agency.pending()) {
        console.log(JSON.stringify({agency:'reconciling',commandId:pending.commandId,reason:check.reason,operation:pending.action.type,action:pending.action,startedAt:pending.startedAt,source:'agency-v2.json'}));
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
    training?.beginTrial?.(state,planned.decision.goal);
    const committedRoute=agency.routeStep(planned,state);
    const options=available(committedRoute?[committedRoute as Candidate]:await actionsForTask(state,planned.task)).filter(a=>agency!.eligible(a,state));
    if(!options.length){if(!agency.summary().blocked && !agency.summary().acquisition?.need)agency.blocked('Selected task has no feasible current executor step: '+planned.task.id);await cliCall(['wait','2']);continue;}
    let action:Candidate;
    try {
      const candidate=choose(stateKey(state),options);
      action=bindItems(candidate.type==='shopBuy'?{...candidate,fields:{...candidate.fields,amount:1}}:candidate,state);
    }
    catch(error){agency.blocked('Invalid item candidate: '+String(error));continue;}
    // One-item purchases use the current quoted price; no unbounded bulk purchase estimate.
    if(action.type==='shopBuy')action.fields={...action.fields,amount:1};
    const fresh=stateFrom(await cliCall(['state']));
    if(urgentAgencyAction(fresh)){state=fresh;continue;}
    try{action=resolveItems(action,fresh);}
    catch(error){
      if(error instanceof MissingItem)agency.requestItem(error.need,fresh,'Required input disappeared before dispatch; find an acquisition method.');
      else agency.blocked('Fresh item validation: '+String(error));
      state=fresh;continue;
    }
    if(action.fields?.trainingSite&&!training?.validateAction(fresh,action)){state=fresh;continue;}
    if(action.id.startsWith('goal-')&&!equipmentGoals.validate(fresh,action)){state=fresh;continue;}
    if(!validateMetal(fresh,action,state)||!validateBow(fresh,action,state)||!validateFishing(fresh,action,state)){state=fresh;continue;}
    state=fresh;
    if(agency.prepareFunding(action,state))continue;
    const commandId=randomUUID();
    try { agency.begin(planned,action,state,commandId); }
    catch(error) { if(!agency.pending())agency.blocked('Pre-dispatch validation refused '+action.id+': '+String(error));else throw error;continue; }
    training?.beforeAction(state,action);
    try {
      const {next,result}=await executeAgencyAction(state,action);
      agency.rememberExecution(commandId,result);
      const check=verifyActionOutcome(state,next,action,result);
      agency.record(commandId,next,verification(check));
      if(check.verified)observeAgencyResult(state,next,action);
      appendFileSync(experiencePath,JSON.stringify({at:new Date().toISOString(),commandId,goal:planned.decision.goal.id,
        method:planned.method.id,action,outcome:verification(check)})+'\n');
      console.log(JSON.stringify({agency:'step',commandId,goal:planned.decision.goal.id,supportGoal:planned.decision.step.supportGoalId,method:planned.method.id,action:action.type,outcome:verification(check)}));
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
    policy,
    supported:['food','ammunition','equipment','bank','combat','production','gathering','exploration','funds','prayer','acquisition'],
    developmentHint:build,
    dropLeads:loadDropIndex(existsSync(resolve(root,'data/shared/drop-leads.json'))?resolve(root,'data/shared/drop-leads.json'):resolve(root,'knowledge/2004scape-drop-leads.json')),
    acquisitionHints:[
      {key:'bundled-knife',kind:'ground',item:{name:'Knife',minimum:1},position:{...WORLD_ROUTES.lumbridgeKnife,level:0},confidence:'unverified',evidence:'existing bundled ground-knife lead; must observe item before pickup'},
      {key:'bundled-logs',kind:'gather',item:{name:'Logs',minimum:1},position:{...WORLD_ROUTES.lumbridgeTrees,level:0},confidence:'unverified',evidence:'existing bundled tree approach; must observe resource and tool'},
      {key:'bundled-arrow-shop',kind:'shop',item:{name:'Bronze arrow',minimum:1},entityName:'Lowe',position:{...WORLD_ROUTES.lowesArchery,level:0},confidence:'unverified',evidence:'existing bundled archery-shop lead; current stock and price required'},
      {key:'bundled-feather-shop',kind:'shop',item:{name:'Feather',minimum:1},entityName:'Gerrant',position:{...WORLD_ROUTES.gerrantsFishingShop,level:0},confidence:'unverified',evidence:'investigate the existing fishing-shop lead for bait/materials; stock unknown'},
      ...(training?.catalog.sites??[]).map(site=>({key:'catalogue:'+site.id,kind:'drop' as const,item:{name:'unknown',minimum:1},entityName:site.monster.name,entityId:site.monster.id,
        position:site.points[0]!,confidence:'unverified' as const,evidence:site.source+'; source spawn is not proof of a drop'})),
    ],
    buildRules:loadBuildRules(resolve(dataDir,'build-rules.json'),{world:process.env.CLAWSCAPE_SERVER??'clawscape',revision:gearCatalog.namespace}),
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
