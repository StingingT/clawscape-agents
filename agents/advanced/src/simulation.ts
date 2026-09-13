import { Observation, Episode, type Intent } from "./contracts.ts";
import { ActionArbiter, type Adapter, type SafetyPolicy } from "./arbiter.ts";
import { Store } from "./store.ts";
import { BankBatch } from "./behaviours.ts";
import { OBJECTIVE, POLICY, contextKey, type Method } from "./learning.ts";

export const FIXTURE_PROFILE = "SIMULATION-NOT-CLAWSCAPE-v1";
export const food = { slot: 0, id: 90001, name: "Fixture ration", count: 3,
  options: [{ index: 1, text: "Eat" }], protected: true };
export function snapshot(): Observation {
  return Observation.parse({
    schema_version: "1.0", character: "astra", world: "isolated-simulation",
    world_epoch: "fixture-epoch-1", session_id: "fixture-session-1", profile_id: FIXTURE_PROFILE,
    seq: 1, tick: 1, observed_at: Date.now(), fresh_at: Date.now(), provenance: "simulation", connected: true,
    position: { x: 10, z: 10, plane: 0 }, hp: 8, max_hp: 10, life_id: 1, respawns: 0,
    skills: [{ name: "Attack", current: 1, base: 1, xp: 0 }], capacity: 28,
    inventory: [food,{ slot: 1, id: 90002, name: "Fixture logs", count: 1, options: [], protected: false }],
    equipment: [], bank: { open: false, items: null }, shop_open: false,
    dialog: { open: false, waiting: false, text: "", options: [] },
    entities: [{ ref: "fixture-banker-1", content_id: 91001, index: 1, kind: "npc", name: "Fixture banker",
      position: { x: 11,z: 10,plane: 0 }, reachable: true, options: [{ index: 2,text: "Bank" }] }],
    feedback: [], danger: { active: false, damage_margin: 3 }, unavailable: [],
  });
}
export class FixtureAdapter implements Adapter {
  state = snapshot();
  dispatchCount = 0;
  reject = false;
  loseAck = false;
  noEffect = false;
  bankItems: Observation["inventory"] = [];
  async snapshot() { return structuredClone(this.state); }
  async dispatch(i: Intent) {
    this.dispatchCount++;
    if (this.reject) return { success: false, phase: "validation", reason: "client_rejected" };
    if (!this.noEffect) {
      switch (i.operation) {
        case "move": this.state.position = i.destination; break;
        case "eat": {
          const item = this.state.inventory.find(x => x.slot === i.slot && x.id === i.item_id)!;
          item.count--; this.state.hp = Math.min(this.state.max_hp!,this.state.hp! + 3);
          this.state.inventory = this.state.inventory.filter(x => x.count);
          break;
        }
        case "interact":
          this.state.bank = { open: true, items: this.bankItems };
          break;
        case "deposit":
        case "withdraw": {
          const from = i.operation === "deposit" ? this.state.inventory : this.bankItems;
          const to = i.operation === "deposit" ? this.bankItems : this.state.inventory;
          const item = from.find(x => x.slot === i.slot && x.id === i.item_id)!;
          item.count -= i.amount;
          const target = to.find(x => x.id === i.item_id);
          if (target) target.count += i.amount;
          else to.push({ ...item, slot: Math.max(-1,...to.map(x => x.slot)) + 1, count: i.amount });
          this.state.inventory = this.state.inventory.filter(x => x.count > 0);
          this.bankItems = this.bankItems.filter(x => x.count > 0);
          this.state.bank.items = this.bankItems;
          break;
        }
        case "close_interface": this.state.bank = { open: false, items: null }; break;
        case "dialogue": this.state.dialog = { open: false, waiting: false, text: "", options: [] }; break;
      }
      this.state.seq++; this.state.tick!++;
      this.state.observed_at = Date.now(); this.state.fresh_at = Date.now();
    }
    if (this.loseAck) throw new Error("SIMULATED_ACK_LOSS");
    return { success: true, phase: "dispatch" };
  }
}
export function fixturePolicy(): SafetyPolicy {
  return { maxStaleMs: 3000, maxDeaths: 2, keepIds: [90001],
    allowedTiles: new Set([JSON.stringify({ x: 11,z: 10,plane: 0 })]),
    safeEntities: new Set(["fixture-banker-1"]) };
}
export const METHODS: Method[] = [
  { id: "method-a", safe: true, supported: true, prerequisitesMet: true, resourceBurden: 1,costGp: 0 },
  { id: "method-b", safe: true, supported: true, prerequisitesMet: true, resourceBurden: 1,costGp: 0 },
  { id: "unknown-danger",safe: false,supported: true,prerequisitesMet: true,resourceBurden: 0,costGp: 0 },
];
/** Abstract complete-trip fixture, not a RuneScape combat/damage simulator. */
export function simulatedEpisode(method: string, n: number, changed = false, prefix = "training"): Episode {
  const start = snapshot(), end = snapshot();
  const fast = changed ? method === "method-a" : method === "method-b";
  const minutes = (fast ? 2 : 5) + ((n * 17) % 11) / 100;
  const elapsed = Math.round(minutes * 60000);
  end.skills[0]!.xp = 1000;
  end.observed_at = start.observed_at + elapsed;
  end.fresh_at = end.observed_at;
  return Episode.parse({
    schema_version: "1.0", episode_id: prefix + ":" + n + ":" + method,
    character: "astra", world: start.world, profile_id: FIXTURE_PROFILE, objective_id: OBJECTIVE,
    goal_id: "fixture-full-trip", method_id: method, behaviour_version: "abstract-trip-v1",
    policy_version: POLICY, context: contextKey(start,"fixture-course"),
    event_start: "fixture:" + n + ":start", event_end: "fixture:" + n + ":end",
    start, end, status: "COMPLETED", cause: "Synthetic complete trip including travel/bank/resupply",
    full_trip: true, metrics: { elapsed_ms: elapsed, progress: 1000, new_unlocks: [],
      income_gp: 20, acquisition_gp: 5, losses_gp: 0, scarcity_units: fast ? 1 : 4,
      deaths: 0, failures: 0, stalls_ms: 0 },
  });
}
export async function runBankDemo(store: Store) {
  const adapter = new FixtureAdapter(), arbiter = new ActionArbiter(store,adapter,fixturePolicy());
  const lease = store.acquire("astra-simulation",Date.now());
  const trace: unknown[] = [];
  const act = async (intent: Intent) => {
    store.renew(lease,Date.now());
    const o = await adapter.snapshot();
    const r = await arbiter.submit({
      schema_version: "1.0", action_id: crypto.randomUUID(), character: o.character, world: o.world,
      session_id: o.session_id, world_epoch: o.world_epoch!, profile_id: o.profile_id, lease,
      plan_id: "fixture-bank-demo", based_on_snapshot: o.seq, expires_at: Date.now()+2000, intent,
    });
    trace.push({ operation: intent.operation, status: r.status, evidence: r.evidence });
    if (r.status !== "SUCCEEDED") throw new Error(r.reason);
  };
  try {
    await act({ operation: "eat",slot: 0,item_id: 90001 });
    await act({ operation: "move",destination: { x: 11,z: 10,plane: 0 } });
    await act({ operation: "interact",entity_ref: "fixture-banker-1",option_index: 2 });
    const bank = new BankBatch(await adapter.snapshot(),new Set([90001]));
    for (let step = 0;step < 10;step++) {
      const decision = bank.next(await adapter.snapshot());
      if (decision.status === "COMPLETED") break;
      if (!decision.intent) throw new Error(decision.reason);
      await act(decision.intent);
    }
    store.append("observations_or_checkpoints",crypto.randomUUID(),await adapter.snapshot());
    return { evidence_type: "SIMULATION_ONLY", trace, banked: adapter.bankItems, health: adapter.state.hp };
  } finally { store.setControl("STOPPED"); }
}
