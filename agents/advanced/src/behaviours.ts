import { SkillDefinition, type Intent, type Observation } from "./contracts.ts";

export const behaviours = [
  { skill_id: "bank_items", permitted_operations: ["deposit","close_interface"], progress_markers: ["inventory-and-bank-reconciled"] },
  { skill_id: "eat_food", permitted_operations: ["eat"], progress_markers: ["food-decreased","hp-increased"] },
  { skill_id: "navigate_to", permitted_operations: ["move"], progress_markers: ["route-cursor-advanced","destination-observed"] },
].map(b => SkillDefinition.parse({
  schema_version: "1.0", behaviour_version: "0.1", preconditions: ["fresh-state","control-lease","supported-capability"],
  success_predicates: b.progress_markers, abort_conditions: ["danger","stale-state","life-change"],
  timeout_ms: 30000, max_retries: 2, recovery: ["reobserve","reconcile","block"],
  interruptible: true, validation: "fixture", ...b,
}));

/** Retains the entire original deposit batch, even once the first free slot appears.
 * The caller must only call next after the arbiter reconciles the previous action. */
export class BankBatch {
  private remaining: Map<number,number>;
  private lastCounts: Map<number,number>;
  private retries = 0;
  private started: number;
  private identity: string;
  constructor(start: Observation, readonly keep: Set<number>, now = Date.now()) {
    if (!start.bank.open || !start.bank.items) throw new Error("BANK_NOT_OBSERVED");
    this.remaining = new Map();
    for (const item of start.inventory) if (!item.protected && !keep.has(item.id)
      && !start.equipment.some(e => e.id === item.id)) {
      this.remaining.set(item.id,(this.remaining.get(item.id) ?? 0) + item.count);
    }
    this.lastCounts = new Map(this.remaining);
    this.started = now;
    this.identity = [start.profile_id,start.session_id,start.world_epoch,start.life_id].join(":");
  }
  next(o: Observation, now = Date.now()): { status: string; intent?: Intent; reason?: string } {
    if (this.identity !== [o.profile_id,o.session_id,o.world_epoch,o.life_id].join(":")) return { status: "BLOCKED", reason: "STATE_CHANGED" };
    if (now - this.started > 30000) return { status: "BLOCKED", reason: "BANK_TIMEOUT" };
    if (!o.bank.open) return this.remaining.size ? { status: "BLOCKED", reason: "BANK_CLOSED_EARLY" } : { status: "COMPLETED" };
    for (const [id,oldCount] of this.lastCounts) {
      const count = o.inventory.filter(i => i.id === id).reduce((n,i) => n+i.count,0);
      if (count < oldCount) {
        this.remaining.set(id,Math.max(0,(this.remaining.get(id) ?? 0) - oldCount + count));
        this.retries = 0;
      }
      this.lastCounts.set(id,count);
      if (this.remaining.get(id) === 0) this.remaining.delete(id);
    }
    if (!this.remaining.size) return { status: "ACTIVE", intent: { operation: "close_interface" } };
    if (++this.retries > 3) return { status: "BLOCKED", reason: "NO_BANK_PROGRESS" };
    const item = o.inventory.find(i => this.remaining.has(i.id) && !i.protected && !this.keep.has(i.id));
    if (!item) return { status: "BLOCKED", reason: "BATCH_CHANGED" };
    return { status: "ACTIVE", intent: { operation: "deposit", slot: item.slot, item_id: item.id,
      amount: Math.min(item.count,this.remaining.get(item.id)!) } };
  }
}
