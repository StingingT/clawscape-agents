import { z } from "zod";

export const version = z.literal("1.0");
const id = z.string().min(1).max(240);
const nat = z.number().int().nonnegative();
const text = z.string().max(4096);
const strs = z.array(id).max(256);
export const Tile = z.strictObject({ x: nat.max(16383), z: nat.max(16383), plane: nat.max(3) });
export type Tile = z.infer<typeof Tile>;
export const Option = z.strictObject({ index: nat, text });
export const Item = z.strictObject({
  slot: nat, id: nat, name: text, count: nat,
  options: z.array(Option), protected: z.boolean(),
});
export const Entity = z.strictObject({
  ref: id, content_id: nat, index: nat.nullable(), kind: z.enum(["npc", "object", "ground_item"]),
  name: text, position: Tile, reachable: z.boolean().nullable(), options: z.array(Option),
  combat_level: nat.nullable().optional(), hp: nat.nullable().optional(), max_hp: nat.nullable().optional(),
  in_combat: z.boolean().nullable().optional(), count: nat.optional(),
});
export const CompatibilityProfile = z.strictObject({
  schema_version: version, profile_id: id, server_build: text.nullable(),
  content_hash: id.nullable(), revision: text.nullable(), rules_hash: id.nullable(),
  customizations: strs, tick_model: z.strictObject({
    source: text, milliseconds: nat.nullable(), authoritative_epoch: z.boolean(),
  }),
  capabilities: strs, unsupported_features: strs, knowledge_policy: text, audit_evidence: strs,
});
export const Observation = z.strictObject({
  schema_version: version, character: id, world: id, world_epoch: id.nullable(), session_id: id,
  profile_id: id, seq: nat, tick: nat.nullable(), observed_at: nat, fresh_at: nat.nullable(),
  provenance: z.enum(["simulation", "cli-player-observation"]),
  connected: z.boolean(), position: Tile.nullable(), own_player_index: nat.nullable().optional(),
  hp: nat.nullable(), max_hp: nat.nullable(), life_id: nat.nullable(), respawns: nat.nullable(),
  skills: z.array(z.strictObject({ name: text, current: nat, base: nat, xp: nat })),
  capacity: nat.nullable(), inventory: z.array(Item), equipment: z.array(Item),
  bank: z.strictObject({ open: z.boolean().nullable(), items: z.array(Item).nullable() }),
  shop_open: z.boolean().nullable(), dialog: z.strictObject({
    open: z.boolean().nullable(), waiting: z.boolean().nullable(), text, options: z.array(Option),
  }),
  entities: z.array(Entity), feedback: z.array(text),
  danger: z.strictObject({ active: z.boolean().nullable(), damage_margin: nat.nullable() }),
  unavailable: strs,
  activity: z.strictObject({
    animation: z.number().int(), target_index: z.number().int(), target_type: z.enum(["npc", "player", "none"]),
    last_damage_tick: z.number().int(), modal_open: z.boolean(), modal_id: z.number().int(),
    style: z.number().int().nullable(), styles: z.array(z.strictObject({ index: nat, name: text, skill: text })),
    design_open: z.boolean(),
    events: z.array(z.strictObject({tick:nat,type:z.enum(['damage_taken','damage_dealt','kill']),damage:nat,
      source_type:z.string(),source_index:z.number().int(),target_type:z.string(),target_index:z.number().int()})).max(30).optional(),
  }).optional(),
});
export type Observation = z.infer<typeof Observation>;
export const Intent = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("close_interface") }),
  z.strictObject({ operation: z.literal("move"), destination: Tile }),
  z.strictObject({ operation: z.literal("eat"), slot: nat, item_id: nat }),
  z.strictObject({ operation: z.literal("deposit"), slot: nat, item_id: nat, amount: nat.positive() }),
  z.strictObject({ operation: z.literal("withdraw"), slot: nat, item_id: nat, amount: nat.positive() }),
  z.strictObject({ operation: z.literal("interact"), entity_ref: id, option_index: nat }),
  z.strictObject({ operation: z.literal("dialogue"), option_index: nat }),
  z.strictObject({ operation: z.literal("equip"), slot: nat, item_id: nat }),
  z.strictObject({ operation: z.literal("style"), style_index: nat }),
  z.strictObject({ operation: z.literal("use_on_object"), slot: nat, item_id: nat, entity_ref: id }),
  z.strictObject({ operation: z.literal("use_on_item"), slot: nat, item_id: nat, target_slot: nat, target_item_id: nat }),
  z.strictObject({ operation: z.literal("pickup"), entity_ref: id }),
  z.strictObject({ operation: z.literal("accept_design") }),
]);
export type Intent = z.infer<typeof Intent>;
export const ActionCommand = z.strictObject({
  schema_version: version, action_id: id, character: id, world: id,
  session_id: id, world_epoch: id.nullable(), profile_id: id, lease: id,
  plan_id: id, based_on_snapshot: nat, expires_at: nat, intent: Intent,
});
export type ActionCommand = z.infer<typeof ActionCommand>;
export const ActionResult = z.strictObject({
  schema_version: version, action_id: id,
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED", "REJECTED"]),
  reason: text, at: nat, evidence: strs,
});
export type ActionResult = z.infer<typeof ActionResult>;
export const Predicate = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("skill_at_least"), skill: id, value: nat }),
  z.strictObject({ kind: z.literal("inventory_at_least"), item_id: nat, value: nat }),
  z.strictObject({ kind: z.literal("free_slots_at_least"), value: nat }),
  z.strictObject({ kind: z.literal("at_tile"), tile: Tile }),
]);
export const Goal = z.strictObject({
  schema_version: version, goal_id: id, objective_id: id, description: text, profile_id: id,
  priority: z.number().finite(), prerequisites: strs, candidate_methods: strs,
  selected_method: id.nullable(), resource_budget: nat, success_predicates: z.array(Predicate).min(1),
  abort_conditions: strs, evidence_refs: strs,
  status: z.enum(["PROPOSED", "READY", "ACTIVE", "BLOCKED", "COMPLETED", "FAILED", "ABANDONED"]),
  rationale: text,
});
export type Goal = z.infer<typeof Goal>;
export const Plan = z.strictObject({
  schema_version: version, plan_id: id, profile_id: id, based_on_snapshot: nat,
  goal: Goal, behaviour: z.enum(["navigate_to", "eat_food", "bank_items", "gather_supply", "fight_target"]),
  method_id: id, evidence_refs: strs,
});
export const SkillDefinition = z.strictObject({
  schema_version: version, skill_id: id, behaviour_version: id,
  permitted_operations: z.array(z.enum(["move", "eat", "deposit", "withdraw", "interact", "dialogue", "close_interface"])),
  preconditions: strs, progress_markers: strs, success_predicates: strs, abort_conditions: strs,
  timeout_ms: nat.positive(), max_retries: nat.max(2), recovery: strs, interruptible: z.literal(true),
  validation: z.enum(["fixture", "real-server"]),
});
export const ResearchClaim = z.strictObject({
  schema_version: version, claim_id: id, source_url: z.url(), title: text,
  retrieved_at: nat, content_date: text.nullable(), game_version: text,
  requirements: strs, paraphrase: text, fingerprint: id, profile_id: id,
  validation_evidence: strs,
  status: z.enum(["UNVERIFIED", "COMPATIBLE_STATIC", "OBSERVED", "CONTRADICTED", "UNSUPPORTED", "STALE"]),
});
export const Event = z.strictObject({
  schema_version: version, event_id: id, character: id, world: id, profile_id: id,
  at: nat, kind: id, reason: text, evidence: strs,
});
export const Metrics = z.strictObject({
  elapsed_ms: nat.positive(), progress: z.number().nonnegative().finite(),
  new_unlocks: strs, income_gp: nat, acquisition_gp: nat, losses_gp: nat,
  scarcity_units: z.number().nonnegative().finite(), deaths: nat, failures: nat, stalls_ms: nat,
});
export const Episode = z.strictObject({
  schema_version: version, episode_id: id, character: id, world: id, profile_id: id,
  objective_id: id, goal_id: id, method_id: id, behaviour_version: id, policy_version: id,
  context: id, event_start: id, event_end: id, start: Observation, end: Observation,
  status: z.enum(["COMPLETED", "FAILED", "INTERRUPTED", "UNCERTAIN"]), cause: text,
  full_trip: z.boolean(), metrics: Metrics,
});
export type Episode = z.infer<typeof Episode>;
export const PolicyUpdate = z.strictObject({
  schema_version: version, update_id: id, episode_id: id, context: id,
  method_id: id, policy_version: id, utility: z.number().finite(), n: nat.positive(),
  mean: z.number().finite(), m2: z.number().nonnegative().finite(),
  seed: nat, reason: text,
});
export const Config = z.strictObject({
  schema_version: version, character: z.string().regex(/^[a-z][a-z0-9]{0,11}$/).nullable(),
  world: z.url(), game_root: id, cli_home: id.nullable(),
  mode: z.enum(["observe", "simulation", "live"]), model_mode: z.literal("disabled"),
  objective: z.literal("self-sufficient-pve-v1"), npc_spending_gp: nat,
  max_session_minutes: nat.positive(), max_retries: nat.max(2),
  exploration_fraction: z.number().min(0).max(0.1), max_planner_calls_per_hour: nat.max(60),
  max_research_searches_per_hour: nat.max(8), max_stale_ms: nat.positive(), max_deaths: nat.positive(),
  keep_item_ids: z.array(nat), allowed_areas: z.array(Tile),
  allow_pvp: z.literal(false), allow_player_trades: z.literal(false), allow_drop: z.literal(false),
  allow_full_static_map: z.literal(false),
  live_control: z.literal("local-single-controller").optional(),
});
export const schemas = { CompatibilityProfile, Observation, Event, ActionCommand, ActionResult,
  Goal, Plan, SkillDefinition, ResearchClaim, Episode, PolicyUpdate };
