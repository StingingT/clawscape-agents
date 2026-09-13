import { ActionCommand, ActionResult, Observation, type Intent } from "./contracts.ts";
import { Store } from "./store.ts";

export interface Adapter {
  snapshot(): Promise<Observation>;
  dispatch(intent: Intent): Promise<{ success: boolean; phase: string; reason?: string }>;
  validateCommand?(command: ActionCommand, observation: Observation): string | null;
  authorize?(command: ActionCommand, observation: Observation): void;
}
export type SafetyPolicy = {
  maxStaleMs: number; maxDeaths: number; keepIds: number[];
  allowedTiles: Set<string>; safeEntities: Set<string>;
  allowLocalEpoch?: boolean;
  recoveryTiles?: Set<string>;
  additionalCheck?: (intent: Intent, observation: Observation) => string | null;
};
const total = (items: Observation["inventory"] | null, id: number) =>
  items === null ? null : items.filter(i => i.id === id).reduce((n,i) => n + i.count, 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function evidence(intent: Intent, before: Observation, after: Observation): string[] {
  if (before.profile_id !== after.profile_id || before.session_id !== after.session_id
    || before.world_epoch !== after.world_epoch || before.life_id !== after.life_id
    || before.character !== after.character || before.world !== after.world || !after.connected) return [];
  switch (intent.operation) {
    case "close_interface": return before.bank.open && after.bank.open === false ? ["bank-closed"]
      : before.shop_open && after.shop_open === false ? ["shop-closed"]
      : before.activity?.modal_open && after.activity?.modal_open === false ? ["modal-closed"] : [];
    case "move": return same(after.position, intent.destination) ? ["destination-observed"] : [];
    case "eat": return (total(before.inventory,intent.item_id) ?? 0) > (total(after.inventory,intent.item_id) ?? 0)
      && before.hp !== null && after.hp !== null && after.hp > before.hp ? ["food-decreased", "hp-increased"] : [];
    case "deposit":
    case "withdraw": {
      if (!before.bank.open || !after.bank.open || !before.bank.items || !after.bank.items) return [];
      const deltaInv = total(after.inventory,intent.item_id)! - total(before.inventory,intent.item_id)!;
      const deltaBank = total(after.bank.items,intent.item_id)! - total(before.bank.items,intent.item_id)!;
      const direction = intent.operation === "deposit" ? -1 : 1;
      return deltaInv === direction * intent.amount && deltaBank === -direction * intent.amount
        ? ["inventory-and-bank-reconciled"] : [];
    }
    case "dialogue": return !same(before.dialog,after.dialog) ? ["dialogue-state-changed"] : [];
    case "equip": return after.equipment.some(i => i.id === intent.item_id)
      && !same(before.equipment, after.equipment) ? ["equipment-observed"] : [];
    case "style": return after.activity?.style === intent.style_index ? ["combat-style-observed"] : [];
    case "accept_design": return before.activity?.design_open && !after.activity?.design_open ? ["design-closed"] : [];
    case "pickup": {
      const target = before.entities.find(e => e.ref === intent.entity_ref);
      return target && (total(after.inventory,target.content_id) ?? 0) > (total(before.inventory,target.content_id) ?? 0)
        ? ["ground-item-acquired"] : [];
    }
    case "use_on_object":
    case "use_on_item": {
      const consumed = (total(after.inventory,intent.item_id) ?? 0) < (total(before.inventory,intent.item_id) ?? 0);
      const targetConsumed = intent.operation === 'use_on_item'
        && (total(after.inventory,intent.target_item_id) ?? 0) < (total(before.inventory,intent.target_item_id) ?? 0);
      const skill = intent.operation === 'use_on_object' ? 'cooking' : 'firemaking';
      const xp = (after.skills.find(s => s.name.toLowerCase() === skill)?.xp ?? 0) > (before.skills.find(s => s.name.toLowerCase() === skill)?.xp ?? 0);
      const dialog = !same(before.dialog,after.dialog) && after.dialog.open;
      const burned = intent.operation==='use_on_object' && consumed && after.inventory.some(i=>/^burnt /i.test(i.name)
        && (total(after.inventory,i.id)??0)>(total(before.inventory,i.id)??0));
      return dialog ? ['production-dialog-observed'] : burned ? ['production-burn-observed']
        : ((consumed || targetConsumed) && xp) ? ['production-consumption-and-xp'] : [];
    }
    case "interact":
      if (before.provenance === 'cli-player-observation') {
        const target = before.entities.find(e => e.ref === intent.entity_ref);
        const op = target?.options.find(p => p.index === intent.option_index)?.text.toLowerCase() ?? '';
        if (!target) return [];
        if (/^bank$|^use-quickly$/.test(op)) return !before.bank.open && after.bank.open ? ['bank-opened'] : [];
        if (/^talk/.test(op)) return !same(before.dialog,after.dialog) && after.dialog.open ? ['target-dialog-observed'] : [];
        if (op === 'attack') {
          if(after.activity?.events?.some(e=>e.tick>(before.tick??-1)&&e.source_type==='player'&&e.target_type==='npc'
            && e.target_index===target.index&&(e.type==='damage_dealt'||e.type==='kill')))return ['target-specific-combat-event'];
          return after.activity?.target_type === 'npc' && after.activity.target_index === target.index ? ['attack-target-observed'] : [];
        }
        if (op === 'open') return !after.entities.some(e => e.kind === target.kind && same(e.position,target.position)
          && e.content_id === target.content_id && e.options.some(p => p.text.toLowerCase() === 'open')) ? ['obstruction-opened'] : [];
        const skill = /net|bait|lure|fish/.test(op) ? 'fishing' : /chop/.test(op) ? 'woodcutting' : '';
        return skill && (after.skills.find(s => s.name.toLowerCase() === skill)?.xp ?? 0)
          > (before.skills.find(s => s.name.toLowerCase() === skill)?.xp ?? 0)
          && !same(before.inventory,after.inventory) ? ['gathered-item-and-xp'] : [];
      }
      // These broad fixture effects are not real-server action attribution.
      // Live dispatch remains disabled until behavior-specific effects are implemented.
      return !same(before.inventory,after.inventory) || !same(before.skills,after.skills)
        || before.bank.open !== after.bank.open || !same(before.dialog,after.dialog)
        ? ["fixture-interaction-effect"] : [];
  }
}
export function safety(intent: Intent, o: Observation, policy: SafetyPolicy, now: number): string | null {
  if (!o.connected) return "DISCONNECTED";
  if (o.provenance === 'cli-player-observation' && o.world_epoch === null && !policy.allowLocalEpoch) return 'WORLD_FENCING_UNAVAILABLE';
  if (o.fresh_at === null || o.fresh_at > now || now - o.fresh_at > policy.maxStaleMs) return "STALE_STATE";
  if (o.hp === null || o.max_hp === null || o.hp <= 0) return "HEALTH_UNKNOWN_OR_DEAD";
  if (o.respawns === null || o.respawns >= policy.maxDeaths) return "DEATH_LIMIT_OR_UNKNOWN";
  const additional = policy.additionalCheck?.(intent,o);
  if (additional) return additional;
  const emergencyMove = intent.operation === 'move' && policy.recoveryTiles?.has(JSON.stringify(intent.destination));
  const emergencyClose = intent.operation === 'close_interface' && (o.bank.open || o.shop_open || o.activity?.modal_open);
  if (intent.operation !== "eat" && !emergencyMove && !emergencyClose
    && (o.danger.active !== false || o.danger.damage_margin === null || o.hp <= o.danger.damage_margin)) return "SAFETY_INTERRUPT";
  if (intent.operation === "move") {
    if (!policy.allowedTiles.has(JSON.stringify(intent.destination))) return "UNREVIEWED_ROUTE";
    if (!o.position || o.position.plane !== intent.destination.plane) return "TRANSITION_REQUIRED";
  }
  if (intent.operation === "interact") {
    const entity = o.entities.find(e => e.ref === intent.entity_ref);
    if (!entity) return "TARGET_GONE";
    if (entity.reachable !== true) return "PATH_BLOCKED_OR_UNKNOWN";
    if (!policy.safeEntities.has(entity.ref)) return "UNVETTED_ENCOUNTER";
    if (!entity.options.some(p => p.index === intent.option_index)) return "OPTION_CHANGED";
    if (o.provenance === 'cli-player-observation') {
      const option = entity.options.find(p=>p.index===intent.option_index)!.text;
      if (/^attack$/i.test(option)) {
        if (!/^(rat|chicken|goblin|cow|cow calf)$/i.test(entity.name) || (entity.combat_level??100)>5) return 'UNSUPPORTED_PILOT_ENCOUNTER';
        const healthyGoblinTrial = /^goblin$/i.test(entity.name) && entity.combat_level===2 && o.hp!==null && o.max_hp!==null && o.hp>=9 && o.hp>=o.max_hp*.9;
        if (!healthyGoblinTrial && o.inventory.filter(i=>i.options.some(p=>/^eat$/i.test(p.text))).reduce((n,i)=>n+i.count,0)<3) return 'FOOD_RESERVE_REQUIRED';
        if (!o.equipment.some(i=>/sword|scimitar|mace|axe|dagger/i.test(i.name))) return 'MELEE_WEAPON_REQUIRED';
      }
    }
  }
  if (intent.operation === "dialogue"
    && (!o.dialog.open || o.dialog.waiting || !o.dialog.options.some(p => p.index === intent.option_index))) return "INTERFACE_CHANGED";
  if (intent.operation === 'accept_design' && !o.activity?.design_open) return 'INTERFACE_CHANGED';
  if (intent.operation === 'style' && !o.activity?.styles.some(s => s.index === intent.style_index)) return 'STYLE_UNKNOWN';
  if (intent.operation === 'equip' || intent.operation === 'use_on_object' || intent.operation === 'use_on_item') {
    const item = o.inventory.find(i => i.slot === intent.slot && i.id === intent.item_id);
    if (!item) return 'INSUFFICIENT_ITEMS';
    if (o.bank.open || o.shop_open || o.dialog.open) return 'INTERFACE_CHANGED';
    if (intent.operation === 'equip' && !item.options.some(p => /^(wear|wield)$/i.test(p.text))) return 'CANNOT_EQUIP';
    if (intent.operation === 'use_on_item' && !o.inventory.some(i => i.slot === intent.target_slot && i.id === intent.target_item_id)) return 'INSUFFICIENT_ITEMS';
  }
  if (intent.operation === 'use_on_object' || intent.operation === 'pickup') {
    const e = o.entities.find(e => e.ref === intent.entity_ref);
    if (!e || e.reachable !== true || !policy.safeEntities.has(e.ref)) return 'TARGET_UNAVAILABLE';
    if (intent.operation === 'pickup' && (o.capacity === null || o.inventory.length >= o.capacity)) return 'INVENTORY_FULL_OR_UNKNOWN';
  }
  if (["deposit", "withdraw"].includes(intent.operation) && o.bank.open !== true) return "INTERFACE_CHANGED";
  if (intent.operation === "withdraw" && (o.capacity === null || o.inventory.length >= o.capacity)) return "INVENTORY_FULL_OR_UNKNOWN";
  if (intent.operation === "deposit" || intent.operation === "eat" || intent.operation === "withdraw") {
    const items = intent.operation === "withdraw" ? o.bank.items : o.inventory;
    const item = items?.find(i => i.slot === intent.slot && i.id === intent.item_id);
    if (!item) return "INSUFFICIENT_ITEMS";
    if (intent.operation === "deposit"
      && (item.protected || policy.keepIds.includes(item.id) || o.equipment.some(i => i.id === item.id))) return "PROTECTED_ITEM";
    if (intent.operation !== "eat" && item.count < intent.amount) return "INSUFFICIENT_ITEMS";
    if (intent.operation === "eat"
      && (!item.options.some(p => p.text.toLowerCase() === "eat") || o.bank.open || o.shop_open || o.dialog.open)) return "CANNOT_EAT";
  }
  return null;
}
export class ActionArbiter {
  private busy = false;
  constructor(readonly store: Store, private adapter: Adapter, private policy: SafetyPolicy,
    private now: () => number = Date.now) {}
  private result(id: string, status: ActionResult["status"], reason: string, proof: string[] = []): ActionResult {
    return ActionResult.parse({ schema_version: "1.0", action_id: id, status, reason, at: this.now(), evidence: proof });
  }
  private validate(c: ActionCommand, o: Observation): string | null {
    const ctl = this.store.control();
    if (ctl.disabled || ctl.mode !== "RUNNING" || ctl.lease !== c.lease || ctl.expires <= this.now()) return "CONTROL_REVOKED";
    if (c.expires_at <= this.now()) return "EXPIRED";
    if (c.character !== o.character || c.world !== o.world || c.world_epoch !== o.world_epoch
      || c.session_id !== o.session_id || c.profile_id !== o.profile_id) return "STALE_STATE";
    if (this.adapter.validateCommand) {
      const invalid = this.adapter.validateCommand(c,o);
      if (invalid) return invalid;
    } else if (c.based_on_snapshot !== o.seq) return 'STALE_STATE';
    return safety(c.intent, o, this.policy, this.now());
  }
  async submit(raw: unknown): Promise<ActionResult> {
    const c = ActionCommand.parse(raw);
    const old = this.store.action(c.action_id);
    if (old) {
      if (!same(old.command,c)) return this.result(c.action_id,"REJECTED","ACTION_ID_REUSED");
      return old.result;
    }
    if (this.busy || this.store.pending().length) return this.result(c.action_id,"REJECTED","RECONCILE_PENDING");
    this.busy = true;
    try {
      const before = Observation.parse(await this.adapter.snapshot());
      const reason = this.validate(c,before);
      if (reason) return this.result(c.action_id,"REJECTED",reason);
      try {
        this.store.db.transaction(() => {
          const again = this.validate(c,before);
          if (again) throw new Error(again);
          this.store.createAction(c,this.result(c.action_id,"QUEUED","VALIDATED"));
          this.store.append("action_checkpoints",c.action_id,{ action_id: c.action_id, before });
        }).immediate();
      } catch {
        return this.result(c.action_id,"REJECTED","RESERVATION_CONFLICT_OR_CONTROL_CHANGED");
      }
      // Re-read immediately before application; revocation or safety overrides queued work.
      const current = Observation.parse(await this.adapter.snapshot());
      const changed = this.validate(c,current);
      if (changed) {
        const r = this.result(c.action_id,changed === "EXPIRED" ? "EXPIRED" : "CANCELLED",changed);
        this.store.result(r);
        return r;
      }
      this.store.result(this.result(c.action_id,"RUNNING","DISPATCH_STARTED"));
      try {
        this.adapter.authorize?.(c,current);
        const response = await this.adapter.dispatch(c.intent);
        if (!response.success) {
          const r = this.result(c.action_id,"FAILED", response.reason ?? "CLIENT_REJECTED");
          this.store.result(r);
          return r;
        }
        const after = Observation.parse(await this.adapter.snapshot());
        const proof = evidence(c.intent,before,after);
        const r = this.result(c.action_id,proof.length ? "SUCCEEDED" : "RUNNING",
          proof.length ? "OBSERVED_EFFECT" : "OUTCOME_UNKNOWN",proof);
        this.store.result(r);
        return r;
      } catch {
        const r = this.result(c.action_id,"RUNNING","OUTCOME_UNKNOWN");
        this.store.result(r);
        return r;
      }
    } finally { this.busy = false; }
  }
  async reconcile(): Promise<ActionResult[]> {
    const after = Observation.parse(await this.adapter.snapshot());
    const results: ActionResult[] = [];
    for (const pending of this.store.pending()) {
      // A journaled QUEUED command was never handed to the transport.
      if (pending.result.status === "QUEUED") {
        const r = this.result(pending.command.action_id,"CANCELLED","RESTART_BEFORE_DISPATCH");
        this.store.result(r); results.push(r); continue;
      }
      const checkpoint = this.store.records<{action_id: string; before: Observation}>("action_checkpoints")
        .find(r => r.action_id === pending.command.action_id);
      if (!checkpoint || after.fresh_at === null || this.now() - after.fresh_at > this.policy.maxStaleMs) continue;
      const proof = evidence(pending.command.intent,checkpoint.before,after);
      if (proof.length) {
        const r = this.result(pending.command.action_id,"SUCCEEDED","RECONCILED_EFFECT",proof);
        this.store.result(r); results.push(r);
      }
    }
    return results;
  }
  /** Best-effort preemption, never a claim that an already sent packet was undone.
   * Uncertain transfers/item consumption are deliberately NOT eligible. */
  interruptForFood(o: Observation): boolean {
    if (o.provenance!=='cli-player-observation' || o.fresh_at===null || this.now()-o.fresh_at>this.policy.maxStaleMs
      || o.hp===null || o.max_hp===null || o.hp>o.max_hp*0.8 || o.bank.open || o.shop_open || o.dialog.open
      || !o.inventory.some(i=>i.options.some(p=>/^eat$/i.test(p.text)))) return false;
    const pending=this.store.pending();
    if (!pending.length || pending.some(p=>!['move','interact'].includes(p.command.intent.operation))) return false;
    for (const p of pending) this.store.result(this.result(p.command.action_id,'CANCELLED','PREEMPTED_FOR_FOOD_EFFECT_MAY_STILL_COMPLETE'));
    return true;
  }
}
