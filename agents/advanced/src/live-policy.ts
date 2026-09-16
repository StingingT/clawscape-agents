import {agencyCandidate,agencyState} from './agency-bridge.ts';
import {transitionEvidence} from '../../../src/agency/discovery.ts';
import { z } from "zod";
import type { Task } from "../../../src/agency/world-model.ts";
import { Observation, Tile, Intent, type ActionResult } from "./contracts.ts";

export type LiveDecision = {
  goal: string; reason: string; intent?: Intent; destination?: Tile; wait?: boolean; blocked?: string;
};

type Item = Observation["inventory"][number];
type Entity = Observation["entities"][number];
type Skill = "attack" | "strength" | "defence";
const normalize = (s: string) => s.replace(/<[^>]*>/g, "").trim().toLowerCase().replace(/\s+/g, " ");
const option = (e: { options: { index: number; text: string }[] }, pattern: RegExp) =>
  [...e.options].sort((a, b) => a.index - b.index).find(p => pattern.test(normalize(p.text)));
const count = (items: Item[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const distance = (a: Tile, b: Tile) => a.plane === b.plane ? Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) : Infinity;
const block = (goal: string, blocked: string, reason: string): LiveDecision => ({ goal, blocked, reason });
const skillLevel = (o: Observation, name: string, base = false) => {
  const s = o.skills.find(s => normalize(s.name).replace("defense", "defence") === name);
  return s ? (base ? s.base : Math.min(s.current, s.base)) : null;
};
const foodHealing: Record<string, number> = {
  shrimps: 3, shrimp: 3, anchovies: 1, sardine: 4, herring: 5, trout: 7, pike: 8,
  salmon: 9, tuna: 10, lobster: 12, bread: 5, "cooked chicken": 3, "cooked meat": 3,
};
const rawLevels: Record<string, number> = {
  "raw shrimps": 1, "raw shrimp": 1, "raw anchovies": 1, "raw sardine": 1,
  "raw herring": 5, "raw trout": 15, "raw pike": 20, "raw salmon": 25,
  "raw tuna": 30, "raw lobster": 40, "raw chicken": 1, "raw beef": 1, "raw rat meat": 1,
};
const healing = (i: { name: string }) => foodHealing[normalize(i.name)] ?? 0;
const raw = (i: { name: string }) => Object.hasOwn(rawLevels, normalize(i.name));
const food = (o: Observation) => o.inventory.filter(i => i.count > 0 && healing(i) > 0 && option(i, /^eat$/));
const foodCount = (o: Observation) => food(o).reduce((n, i) => n + i.count, 0);
const reserve = (o: Observation) => food(o).reduce((n, i) => n + i.count * healing(i), 0);

const freeSlots = (o: Observation) => o.capacity === null ? null : o.capacity - new Set(o.inventory.filter(i => i.count > 0).map(i => i.slot)).size;
const tool = (i: { name: string }) => /^(small fishing net|tinderbox|(?:bronze|iron|steel|black|mithril|adamant|rune) (?:axe|hatchet))$/.test(normalize(i.name));
const supplyItem = (i: { name: string }) => tool(i) || healing(i) > 0 || raw(i) || /^(logs|feather|feathers|fishing bait|coins)$/.test(normalize(i.name));
// An allowlist makes unfamiliar/quest items protected even if the observer has no quest journal.
const depositable = (i: Item) => !i.protected && !supplyItem(i);
const canDeposit = (o: Observation, i: Item) => depositable(i) && !o.equipment.some(e => e.id === i.id);
const lootAllowed = (e: Entity) => e.kind === 'ground_item' && e.reachable === true;
// SDK ground piles omit menu options; a filtered visible, reachable pile is the
// normal pickup capability. If options ARE supplied, honour that narrower menu.
const pickupAvailable = (e: Entity) => !!option(e, /^(take|pick-up|pick up)$/)
  || (e.options.length === 0 && e.reachable === true);
const bankOption = (e: Entity) => option(e, e.kind === "object" && normalize(e.name) === "bank booth"
  ? /^(bank|use-bank|use bank|use-quickly)$/ : /^(bank|use-bank|use bank)$/);
const transitionOption = (e: Entity) => /chest|coffin|altar|lever|toll|locked|wilderness/i.test(e.name)?undefined:option(e, /^(open|close|climb(?:[ -]up|[ -]down)?)$/);

// Conservative policy ceilings, NOT deployed-server measurements. Exact low-level variants only.
// Modern public guides are dated hints; the main supervisor/profile must validate compatibility.
const encounters: Record<string, { levels: number[]; hp: number; maxHit: number }> = {
  rat: { levels: [1], hp: 2, maxHit: 1 },
  chicken: { levels: [1], hp: 3, maxHit: 1 },
  goblin: { levels: [2], hp: 5, maxHit: 2 },
  cow: { levels: [2], hp: 8, maxHit: 2 },
};
function encounter(e: Entity) {
  const spec = encounters[normalize(e.name)];
  return spec && e.kind === "npc" && e.combat_level != null && spec.levels.includes(e.combat_level)
    && (e.max_hp == null || (e.max_hp > 0 && e.max_hp <= spec.hp))
    && (e.hp == null || (e.hp > 0 && e.hp <= (e.max_hp ?? spec.hp)))
    && option(e, /^attack$/) ? spec : null;
}
const identity = (o: Observation) => JSON.stringify([o.character, o.world, o.profile_id, o.session_id, o.world_epoch, o.life_id, o.respawns]);
const entityKey = (e: Entity) => JSON.stringify([e.kind, e.content_id, e.index,
  ...(e.kind === "npc" ? [] : [e.position.x, e.position.z, e.position.plane])]);
const sameEntity = (o: Observation, e: Entity) => o.entities.find(n => entityKey(n) === entityKey(e));
const target = (o: Observation) => o.activity?.target_type === "npc"
  ? o.entities.find(e => e.kind === "npc" && e.index === o.activity!.target_index) : undefined;
const fighting = (o: Observation) => {
  const e = target(o);
  return e && e.hp !== 0 && option(e, /^attack$/) ? e : undefined;
};
const ownKillSignal = (before:Observation, after:Observation, active:{index:number;contentId:number;startTick:number|null;clearedAt?:number;clearedTick?:number|null}) => {
  const prior=before.entities.find(e=>e.kind==='npc'&&e.index===active.index&&e.content_id===active.contentId);
  const now=after.entities.find(e=>e.kind==='npc'&&e.index===active.index&&e.content_id===active.contentId);
  const xpGain=meleeXp(after)>meleeXp(before);
  const targetCleared=before.activity?.target_type==='npc'&&before.activity.target_index===active.index&&after.activity?.target_index!==active.index;
  const npcGone=!!prior&&!now;
  const recent=active.startTick===null||after.tick===null||after.tick-active.startTick<=200;
  return recent&&xpGain&&targetCleared&&npcGone;
};
const xp = (o: Observation, names: string[]) => o.skills.filter(s => names.includes(normalize(s.name))).reduce((n, s) => n + s.xp, 0);
const inventoryMark = (o: Observation, predicate: (i: Item) => boolean) =>
  JSON.stringify(o.inventory.filter(predicate).map(i => [i.id, i.count]).sort((a, b) => a[0]! - b[0]!));
const meleeXp = (o: Observation) => xp(o, ["attack", "strength", "defence"]);
const foodTotal = (o: Observation) => o.inventory.filter(i => healing(i) > 0).reduce((n, i) => n + i.count, 0);
const encounterContext = (o: Observation, e: Entity) => JSON.stringify([o.world, o.profile_id, normalize(e.name), e.content_id, e.combat_level,
  ["attack", "strength", "defence"].map(n => Math.floor((skillLevel(o, n, true) ?? 0) / 10)),
  o.equipment.map(i => [i.slot, i.id]).sort((a, b) => a[0]! - b[0]!),
  o.position?.plane, Math.floor((o.position?.x ?? 0) / 64), Math.floor((o.position?.z ?? 0) / 64)]);
const SampleSchema = z.strictObject({ id: z.string(), status: z.enum(["CONFIRMED_KILL", "COMPLETED_UNCERTAIN", "INTERRUPTED"]),
  reason: z.string(), elapsedMs: z.number().nonnegative(), xp: z.number().nonnegative(), damage: z.number().nonnegative(), food: z.number().nonnegative() });
type Sample = z.infer<typeof SampleSchema>;
const LearningSchema = z.strictObject({
  active: z.strictObject({ id: z.string(), context: z.string(), identity: z.string(), enemy: z.string(), index: z.number(),
    name: z.string(), contentId: z.number(), startAt: z.number(), startTick: z.number().nullable(),
    lastAt: z.number(), lastSeq: z.number(), lastXp: z.number(), lastHp: z.number().nullable(), lastFood: z.number(),
    xp: z.number(), damage: z.number(), food: z.number(), ownPlayerIndex: z.number().nullable(), clearedAt:z.number().optional(), clearedTick:z.number().nullable().optional() }).nullable(),
  methods: z.array(z.strictObject({ context: z.string(), name: z.string(), contentId: z.number(), n: z.number(),
    confirmed: z.number(), uncertain: z.number(), interrupted: z.number(), elapsedMs: z.number(), xp: z.number(), damage: z.number(), food: z.number(),
    samples: z.array(SampleSchema).max(20) })).max(2048),
  closed: z.array(z.string()).max(2048), selection: z.string().nullable(),
  lastObservation: z.strictObject({ identity: z.string(), seq: z.number(), at: z.number() }).nullable().default(null),
});

const DecisionSchema = z.strictObject({ goal: z.string(), reason: z.string(), intent: Intent.optional(),
  destination: Tile.optional(), wait: z.boolean().optional(), blocked: z.string().optional() });
const StateSchema = z.strictObject({
  version: z.literal("astra-live-policy-v1"), identity: z.string().nullable(),
  tutorial: z.strictObject({ active: z.boolean(), done: z.boolean(), steps: z.number().int().nonnegative() }),
  production: z.strictObject({ itemId: z.number(), steps: z.number() }).nullable().default(null),
  combat: z.strictObject({ enemy: z.string(), startingXp: z.number() }).nullable().default(null),
  trip: z.strictObject({ phase: z.enum(["bank", "return"]), returnTo: Tile, initialized: z.boolean(),
    remaining: z.array(z.strictObject({ id: z.number().int().nonnegative(), count: z.number().int().nonnegative() })).max(256) }).nullable(),
  bankLead: Tile.nullable(),
  stalls: z.record(z.string(), z.number().int().nonnegative()),
  watch: z.strictObject({ key: z.string(), marker: z.string(), seq: z.number(), unchanged: z.number(),
    observations: z.number(), history: z.array(z.string()).max(4), startedAt: z.number().default(0),
    progressAt: z.number().default(0), progressTick: z.number().nullable().default(null) }).nullable(),
  uncertain: z.strictObject({ before: Observation, decision: DecisionSchema }).nullable(),
  unknown: z.array(z.strictObject({ name: z.string(), contentId: z.number(), level: z.number().nullable(), maxHp: z.number().nullable() })).max(64),
  counters: z.strictObject({ outcomes: z.number(), effects: z.number(), noEffects: z.number(), failures: z.number(),
    encountersStarted: z.number().default(0), encountersCompleted: z.number().default(0), gatheredItems: z.number().default(0) }),
  lastOutcome: z.string().nullable(), quarantine: z.string().nullable(),
  resolved: z.array(z.string()).max(2048).default([]),
  learning: LearningSchema.default({ active: null, methods: [], closed: [], selection: null, lastObservation: null }),
  research: z.strictObject({ names: z.array(z.string()).max(4), evidenceRefs: z.array(z.string()).max(16),
    status: z.literal("UNVERIFIED_LEADS"), recordedOn: z.string() }).default({ names: [], evidenceRefs: [], status: "UNVERIFIED_LEADS", recordedOn: "2026-09-08" }),
  scouting: z.array(z.string()).max(3).default([]),
});
type State = z.infer<typeof StateSchema>;
const initial = (): State => ({ version: "astra-live-policy-v1", identity: null,
  tutorial: { active: false, done: false, steps: 0 }, production: null, combat: null, trip: null, bankLead: null, stalls: {}, watch: null,
  uncertain: null, unknown: [], counters: { outcomes: 0, effects: 0, noEffects: 0, failures: 0, encountersStarted: 0, encountersCompleted: 0, gatheredItems: 0 }, lastOutcome: null, quarantine: null, resolved: [],
  learning: { active: null, methods: [], closed: [], selection: null, lastObservation: null },
  research: { names: [], evidenceRefs: [], status: "UNVERIFIED_LEADS", recordedOn: "2026-09-08" }, scouting: [] });

/** Pure with respect to the outside world: no I/O, timers, SDK, auth, or dispatch.
 * Stateful only for bounded behaviours/evidence. Persist summary(); refresh/reconcile
 * through the main arbiter before calling next again after an action proposal. */
export class LivePolicy {
  private tripFoodTarget=0;
  private supplied(o:Observation){return foodCount(o)>=this.tripFoodTarget;}
  private reserveGoal(o:Observation){return this.tripFoodTarget * (food(o).length?Math.min(...food(o).map(healing)):3);}
  private state: State;
  constructor(persisted?: unknown) {
    const candidate = persisted && typeof persisted === "object" && "state" in persisted ? persisted.state : persisted;
    this.state = candidate === undefined ? initial() : StateSchema.parse(candidate);
  }

  next(o: Observation, task?: Task): LiveDecision {
    if(task)this.tripFoodTarget=Math.max(0,task.kind==='food'?task.target?.minimum??task.foodTarget??0:task.foodTarget??0);
    if (!o.connected) return block("observe", "DISCONNECTED", "A connected player observation is required.");
    if (o.fresh_at === null || o.observed_at < o.fresh_at || o.observed_at - o.fresh_at > 5000)
      return block("observe", "STALE_OBSERVATION", "Require a fresh advancing observation; the arbiter also checks wall-clock age.");
    if (this.state.identity === null) this.state.identity = identity(o);
    if (this.state.identity !== identity(o)) return block("recover", "STATE_CONTEXT_CHANGED", "Session, life, world or profile changed; reconcile and reinitialize the policy.");
    if (!o.position || o.hp === null || o.max_hp === null || o.max_hp < 1 || o.hp > o.max_hp)
      return block("observe", "MISSING_PLAYER_STATE", "Position and usable health observations are required.");
    if (o.hp === 0) return block("recover", "DEATH_RECOVERY_UNSUPPORTED", "Death recovery needs the main supervisor; no route is assumed safe.");
    this.remember(o);
    if (this.state.uncertain) {
      const pending = this.state.uncertain;
      if (!this.effect(pending.before, o, pending.decision))
        return block(pending.decision.goal, "OUTCOME_UNCONFIRMED", "Reconcile the pending item/action outcome before another proposal; never replay it blindly.");
      this.applyEffect(pending.before, o, pending.decision);
      this.state.resolved = [...this.state.resolved, this.outcomeKey(pending.before, pending.decision)].slice(-128);
      this.state.uncertain = null;
      this.state.stalls[this.key(pending.before, pending.decision)] = 0;
      this.state.counters.effects++;
    }
    const engaged = fighting(o), threat = engaged && encounter(engaged);
    const margin = Math.max(o.danger.damage_margin ?? 0, 3 * (threat?.maxHit ?? 2) + 1);
    if (o.hp < o.max_hp && o.hp <= Math.max(Math.ceil(o.max_hp * 0.7), margin)) {
      const meal = food(o).sort((a, b) => healing(b) - healing(a) || a.slot - b.slot)[0];
      if (meal && (o.bank.open || o.shop_open || o.dialog.open || o.activity?.modal_open))
        return this.finish(o, { goal: "heal:close-interface", reason: "Close the observed blocking interface so the next observation can authorize eating.", intent: { operation: "close_interface" } });
      if (meal) return this.finish(o, { goal: "heal", reason: "Eat early using the observed Eat option and a conservative damage reserve.",
        intent: { operation: "eat", slot: meal.slot, item_id: meal.id } });
      if (engaged || o.danger.active === true) return block("recover", "LOW_HP_NO_FOOD", "No edible food; require a supervisor-validated escape, not a bank detour.");
    }
    if (this.state.quarantine) return block("recover", "ENCOUNTER_COMPATIBILITY_MISMATCH", this.state.quarantine);
    const continueOptions = o.dialog.options.filter(p => /^(continue|click (?:here )?to continue)[.!]?$/.test(normalize(p.text)));
    if (o.dialog.open && /\bcongratulations\b.*\badvanced\b.*\blevel\b/.test(normalize(o.dialog.text))
      && /\b(attack|strength|defence|defense|hitpoints|fishing|cooking|woodcutting|firemaking)\b/.test(normalize(o.dialog.text))
      && continueOptions.length === 1 && o.dialog.options.length === 1 && o.danger.active !== true) {
      return this.finish(o, o.dialog.waiting ? { goal: "level-up", reason: "Wait for the observed level-up notice to accept input.", wait: true }
        : { goal: "level-up", reason: "Dismiss the genuine skill level-up notice through its single published Continue option.", intent: { operation: "dialogue", option_index: continueOptions[0]!.index } });
    }
    if (engaged) {
      if (!threat) return block("recover", "UNKNOWN_ENGAGED_THREAT", "An unfamiliar or insufficiently observed attacker requires the supervisor.");
      return this.finish(o, { goal: "combat:engaged", reason: "Keep the observed fight engaged; defer equipment, style, loot, banking and supplies.", wait: true });
    }
    if (o.danger.active === true || o.activity?.target_type === "player")
      return block("recover", "UNRESOLVED_THREAT", "Do not start another action while a threat lacks an observed safe response.");
    if (this.state.learning.active?.clearedAt!==undefined)
      return this.finish(o,{goal:"combat:verify-ended",reason:"Briefly observe target-specific kill evidence; XP is not a kill receipt.",wait:true});
    if (!o.activity) return block("observe", "ACTIVITY_UNAVAILABLE", "Combat/interaction activity is required to avoid interrupting an unseen fight.");
    if (o.activity.target_type === "npc" && !target(o))
      return block("observe", "TARGET_NOT_OBSERVED", "The active NPC target is absent; reobserve before changing activities.");
    const tutorial = this.tutorial(o);
    if (tutorial) return this.finish(o, tutorial);
    if (this.state.production) {
      if (!o.dialog.open && !o.dialog.waiting) this.state.production = null;
      else {
        if (o.dialog.waiting) return this.finish(o, { goal: "supply:cook-dialogue", reason: "Wait for the observed production interface to accept input.", wait: true });
        const cook = option(o.dialog, /^cook (?:1|one|all)$/);
        if (!cook || this.state.production.steps >= 12) return block("supply:cook-dialogue", "UNSUPPORTED_DIALOGUE", "The bounded cooking dialogue has no supported Cook 1/One/All option or exhausted its budget.");
        return this.finish(o, { goal: "supply:cook-dialogue", reason: "Choose only the published cooking option following our observed raw-food action.", intent: { operation: "dialogue", option_index: cook.index } });
      }
    }
    if (o.dialog.open || o.dialog.waiting) return block("dialogue", "UNSUPPORTED_DIALOGUE", "Only the observed RuneScape Guide Yes/Continue flow is supported; quest/dialogue solving is out of scope.");
    if (o.shop_open) return this.finish(o, { goal: "close-shop", reason: "No spending/selling budget is configured.", intent: { operation: "close_interface" } });
    if (o.unavailable.includes("inventory") || o.unavailable.includes("equipment") || freeSlots(o) === null)
      return block("observe", "MISSING_INVENTORY_STATE", "Require inventory, capacity and equipment observations.");
    if(task&&['discovery','exploration'].includes(task.kind)) {
      this.state.trip=null; // An obsolete local banking routine cannot replace the selected goal.
      if(o.bank.open)return this.finish(o,{goal:task.id,reason:'Close the bank before the selected exploration action.',intent:{operation:'close_interface'}});
    }
    if (this.state.trip || o.bank.open) return this.finish(o, this.banking(o));
    if (o.activity.modal_open) return block("interface", "UNSUPPORTED_MODAL", "The open modal is not an observed bank, shop or supported tutorial.");
    const rawItem = o.inventory.find(i => i.count > 0 && raw(i));
    // Cook usable raw supplies even in a full inventory; converting them needs no new slot.
    if (freeSlots(o)! <= 0 && !(task&&['discovery','exploration'].includes(task.kind)) && !(rawItem && !this.supplied(o))) return this.finish(o, this.startBank(o));
    // Strategic ownership: the Director has chosen the outcome before this
    // executor is asked for an action. No fallback to an unrelated activity.
    if (task) {
      switch (task.kind) {
        case 'food': return this.finish(o, this.supplied(o)
          ? {goal:task.id,reason:'Food reserve observed; Director will review the actual predicate.',wait:true}
          : this.supply(o));
        case 'bank': return this.finish(o, this.startBank(o));
        case 'equipment': return this.finish(o, this.equip(o) ?? {goal:task.id,reason:'Owned kit is equipped.',wait:true});
        case 'combat': {
          if (!this.supplied(o)) return this.finish(o, this.supply(o));
          const gear = this.equip(o);
          return this.finish(o, gear ?? this.training(o, task.skill));
        }
        case 'exploration':
          if (!task.route) return block(task.id, 'NO_SOURCED_ROUTE', 'No personal observation or documented lead supports this route.');
          return this.finish(o, {goal:task.id,reason:task.route.evidence,
            destination:{x:task.route.x,z:task.route.z,plane:task.route.level}});
        case 'discovery':
          if(task.localProbe&&task.route)return this.finish(o,{goal:task.id,reason:'Collision-validated local information probe',destination:{x:task.route.x,z:task.route.z,plane:task.route.level}});
          return this.localDiscovery(o, task.id);
        default: return block(task.id, 'UNSUPPORTED_TASK_EXECUTOR', 'This controller does not implement the selected capability.');
      }
    }
    // Owner-approved local beginner trial: a healthy, equipped Astra can
    // learn from a nearby level-2 goblin before a full food-production chain.
    // Existing encounter tracking and early health interruption still apply.
    const localGoblin = o.entities.some(e => normalize(e.name)==='goblin' && encounter(e) && e.reachable===true && e.in_combat===false && distance(o.position!,e.position)<=12);
    if (!rawItem && localGoblin && o.hp>=9 && o.hp>=o.max_hp*.9) {
      const gear=this.equip(o);
      if(gear)return this.finish(o,gear);
      return this.finish(o,this.training(o));
    }
    if (!this.supplied(o) || rawItem) return this.finish(o, this.supply(o));
    if (o.hp <= Math.max(Math.ceil(o.max_hp * 0.7), margin))
      return block("recover", "INSUFFICIENT_HEALTH_MARGIN", "Maximum/current health cannot cover the conservative encounter margin.");
    const equipment = this.equip(o);
    if (equipment) return this.finish(o, equipment);
    const loot = this.nearest(o, e => e.kind === "ground_item" && lootAllowed(e) && pickupAvailable(e));
    if (loot && freeSlots(o)! > 2 && distance(o.position, loot.position) <= 3)
      return this.finish(o, this.entityAction(o, loot, "loot", { operation: "pickup", entity_ref: loot.ref }));
    const training = this.training(o);
    return this.finish(o, training);
  }

  /** Clear only the duplicate policy checkpoint of an exact reconciled command.
   * The caller must have settled the arbiter journal first. No historical effect,
   * XP, reward, or success is inferred from current quiescence. */
  retireReconciledOutcome(before:Observation, intent:Intent, result:ActionResult):boolean {
    const pending=this.state.uncertain;
    if(!pending||result.status!=='CANCELLED'||!result.evidence.length
      ||!['RECONCILED_TRANSIENT_INTERRUPTED','RECONCILED_DIALOGUE_CONTEXT_EXPIRED'].includes(result.reason)
      ||identity(before)!==identity(pending.before)||before.seq!==pending.before.seq
      ||JSON.stringify(intent)!==JSON.stringify(pending.decision.intent))return false;
    this.state.resolved=[...this.state.resolved,this.outcomeKey(pending.before,pending.decision)].slice(-128);
    const key=this.key(pending.before,pending.decision);
    this.state.stalls[key]=Math.min(3,(this.state.stalls[key]??0)+1);
    this.state.uncertain=null;
    return true;
  }

  recordOutcome(before: Observation, after: Observation, decision: LiveDecision, status: string): void {
    if (decision.blocked) return;
    const actionKey = this.outcomeKey(before, decision);
    if (this.state.resolved.includes(actionKey)) return;
    const signature = JSON.stringify([actionKey, status, after.seq]);
    if (signature === this.state.lastOutcome) return;
    this.state.lastOutcome = signature;
    if (this.state.identity === null) this.state.identity = identity(before);
    if (identity(before) !== this.state.identity || identity(after) !== this.state.identity || after.seq <= before.seq) {
      if (decision.intent) this.state.uncertain = { before: structuredClone(before), decision: structuredClone(decision) };
      return;
    }
    this.state.counters.outcomes++;
    const key = this.key(before, decision);
    const intent = decision.intent;
    const attacked = intent?.operation === "interact" ? before.entities.find(e => e.ref === intent.entity_ref
      && e.options.some(p => p.index === intent.option_index && normalize(p.text) === "attack")) : undefined;
    if (attacked && encounter(attacked) && (target(after)?.index === attacked.index || meleeXp(after) > meleeXp(before))) this.beginEncounter(before, attacked);
    this.observe(before, after);
    if (attacked && target(after) && entityKey(target(after)!) === entityKey(attacked) && encounter(attacked)) {
      if (!this.state.combat) {
        this.state.combat = { enemy: entityKey(attacked), startingXp: xp(before, ["attack", "strength", "defence"]) };
      }
      // Target lock starts the bounded fight observer; it is not damage, XP or a kill.
      if (!this.effect(before, after, decision)) {
        this.state.resolved = [...this.state.resolved, actionKey].slice(-128);
        return;
      }
    }
    const effect = this.effect(before, after, decision);
    if (effect) {
      this.state.resolved = [...this.state.resolved, actionKey].slice(-128);
      this.state.counters.effects++;
      this.state.stalls[key] = 0;
      this.applyEffect(before, after, decision);
      if (this.state.uncertain && this.key(this.state.uncertain.before, this.state.uncertain.decision) === key) this.state.uncertain = null;
    } else {
      this.state.counters.noEffects++;
      if (!decision.wait && !decision.destination) this.state.stalls[key] = Math.min(3, (this.state.stalls[key] ?? 0) + 1);
      if (decision.intent && !/^(REJECTED|CANCELLED|EXPIRED)$/.test(status) && (status !== "FAILED"
        || ["deposit", "withdraw", "eat", "use_on_object", "use_on_item", "pickup"].includes(decision.intent.operation))) {
        this.state.uncertain = { before: structuredClone(before), decision: structuredClone(decision) };
      }
    }
    if (/^(FAILED|REJECTED|CANCELLED|EXPIRED)$/.test(status)) this.state.counters.failures++;
    const enemy = fighting(before), spec = enemy && encounter(enemy);
    if (spec && before.hp !== null && after.hp !== null && before.hp - after.hp > 3 * spec.maxHit)
      this.state.quarantine = "Observed damage exceeded the conservative three-hit observation budget; encounter assumptions require review.";
    // Keep memory bounded; saturated entries are retained so changing refs cannot evade a block.
    if (Object.keys(this.state.stalls).length > 256) {
      for (const k of Object.keys(this.state.stalls)) if (this.state.stalls[k] === 0) delete this.state.stalls[k];
      if (Object.keys(this.state.stalls).length > 256) this.state.quarantine = "Outcome failure memory is full; review repeated failures before continuing.";
    }
  }

  summary(): unknown {
    return { state: structuredClone(this.state), objectiveSource:'Director-selected outcome tasks; no fixed level quotas', evidence: "PURE_POLICY_OBSERVATION_TESTS_NOT_LIVE_GAMEPLAY" };
  }

  /** Research can suggest names, never grant capabilities, prices, IDs or routes. */
  setResearchHints(names: string[], evidenceRefs: string[]): void {
    this.state.research = { names: [...new Set(names.map(normalize).filter(n => Object.hasOwn(encounters, n)))].slice(0, 4),
      evidenceRefs: [...new Set(evidenceRefs.filter(r => typeof r === "string" && r.length > 0 && r.length <= 2048))].slice(0, 16),
      status: "UNVERIFIED_LEADS", recordedOn: "2026-09-08" };
  }

  /** Call for each fresh observation pair, including action endpoints and waits.
   * Replayed pairs and already-closed encounters do not create duplicate samples. */
  observe(before: Observation, after: Observation): void {
    if (after.seq <= before.seq || after.observed_at <= before.observed_at) return;
    let active = this.state.learning.active;
    const last = this.state.learning.lastObservation;
    if (!active && last?.identity === identity(after) && after.seq <= last.seq && after.observed_at <= last.at) return;
    this.state.learning.lastObservation = { identity: identity(after), seq: after.seq, at: after.observed_at };
    if (active && identity(after) !== active.identity) {
      this.endEncounter("INTERRUPTED", "Session, life, world or profile changed."); return;
    }
    if (!active && identity(before) === identity(after)) {
      const e = fighting(before) ?? fighting(after);
      if (e && encounter(e)) this.beginEncounter(before, e);
      active = this.state.learning.active;
    }
    if (!active || after.seq <= active.lastSeq || after.observed_at <= active.lastAt) return;
    const replacement=after.entities.find(e=>e.kind==='npc'&&e.index===active!.index&&e.content_id!==active!.contentId);
    const otherTarget=after.activity?.target_type==='npc'&&after.activity.target_index!==active.index;
    if(replacement||otherTarget){this.endEncounter("INTERRUPTED","Encounter identity changed; do not attribute another target's XP or kill.");return;}
    const priorXp = active.lastXp, gain = Math.max(0, meleeXp(after) - priorXp);
    active.xp += gain;
    active.damage += active.lastHp !== null && after.hp !== null ? Math.max(0, active.lastHp - after.hp) : 0;
    active.food += Math.max(0, active.lastFood - foodTotal(after));
    active.lastXp = meleeXp(after); active.lastHp = after.hp; active.lastFood = foodTotal(after);
    active.lastAt = after.observed_at; active.lastSeq = after.seq;
    const events = (after.activity?.events ?? []).filter(e => active!.startTick !== null && e.tick > active!.startTick!
      && e.tick <= (after.tick ?? -1));
    // damage_dealt is the SDK's own-player event. Corroborate with player XP;
    // do not treat an arbitrary source_type=player kill as self-identifying.
    const sources = [...new Set(events.filter(e => e.type === "damage_dealt" && e.source_type === "player"
      && e.target_type === "npc" && e.target_index === active!.index).map(e => e.source_index))];
    if (after.own_player_index != null) {
      if(active.ownPlayerIndex!==null&&active.ownPlayerIndex!==after.own_player_index){this.endEncounter("INTERRUPTED","Observed own-player identity changed.");return;}
      active.ownPlayerIndex=after.own_player_index;
    }
    if (gain > 0 && sources.length === 1 && active.clearedAt===undefined) active.ownPlayerIndex ??= sources[0]!;
    const ownKill = active.ownPlayerIndex !== null && events.some(e => e.type === "kill"
      && e.source_type === "player" && e.source_index === active!.ownPlayerIndex
      && e.target_type === "npc" && e.target_index === active!.index
      && (active!.clearedTick==null || e.tick<=active!.clearedTick+3)
      && (active!.clearedAt===undefined || after.observed_at-active!.clearedAt<=2500));
    if (!after.connected || after.hp === 0) { this.endEncounter("INTERRUPTED", "Disconnected or died."); return; }
    if (ownKill) { this.endEncounter("CONFIRMED_KILL", "Own damage/XP identity and a target-specific public kill event."); return; }
    const current = fighting(after), observedEnemy = after.entities.find(e => entityKey(e) === active!.enemy);
    if (!current || entityKey(current) !== active.enemy) {
      // Allow a short read-only attribution window for an event published after target clearing.
      // XP remains measured progress, never an inferred kill. No new encounter is started here.
      active.clearedAt??=after.observed_at;active.clearedTick??=after.tick;
      if(after.observed_at-active.clearedAt<2500 && (active.clearedTick===null||after.tick===null||after.tick-active.clearedTick<3))return;
      if (after.activity?.target_type === "none" && active.xp > 0 && (!observedEnemy || observedEnemy.hp === 0))
        this.endEncounter("COMPLETED_UNCERTAIN", "Own target cleared with melee XP; no unambiguous own kill event. Not counted as a confirmed kill.");
      else this.endEncounter("INTERRUPTED", "Target changed/lost without sufficient completion evidence.");
    } else if(active.clearedAt!==undefined) {
      this.endEncounter("INTERRUPTED","Target reappeared after clearing; spawn generation is unavailable.");
    } else if (after.observed_at - active.startAt > 60000)
      this.endEncounter("INTERRUPTED", "Encounter exceeded the sixty-second observation budget.");
  }

  /** Caller precondition: the main action journal has no pending commands.
   * Preserves numeric learning; discards session-bound route/target/dialogue state.
   * Unconfirmed policy effects must still be reconciled before rebasing. */
  resumeFromObservation(o: Observation): void {
    if (!o.connected || o.fresh_at === null || !o.position) throw new Error("FRESH_CONNECTED_OBSERVATION_REQUIRED");
    if (this.state.uncertain) {
      if (!this.effect(this.state.uncertain.before, o, this.state.uncertain.decision)) throw new Error("RECONCILE_POLICY_OUTCOME_FIRST");
      this.applyEffect(this.state.uncertain.before, o, this.state.uncertain.decision);
    }
    if (this.state.identity === identity(o)) { this.state.uncertain = null; return; }
    this.endEncounter("INTERRUPTED", "Controller resumed in a new session/context.");
    const old = this.state, fresh = initial();
    fresh.identity = identity(o); fresh.learning = old.learning; fresh.counters = old.counters;
    fresh.unknown = old.unknown; fresh.resolved = old.resolved;
    fresh.research = old.research;
    // Completed tutorial knowledge is character-specific; incomplete dialogue provenance expires.
    if (old.identity && JSON.parse(old.identity)[0] === o.character) fresh.tutorial.done = old.tutorial.done;
    this.state = fresh;
  }

  private beginEncounter(o: Observation, e: Entity) {
    if (this.state.learning.active || e.index === null || !encounter(e)) return;
    const id = JSON.stringify([identity(o), o.seq, entityKey(e)]);
    if (this.state.learning.closed.includes(id)) return;
    this.state.learning.active = { id, context: encounterContext(o, e), identity: identity(o), enemy: entityKey(e),
      index: e.index, name: e.name, contentId: e.content_id, startAt: o.observed_at, startTick: o.tick,
      lastAt: o.observed_at, lastSeq: o.seq, lastXp: meleeXp(o), lastHp: o.hp, lastFood: foodTotal(o),
      xp: 0, damage: 0, food: 0, ownPlayerIndex: o.own_player_index??null };
    this.state.counters.encountersStarted++;
  }

  private endEncounter(status: Sample["status"], reason: string) {
    const active = this.state.learning.active;
    if (!active || this.state.learning.closed.includes(active.id)) { this.state.learning.active = null; return; }
    const sample: Sample = { id: active.id, status, reason, elapsedMs: Math.max(1, active.lastAt - active.startAt),
      xp: active.xp, damage: active.damage, food: active.food };
    let method = this.state.learning.methods.find(m => m.context === active.context);
    // Durable encounter evidence must not disappear after an arbitrary cache
    // size. Archive/compact it deliberately at the store layer instead.
    if (!method) {
      method = { context: active.context, name: active.name, contentId: active.contentId, n: 0, confirmed: 0, uncertain: 0, interrupted: 0,
        elapsedMs: 0, xp: 0, damage: 0, food: 0, samples: [] };
      this.state.learning.methods.push(method);
    }
    if (method) {
      method.n++; method.elapsedMs += sample.elapsedMs; method.xp += sample.xp; method.damage += sample.damage; method.food += sample.food;
      if (status === "CONFIRMED_KILL") method.confirmed++;
      else if (status === "COMPLETED_UNCERTAIN") method.uncertain++;
      else method.interrupted++;
      method.samples = [...method.samples, sample].slice(-20);
    }
    if (status === "CONFIRMED_KILL") this.state.counters.encountersCompleted++;
    this.state.learning.closed = [...this.state.learning.closed, active.id].slice(-2048);
    this.state.learning.active = null; this.state.combat = null;
  }

  private nearest(o: Observation, predicate: (e: Entity) => boolean): Entity | undefined {
    return o.entities.filter(e => predicate(e) && e.position.plane === o.position!.plane && e.reachable !== false)
      .sort((a, b) => distance(o.position!, a.position) - distance(o.position!, b.position)
        || a.content_id - b.content_id || (a.index ?? -1) - (b.index ?? -1) || a.ref.localeCompare(b.ref))[0];
  }

  private remember(o: Observation) {
    const bank = this.nearest(o, e => !!bankOption(e));
    if (bank) this.state.bankLead = { ...bank.position };
    for (const e of o.entities) if (e.kind === "npc" && option(e, /^attack$/) && !encounter(e)) {
      if (!this.state.unknown.some(n => n.contentId === e.content_id && n.level === (e.combat_level ?? null)) && this.state.unknown.length < 64)
        this.state.unknown.push({ name: e.name, contentId: e.content_id, level: e.combat_level ?? null, maxHp: e.max_hp ?? null });
    }
  }

  private entityAction(o: Observation, e: Entity, goal: string, intent: Intent): LiveDecision {
    if (e.reachable !== true || distance(o.position!, e.position) > 5) {
      if (distance(o.position!, e.position) === 0) return block(goal, "INTERACTION_REACHABILITY_UNKNOWN", "Navigator must verify an interaction side before dispatch.");
      return { goal, reason: `Navigate to an interaction side of observed ${e.name}; the main navigator owns collision and gates.`, destination: { ...e.position } };
    }
    return { goal, reason: `Use the currently observed ${e.name} and its published option/item reference.`, intent };
  }

  /**
   * Generic local recovery. It deliberately knows nothing about gates,
   * ladders, towns, coordinates or item identities: the current observation
   * supplies the candidate and its menu option. A verified result is recorded
   * by the caller as reusable world knowledge.
   */
  private localDiscovery(o: Observation, goal: string): LiveDecision {
    const candidate=o.entities
      .filter(e=>e.kind==='object'&&e.reachable===true&&!!transitionOption(e)
        &&(!goal.startsWith('discover:discovered:interaction:')
          ||goal===`discover:discovered:interaction:${e.content_id}:${e.position.x}:${e.position.z}:${e.position.plane}:${transitionOption(e)!.index}`))
      .sort((a,b)=>distance(o.position!,a.position)-distance(o.position!,b.position)
        ||a.content_id-b.content_id||(a.index??-1)-(b.index??-1)||a.ref.localeCompare(b.ref))[0];
    if(!candidate)return block(goal,'NO_LOCAL_RECOVERY_EXPERIMENT',
      'No nearby reachable transition with a published safe interaction option is observed.');
    const selected=transitionOption(candidate)!;
    return this.entityAction(o,candidate,goal,{operation:'interact',entity_ref:candidate.ref,option_index:selected.index});
  }

  private tutorial(o: Observation): LiveDecision | undefined {
    const guide = this.nearest(o, e => e.kind === "npc" && normalize(e.name) === "runescape guide" && !!option(e, /^talk(?:-to| to)?$/));
    const p = o.position!, text = normalize(o.dialog.text);
    if (guide && o.dialog.open && p.plane === 0 && p.x >= 3090 && p.x <= 3110 && p.z >= 3090 && p.z <= 3120
      && /^runescape guide\b/.test(text) && text.includes("do you want to skip the tutorial?")) {
      this.state.tutorial.active = true; this.state.tutorial.done = false;
    }
    if (o.activity?.design_open) {
      this.state.tutorial.active = true;
      if (this.state.tutorial.steps >= 12) return block("tutorial", "TUTORIAL_STEP_LIMIT", "The bounded tutorial has exhausted twelve observed transitions.");
      return { goal: "tutorial", reason: "Accept the observed character-design screen through the normal adapter.", intent: { operation: "accept_design" } };
    }
    if (this.state.tutorial.done) return undefined;
    if (this.state.tutorial.active && !o.dialog.open && !o.dialog.waiting && !guide) {
      this.state.tutorial.active = false;
      this.state.tutorial.done = true;
      return undefined;
    }
    if (!this.state.tutorial.active && !guide) return undefined;
    if (this.state.tutorial.steps >= 12) return block("tutorial", "TUTORIAL_STEP_LIMIT", "Tutorial transition budget exhausted; no quest solver is enabled.");
    if (o.dialog.open || o.dialog.waiting) {
      // Require continuity from our guide interaction, never a nearby NPC plus arbitrary Yes.
      if (!this.state.tutorial.active) return block("tutorial", "UNSUPPORTED_DIALOGUE", "No observed Guide interaction established this dialogue context.");
      if (o.dialog.waiting) return { goal: "tutorial", reason: "Wait for the observed Guide dialogue to accept input.", wait: true };
      const yes = option(o.dialog, /^yes\b/), more = option(o.dialog, /^(continue|click (?:here )?to continue)[.!]?$/);
      const selected = yes ?? more;
      if (!selected) return block("tutorial", "UNSUPPORTED_DIALOGUE", "Guide dialogue has no supported published Yes/Continue option; no index is invented.");
      return { goal: "tutorial", reason: "Advance the bounded Guide flow using the published dialogue index.", intent: { operation: "dialogue", option_index: selected.index } };
    }
    if (!guide) return block("tutorial", "TUTORIAL_GUIDE_MISSING", "The expected RuneScape Guide is not observed.");
    return this.entityAction(o, guide, "tutorial", { operation: "interact", entity_ref: guide.ref, option_index: option(guide, /^talk(?:-to| to)?$/)!.index });
  }

  private startBank(o: Observation): LiveDecision {
    if (!o.inventory.some(i => canDeposit(o, i))) return block("bank", "INVENTORY_FULL_PROTECTED", "All occupied slots are supplies, equipment, protected or unknown items; no drop/sell action is permitted.");
    this.state.trip = { phase: "bank", returnTo: { ...o.position! }, initialized: false, remaining: [] };
    return this.banking(o);
  }

  private banking(o: Observation): LiveDecision {
    if (!this.state.trip) this.state.trip = { phase: "bank", returnTo: { ...o.position! }, initialized: false, remaining: [] };
    const trip = this.state.trip;
    if (trip.phase === "return") {
      if (o.bank.open) return { goal: "bank:close", reason: "Close the bank before returning.", intent: { operation: "close_interface" } };
      if (distance(o.position!, trip.returnTo) === 0) {
        this.state.trip = null;
        return this.supplyOrTrain(o);
      }
      return { goal: "bank:return", reason: "Return to the fixed pre-bank destination; bank proximity was not trip completion.", destination: { ...trip.returnTo } };
    }
    if (!o.bank.open) {
      if (trip.initialized && trip.remaining.some(i => i.count > 0)) return block("bank", "BANK_CLOSED_EARLY", "The original batch is not reconciled; reopen/reconcile through the main controller.");
      const bank = this.nearest(o, e => !!bankOption(e));
      if (bank) return this.entityAction(o, bank, "bank:open", { operation: "interact", entity_ref: bank.ref, option_index: bankOption(bank)!.index });
      if (this.state.bankLead && distance(o.position!, this.state.bankLead) > 5)
        return { goal: "bank:route", reason: "Revisit a previously observed bank; navigator verifies access and actual gates.", destination: { ...this.state.bankLead } };
      if (!this.state.bankLead && o.position!.plane === 0) {
        const hint = { x: 3185, z: 3436, plane: 0 };
        if (distance(o.position!, hint) > 5) return { goal: "bank:route", reason: "Search at the owner-supplied public Varrock West approach hint; this does not confirm a bank service or route.", destination: hint };
      }
      return block("bank", "MISSING_BANK_ROUTE", "No usable observed bank route/service is available; no unverified stairs or toll route is invented.");
    }
    if (!o.bank.items) return block("bank", "BANK_CONTENTS_UNAVAILABLE", "Only an open bank's fresh contents authorize a transaction.");
    if (!trip.initialized) {
      for (const i of o.inventory.filter(i => canDeposit(o, i))) {
        const entry = trip.remaining.find(e => e.id === i.id);
        if (entry) entry.count += i.count; else trip.remaining.push({ id: i.id, count: i.count });
      }
      trip.initialized = true;
    }
    for (const entry of trip.remaining.filter(e => e.count > 0)) {
      const i = o.inventory.filter(i => i.id === entry.id && canDeposit(o, i)).sort((a, b) => a.slot - b.slot)[0];
      if (!i) return block("bank", "BATCH_CHANGED_UNRECONCILED", "A batch item disappeared or became protected without matched bank evidence.");
      return { goal: "bank:deposit", reason: "Deposit the next current slot from the entire original batch, preserving all supplies and unknown items.",
        intent: { operation: "deposit", slot: i.slot, item_id: i.id, amount: Math.min(i.count, entry.count) } };
    }
    if (freeSlots(o)! > 0) {
      const meal = o.bank.items.filter(i => i.count > 0 && healing(i) > 0).sort((a, b) => healing(b) - healing(a) || a.slot - b.slot)[0];
      if (!this.supplied(o) && meal) return { goal: "bank:withdraw-food", reason: "Withdraw an observed food reserve, bounded by stack count and free slots.", intent: {
        operation: "withdraw", slot: meal.slot, item_id: meal.id,
        amount: Math.min(meal.count, freeSlots(o)!, Math.max(this.tripFoodTarget - foodCount(o), Math.ceil((this.reserveGoal(o) - reserve(o)) / healing(meal)), 1)),
      } };
      const missingTool = o.bank.items.filter(i => i.count > 0 && tool(i) && ![...o.inventory, ...o.equipment].some(have =>
        normalize(have.name) === normalize(i.name) || (/ (axe|hatchet)$/.test(normalize(i.name)) && / (axe|hatchet)$/.test(normalize(have.name)))))
        .sort((a, b) => a.slot - b.slot)[0];
      if (missingTool) return { goal: "bank:withdraw-tool", reason: "Recover one observed missing supply tool from the open bank.",
        intent: { operation: "withdraw", slot: missingTool.slot, item_id: missingTool.id, amount: 1 } };
    }
    trip.phase = "return";
    return { goal: "bank:close", reason: "Every original deposit is reconciled; close and return to the fixed target.", intent: { operation: "close_interface" } };
  }

  public replanAfterBlock(o: Observation, blocked: string): LiveDecision {
    // A blocked prerequisite is a reason to run a bounded, observation-driven
    // experiment or reselect through the Director, not to jump to a fixed map
    // fallback. Durable learning remains in the policy checkpoint.
    this.state.watch = null;
    const local = this.localDiscovery(o, `recover:${blocked}`);
    return local.blocked ? block('replan', 'NO_LOCAL_RECOVERY_EXPERIMENT',
      `${blocked}: no safe, reachable transition is currently observed; preserve the goal and wait for a new observation or Director replanning.`) : local;
  }

  private supplyOrTrain(o: Observation): LiveDecision {
    // Re-enter the normal priority order once, after clearing the trip.
    return this.next(o);
  }

  private publicLead(o: Observation, goal: string): LiveDecision {
    const p = o.position!;
    // Server compatibility notes supersede modern swamp guidance. The main
    // navigator excludes the dark-wizard rectangle; do not infer a straight route.
    const approach = { x: 3088, z: 3226, plane: 0 }, shore = { x: 3087, z: 3230, plane: 0 };
    if (p.plane !== 0 || p.x < 3070 || p.x > 3300 || p.z < 3130 || p.z > 3480)
      return block(goal, "MISSING_TOOL_OR_SUPPLY_ROUTE", "The documented Draynor surface lead is outside this bounded local context.");
    if (goal === "supply:net-route") return block(goal, "MISSING_TOOL_ROUTE", "The net itself has no verified free spawn/tutor route; require an observed pickup or bank source.");
    if (distance(p, shore) <= 5) return block(goal, "PUBLIC_LEAD_NOT_CONFIRMED", "Draynor shoreline reached without a visible compatible Net/Bait spot; do not invent a spawn.");
    return { goal, reason: "Use the documented Draynor Net/Bait lead via the guarded southern approach; main navigation owns collision and wizard exclusion.",
      destination: distance(p, approach) <= 3 ? shore : approach };
  }

  private supply(o: Observation): LiveDecision {
    const rawItem = o.inventory.filter(i => i.count > 0 && raw(i)).sort((a, b) => a.slot - b.slot)[0];
    const batchSpot = this.nearest(o, e => e.kind === "npc" && normalize(e.name) === "fishing spot"
      && !!option(e, /^(net|small net|small-net)$/) && !!option(e, /^bait$/) && !option(e, /^harpoon$/)
      && !(e.position.x >= 3076 && e.position.x <= 3092 && e.position.z >= 3233 && e.position.z <= 3247));
    const rawBatch = o.inventory.filter(i => /^raw (shrimps?|anchovies)$/.test(normalize(i.name)));
    const predictedCount = rawBatch.reduce((n, i) => n + i.count, foodCount(o));
    const predictedHealing = rawBatch.reduce((n, i) => n + i.count * (normalize(i.name) === "raw anchovies" ? 1 : 3), reserve(o));
    if (rawItem && batchSpot && distance(o.position!, batchSpot.position) <= 5 && freeSlots(o)! > 2
      && o.hp! > Math.max(7, Math.ceil(o.max_hp! * 0.7))
      && o.inventory.some(i => i.count > 0 && normalize(i.name) === "small fishing net")
      && freeSlots(o)! > (o.inventory.some(i=>normalize(i.name)==="logs")?0:1)) {
      if (target(o)?.ref === batchSpot.ref || o.activity!.animation >= 0)
        return { goal: "supply:fish", reason: "Build a useful raw-food batch before the cooking trip; raw food is not counted as combat-ready supplies.", wait: true };
      return this.entityAction(o, batchSpot, "supply:fish", { operation: "interact", entity_ref: batchSpot.ref,
        option_index: option(batchSpot, /^(net|small net|small-net)$/)!.index });
    }
    if (rawItem) {
      const cooking = skillLevel(o, "cooking");
      if (cooking === null || cooking < rawLevels[normalize(rawItem.name)]!)
        return block("supply:cook", "COOKING_REQUIREMENT_UNVERIFIED", "This raw food's proposed cooking requirement is not met in observed skills.");
      // Generic Use is a source-mapped adapter capability, not an item menu index.
      const heat = this.nearest(o, e => e.kind === "object" && /^(fire|range|fireplace|cooking pot)$/.test(normalize(e.name))
        && !(e.position.plane === 0 && e.position.x === 3212 && e.position.z === 3215)
        && (e.options.length === 0 || !!option(e, /^(cook|cook-at|cook at|use)$/)));
      if (heat) return this.entityAction(o, heat, "supply:cook", { operation: "use_on_object", slot: rawItem.slot, item_id: rawItem.id, entity_ref: heat.ref });
      const tinderbox = o.inventory.find(i => i.count > 0 && normalize(i.name) === "tinderbox");
      if (!tinderbox) return this.cookingLead(o, "tinderbox");
      const logs = o.inventory.find(i => i.count > 0 && normalize(i.name) === "logs");
      if (logs) {
        if ((skillLevel(o, "firemaking") ?? 0) < 1)
          return block("supply:fire", "FIRE_PREREQUISITES_UNVERIFIED", "Require observed Firemaking and compatible tinderbox/logs for the mapped generic Use action.");
        return { goal: "supply:fire", reason: "Use the observed tinderbox on ordinary logs; actual fire creation must be observed.",
          intent: { operation: "use_on_item", slot: tinderbox.slot, item_id: tinderbox.id, target_slot: logs.slot, target_item_id: logs.id } };
      }
      if (freeSlots(o)! <= 0) return this.startBank(o);
      const axe = [...o.inventory, ...o.equipment].find(i => i.count > 0 && /^(bronze|iron) (axe|hatchet)$/.test(normalize(i.name)));
      if (!axe) return this.cookingLead(o, "axe");
      if ((skillLevel(o, "woodcutting") ?? 0) < 1) return block("supply:logs", "WOODCUTTING_REQUIREMENT_UNVERIFIED", "Observed Woodcutting level is required.");
      const tree = this.nearest(o, e => e.kind === "object" && /^(tree|dead tree)$/.test(normalize(e.name)) && !!option(e, /^(chop down|chop-down|chop)$/));
      if (!tree) return this.cookingLead(o, "ordinary tree");
      if (o.activity!.animation >= 0) return { goal: "supply:logs", reason: "Observe the active gathering attempt before interrupting it.", wait: true };
      return this.entityAction(o, tree, "supply:logs", { operation: "interact", entity_ref: tree.ref, option_index: option(tree, /^(chop down|chop-down|chop)$/)!.index });
    }
    if (this.supplied(o)) return this.equip(o) ?? this.training(o);
    if (freeSlots(o)! <= 0) return this.startBank(o);
    const ediblePile = this.nearest(o, e => e.kind === "ground_item" && (healing(e) > 0 || raw(e)) && pickupAvailable(e));
    if (ediblePile) return this.entityAction(o, ediblePile, "supply:pickup", { operation: "pickup", entity_ref: ediblePile.ref });
    const net = o.inventory.find(i => i.count > 0 && normalize(i.name) === "small fishing net");
    if (!net) return this.acquireTool(o, "small fishing net");
    if ((skillLevel(o, "fishing") ?? 0) < 1) return block("supply:fish", "FISHING_REQUIREMENT_UNVERIFIED", "Observed Fishing level is required.");
    const spot = this.nearest(o, e => e.kind === "npc" && normalize(e.name) === "fishing spot"
      && !!option(e, /^(net|small net|small-net)$/) && !!option(e, /^bait$/) && !option(e, /^harpoon$/)
      && !(e.position.x >= 3076 && e.position.x <= 3092 && e.position.z >= 3233 && e.position.z <= 3247));
    if (!spot) return this.publicLead(o, "supply:fish-route");
    if (target(o)?.ref === spot.ref || o.activity!.animation >= 0)
      return { goal: "supply:fish", reason: "Let the observed fishing attempt produce a catch; fishing targets are not hostile combat.", wait: true };
    return this.entityAction(o, spot, "supply:fish", { operation: "interact", entity_ref: spot.ref, option_index: option(spot, /^(net|small net|small-net)$/)!.index });
  }

  private acquireTool(o: Observation, name: string): LiveDecision {
    if (freeSlots(o)! <= 0) return this.startBank(o);
    const match = (n: string) => name === "axe" ? /^(bronze|iron) (axe|hatchet)$/.test(normalize(n)) : normalize(n) === name;
    const pile = this.nearest(o, e => e.kind === "ground_item" && match(e.name) && pickupAvailable(e));
    if (pile) return this.entityAction(o, pile, `supply:tool:${name}`, { operation: "pickup", entity_ref: pile.ref });
    if (name === "small fishing net") return this.publicLead(o, "supply:net-route");
    return block(`supply:tool:${name}`, "MISSING_TOOL_ROUTE", `Missing ${name}: no observed permitted pickup or open-bank source. Purchases and invented tutor dialogues are disabled.`);
  }

  private cookingLead(o: Observation, missing: string): LiveDecision {
    const p = o.position!, hint = { x: 3230, z: 3196, plane: 0 };
    if (p.plane === 0 && p.x >= 3070 && p.x <= 3300 && p.z >= 3130 && p.z <= 3480 && distance(p, hint) > 5)
      return { goal: "supply:cook-route", reason: `Missing ${missing} for a local fire; use the documented quest-free Range near Bob, subject to observed service confirmation.`, destination: hint };
    return block("supply:cook", "MISSING_TOOL_OR_COOKING_ROUTE", `Missing ${missing} and no usable observed cooking source at the documented range lead.`);
  }

  private equip(o: Observation): LiveDecision | undefined {
    const attack = skillLevel(o, "attack"), defence = skillLevel(o, "defence");
    if (attack === null || defence === null) return block("equipment", "MELEE_SKILLS_UNAVAILABLE", "Attack and Defence observations are required.");
    const tiers: Record<string, number> = { bronze: 1, iron: 1, steel: 5, black: 10, mithril: 20, adamant: 30, rune: 40 };
    const rank = (i: Item, shield: boolean) => {
      if (shield && normalize(i.name) === "wooden shield") return 0;
      const parts = normalize(i.name).match(shield ? /^(bronze|iron|steel|black|mithril|adamant|rune) (sq shield|kiteshield)$/ : /^(bronze|iron|steel|black|mithril|adamant|rune) (sword|shortsword)$/);
      if (!parts || tiers[parts[1]!]! > (shield ? defence : attack)) return -1;
      return Object.keys(tiers).indexOf(parts[1]!) + 1;
    };
    for (const shield of [false, true]) {
      const current = Math.max(-1, ...o.equipment.map(i => rank(i, shield)));
      const candidate = o.inventory.filter(i => i.count > 0 && !!option(i, /^(wield|wear)$/) && rank(i, shield) > current)
        .sort((a, b) => rank(b, shield) - rank(a, shield) || a.slot - b.slot)[0];
      if (candidate) return { goal: shield ? "equipment:shield" : "equipment:sword", reason: "Equip an observed sword/shield with a supported material requirement; no purchase or invented slot.",
        intent: { operation: "equip", slot: candidate.slot, item_id: candidate.id } };
      if (current < 0) {
        const stored=(o.bank.open?o.bank.items??[]:[]).filter(i=>i.count>0&&rank(i,shield)>=0)
          .sort((a,b)=>rank(b,shield)-rank(a,shield)||a.slot-b.slot)[0];
        if(stored)return {goal:shield?'equipment:shield-bank':'equipment:sword-bank',reason:'Withdraw the strongest usable owned upgrade from the freshly observed bank; no item or slot is assumed.',
          intent:{operation:'withdraw',slot:stored.slot,item_id:stored.id,amount:1}};
        if(!o.bank.open&&this.state.bankLead)return this.startBank(o);
        return block("equipment", shield ? "MISSING_SHIELD" : "MISSING_SWORD", "No supported wielded, carried, or freshly observed banked sword/shield; an acquisition route is required before combat.");
      }
    }
    return undefined;
  }

  private training(o: Observation, requestedSkill?: string): LiveDecision {
    const names: Skill[] = ["attack", "strength", "defence"];
    const levels = names.map(n => skillLevel(o, n, true));
    if (levels.some(n => n === null)) return block("training", "MELEE_SKILLS_UNAVAILABLE", "All three base melee skills are required.");
    if (requestedSkill && !names.includes(requestedSkill as Skill)) return block('training', 'UNSUPPORTED_TRAINING_SKILL', 'The executor supports only its observed melee styles.');
    // Run mode supplies a Director-selected skill. The standalone policy's
    // fallback balances current capabilities, not historical 20/20/20 or 40/60/40 quotas.
    const chosenSkill=requestedSkill??names.filter((_,i)=>levels[i]!<99).sort((a,b)=>levels[names.indexOf(a)]!-levels[names.indexOf(b)]!)[0];
    if(!chosenSkill)return block('training','NO_TRAINING_OPPORTUNITY','No supported base skill can improve; select another task.');
    const lagging={name:chosenSkill as Skill};
    const styleSkills = (s: string) => s.split(",").map(n => normalize(n).replace("defense", "defence"));
    const styles = o.activity!.styles.filter(s => styleSkills(s.skill).includes(lagging.name) && (!requestedSkill || styleSkills(s.skill).length === 1))
      .sort((a, b) => styleSkills(a.skill).length - styleSkills(b.skill).length || a.index - b.index);
    const style = styles.find(s => s.index === o.activity!.style) ?? styles[0];
    if (!style) return block(`training:${lagging.name}`, "UNSUPPORTED_COMBAT_STYLE", "No actual observed style trains the selected lagging skill; never assume numeric style mappings.");
    if (o.activity!.style !== style.index) return { goal: `training:${lagging.name}`, reason: `Train the selected ${lagging.name} objective using observed ${style.name}.`,
      intent: { operation: "style", style_index: style.index } };
    const candidates = o.entities.filter(e => encounter(e) && e.in_combat === false && e.reachable !== false
      && e.position.plane === o.position!.plane && distance(o.position!, e.position) <= 12);
    candidates.sort((a, b) => encounter(a)!.maxHit - encounter(b)!.maxHit
      || Number(this.state.research.names.includes(normalize(b.name))) - Number(this.state.research.names.includes(normalize(a.name)))
      || distance(o.position!, a.position) - distance(o.position!, b.position) || a.content_id - b.content_id || (a.index ?? 0) - (b.index ?? 0));
    let enemy = candidates[0];
    this.state.learning.selection = "Conservative local baseline; insufficient comparable completed encounter samples.";
    const local = candidates.filter(e => distance(o.position!, e.position) <= 8);
    const measured = local.map(e => ({ e, method: this.state.learning.methods.find(m => m.context === encounterContext(o, e)) }));
    const completed = (m: typeof measured[number]["method"]) => m?.samples.filter(s => s.status !== "INTERRUPTED") ?? [];
    const rate = (m: NonNullable<typeof measured[number]["method"]>) => {
      const samples = completed(m), duration = samples.reduce((n, s) => n + s.elapsedMs, 0) / 1000;
      return samples.reduce((n, s) => n + s.xp - 2 * s.food - 0.1 * s.damage, 0) / Math.max(0.001, duration)
        - m.interrupted / Math.max(1, m.n);
    };
    const ranked = measured.filter(v => completed(v.method).length >= 3)
      .sort((a, b) => rate(b.method!) - rate(a.method!) || candidates.indexOf(a.e) - candidates.indexOf(b.e));
    if (ranked[0]) {
      enemy = ranked[0].e;
      this.state.learning.selection = "Measured local encounter XP/second minus food, observed HP-loss and interruption cost; at least three comparable completed samples. Not full-trip utility.";
    }
    // One deterministic under-tested choice per ten observed encounter starts.
    // Exploration stays among already-vetted visible variants within eight tiles.
    if (this.state.counters.encountersStarted % 10 === 9) {
      const underTested = measured.filter(v => completed(v.method).length < 3 && v.e !== enemy)
        .sort((a, b) => completed(a.method).length - completed(b.method).length || candidates.indexOf(a.e) - candidates.indexOf(b.e))[0];
      if (underTested) { enemy = underTested.e; this.state.learning.selection = "Bounded tenth-encounter local under-tested alternative; all safety and supply filters still apply."; }
    }
    if (!enemy) {
      if (o.entities.some(e => e.kind === "npc" && option(e, /^attack$/)))
        return block(`training:${lagging.name}`, "NO_SAFE_VISIBLE_TARGET", "Visible attackable NPCs are not free compatible local targets; unfamiliar variants are recorded, never attacked.");
      return this.trainingLead(o);
    }
    const safeMargin = Math.max(3 * encounter(enemy)!.maxHit + 1, o.danger.damage_margin ?? 0);
    if (o.hp! <= safeMargin) return block("training", "INSUFFICIENT_HEALTH_MARGIN", "Current HP does not cover the conservative incoming-damage margin.");
    const chosen = this.entityAction(o, enemy, `training:${lagging.name}`, { operation: "interact", entity_ref: enemy.ref, option_index: option(enemy, /^attack$/)!.index });
    chosen.reason += " " + this.state.learning.selection;
    return chosen;
  }

  private key(o: Observation, d: LiveDecision): string {
    const i = d.intent;
    if (i && "entity_ref" in i) {
      const e = o.entities.find(e => e.ref === i.entity_ref);
      return `${d.goal}:${i.operation}:${e ? entityKey(e) : "unobserved"}`;
    }
    if (i && "item_id" in i) return `${d.goal}:${i.operation}:${i.item_id}`;
    if (i?.operation === "style") return `${d.goal}:style:${i.style_index}`;
    return `${d.goal}:${i?.operation ?? (d.destination ? "route" : "wait")}`;
  }

  private trainingLead(o: Observation): LiveDecision {
    const p = o.position!;
    if (p.plane !== 0 || p.x < 3070 || p.x > 3300 || p.z < 3130 || p.z > 3480)
      return block("training:discover", "NO_SAFE_VISIBLE_TARGET", "No bounded local training lead is applicable to this location.");
    const leads = [
      { name: "goblin", tile: { x: 3252, z: 3230, plane: 0 } },
      { name: "chicken", tile: { x: 3232, z: 3295, plane: 0 } },
      { name: "cow", tile: { x: 3253, z: 3272, plane: 0 } },
    ];
    for (const lead of leads) {
      if (this.state.scouting.includes(lead.name)) continue;
      if (distance(p, lead.tile) <= 8) { this.state.scouting.push(lead.name); continue; }
      return { goal: `training:discover:${lead.name}`, reason: `Search the owner-supplied public ${lead.name} lead. Goblins outdoors are the initial lead; confirm all actual entities/options, collision and gates.`, destination: lead.tile };
    }
    return block("training:discover", "TRAINING_LEADS_EXHAUSTED", "Three bounded local leads failed to reveal a usable target; require updated observations/research, not endless waits.");
  }

  private outcomeKey(o: Observation, d: LiveDecision): string {
    return JSON.stringify([identity(o), o.seq, this.key(o, d)]);
  }

  private marker(o: Observation, d: LiveDecision): string {
    if (d.destination) return JSON.stringify(o.position);
    if (d.goal === "combat:engaged") {
      const e = fighting(o);
      return JSON.stringify([e?.content_id, e?.index, e?.hp, xp(o, ["attack", "strength", "defence", "hitpoints"])]);
    }
    if (d.goal === "supply:fish") return JSON.stringify([inventoryMark(o, raw), xp(o, ["fishing"])]);
    if (d.goal === "supply:logs") return JSON.stringify([inventoryMark(o, i => normalize(i.name) === "logs"), xp(o, ["woodcutting"])]);
    return JSON.stringify([o.dialog, o.activity?.design_open]);
  }

  private finish(o: Observation, d: LiveDecision): LiveDecision {
    if (d.blocked) return d;
    const key = this.key(o, d);
    if ((this.state.stalls[key] ?? 0) > 2) return block(d.goal, "REPEATED_NO_EFFECT", "Three reconciled attempts produced no relevant effect; diagnose prerequisites or route before retrying.");
    if (d.wait || d.destination) {
      const marker = this.marker(o, d), w = this.state.watch;
      if (!w || w.key !== key) this.state.watch = { key, marker, seq: o.seq, unchanged: 0, observations: 1, history: [marker],
        startedAt: o.observed_at, progressAt: o.observed_at, progressTick: o.tick };
      else if (w.seq !== o.seq) {
        if (w.startedAt === 0) { w.startedAt = o.observed_at; w.progressAt = o.observed_at; w.progressTick = o.tick; }
        w.unchanged = w.marker === marker ? w.unchanged + 1 : 0;
        if (w.marker !== marker) { w.progressAt = o.observed_at; w.progressTick = o.tick; }
        w.marker = marker; w.seq = o.seq; w.observations++;
        w.history = [...w.history, marker].slice(-4);
        const oscillation = d.destination && w.history.length === 4 && w.history[0] === w.history[2] && w.history[1] === w.history[3] && w.history[0] !== w.history[1];
        const stalled = w.unchanged > 2 && o.observed_at - w.progressAt >= 12000
          && (o.tick === null || w.progressTick === null || o.tick - w.progressTick >= 12);
        const timeout = o.observed_at - w.startedAt > (d.destination ? 120000 : d.goal.startsWith("supply:") ? 30000 : 60000);
        if (stalled || oscillation || timeout) {
          this.state.stalls[key] = 3;
          return block(d.goal, oscillation ? "ROUTE_OSCILLATION" : "REPEATED_NO_EFFECT", "Waiting/travel exhausted its observation budget without a useful result; this is blocked, not task completion.");
        }
      }
    } else this.state.watch = null;
    return d;
  }

  private effect(before: Observation, after: Observation, d: LiveDecision): boolean {
    if (identity(before) !== identity(after) || after.seq <= before.seq) return false;
    const i = d.intent;
    if (!i) return (d.wait || d.destination) ? this.marker(before, d) !== this.marker(after, d) : false;
    switch (i.operation) {
      case "move": return !!before.position && !!after.position && before.position.plane===after.position.plane
        && (distance(after.position,i.destination)===0 || distance(before.position,after.position)>0);
      case "deposit": case "withdraw": {
        if (!before.bank.open || !after.bank.open || !before.bank.items || !after.bank.items) return false;
        const invDelta = count(after.inventory, i.item_id) - count(before.inventory, i.item_id);
        const bankDelta = count(after.bank.items, i.item_id) - count(before.bank.items, i.item_id);
        return i.operation === "deposit" ? invDelta === -i.amount && bankDelta === i.amount : invDelta === i.amount && bankDelta === -i.amount;
      }
      case "eat": return count(after.inventory, i.item_id) < count(before.inventory, i.item_id)
        && before.hp !== null && after.hp !== null && after.hp > before.hp;
      case "equip": return count(after.equipment, i.item_id) > count(before.equipment, i.item_id)
        && count(after.inventory, i.item_id) < count(before.inventory, i.item_id);
      case "style": return after.activity?.style === i.style_index && before.activity?.style !== i.style_index;
      case "accept_design": return before.activity?.design_open === true && after.activity?.design_open === false;
      case "close_interface": return !!(before.bank.open || before.shop_open || before.dialog.open || before.activity?.modal_open)
        && !after.bank.open && !after.shop_open && !after.dialog.open && !after.activity?.modal_open;
      case "dialogue": return JSON.stringify(before.dialog) !== JSON.stringify(after.dialog);
      case "use_on_item": return count(after.inventory, i.target_item_id) < count(before.inventory, i.target_item_id)
        && after.entities.some(e => normalize(e.name) === "fire" && e.kind === "object" && !before.entities.some(b => entityKey(b) === entityKey(e)));
      case "use_on_object": return (!!after.dialog.open && JSON.stringify(before.dialog) !== JSON.stringify(after.dialog))
        || count(after.inventory, i.item_id) < count(before.inventory, i.item_id)
        && (xp(after, ["cooking"]) > xp(before, ["cooking"]) || after.inventory.some(a =>
          (healing(a) > 0 || normalize(a.name).startsWith("burnt ")) && count(after.inventory, a.id) > count(before.inventory, a.id)));
      case "pickup": {
        const e = before.entities.find(e => e.ref === i.entity_ref);
        if (!e || e.kind !== "ground_item") return false;
        const a = sameEntity(after, e);
        return count(after.inventory, e.content_id) > count(before.inventory, e.content_id) && (!a || (e.count != null && a.count != null && a.count < e.count));
      }
      case "interact": {
        const e = before.entities.find(e => e.ref === i.entity_ref);
        if (!e) return false;
        const action = e.options.find(p => p.index === i.option_index)?.text ?? "";
        if (/^attack$/i.test(action)) return (e.hp != null && sameEntity(after, e)?.hp != null && sameEntity(after, e)!.hp! < e.hp)
          || xp(after, ["attack", "strength", "defence"]) > xp(before, ["attack", "strength", "defence"]);
        if (bankOption(e)?.index === i.option_index) return !before.bank.open && after.bank.open === true && after.bank.items !== null;
        if(e.kind==='object'&&transitionOption(e))return transitionEvidence(agencyState(before),agencyState(after),agencyCandidate(before,d)).length>0;
        if (normalize(e.name) === "runescape guide") return JSON.stringify(before.dialog) !== JSON.stringify(after.dialog) && !!(after.dialog.open || after.dialog.waiting);
        if (/^(net|small net|small-net)$/i.test(action)) return after.inventory.filter(raw).reduce((n, i) => n + i.count, 0)
          > before.inventory.filter(raw).reduce((n, i) => n + i.count, 0) && xp(after, ["fishing"]) > xp(before, ["fishing"]);
        if (/^(chop down|chop-down|chop)$/i.test(action)) return after.inventory.filter(n => normalize(n.name) === "logs").reduce((n, i) => n + i.count, 0)
          > before.inventory.filter(n => normalize(n.name) === "logs").reduce((n, i) => n + i.count, 0) && xp(after, ["woodcutting"]) > xp(before, ["woodcutting"]);
        return false;
      }
    }
  }

  private applyEffect(before: Observation, after: Observation, d: LiveDecision) {
    const i = d.intent;
    if (i?.operation === "use_on_object" && after.dialog.open && JSON.stringify(before.dialog) !== JSON.stringify(after.dialog))
      this.state.production = { itemId: i.item_id, steps: 0 };
    if (d.goal === "supply:cook-dialogue" && this.state.production) this.state.production.steps++;
    if (i?.operation === "deposit") {
      const entry = this.state.trip?.remaining.find(e => e.id === i.item_id);
      if (entry) entry.count = Math.max(0, entry.count - i.amount);
    }
    const guideAction = i?.operation === "interact" && before.entities.some(e => e.ref === i.entity_ref
      && normalize(e.name) === "runescape guide" && e.options.some(p => p.index === i.option_index && /^talk(?:-to| to)?$/.test(normalize(p.text))));
    if (i && (guideAction || i.operation === "accept_design" || (i.operation === "dialogue" && this.state.tutorial.active))) {
      this.state.tutorial.active = true;
      this.state.tutorial.steps++;
      if (i.operation === "dialogue" && !after.dialog.open && !after.dialog.waiting
        && before.position && after.position && distance(before.position, after.position) > 8) {
        this.state.tutorial.done = true; this.state.tutorial.active = false;
      }
    }
    if (i?.operation === "interact" && /^(supply:fish|supply:logs)$/.test(d.goal)) {
      this.state.counters.gatheredItems += after.inventory.reduce((n, a) => n + (raw(a) || normalize(a.name) === "logs"
        ? Math.max(0, count(after.inventory, a.id) - count(before.inventory, a.id)) / after.inventory.filter(v => v.id === a.id).length : 0), 0);
    }
  }

}
