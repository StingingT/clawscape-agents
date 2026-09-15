import { combatEvents, observedPlayerIndex } from '../../../src/combat-evidence.ts';
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Observation, type Intent } from "./contracts.ts";
import type { Adapter } from "./arbiter.ts";

const obj = (v: unknown): Record<string,unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const num = (v: unknown): number | null => typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;
const str = (v: unknown): string => typeof v === "string" ? v.slice(0,4096) : "";
const options = (v: unknown, key = "opIndex") => list(v).flatMap(x => {
  const p = obj(x), index = num(p[key]);
  return index === null ? [] : [{ index, text: str(p.text) }];
});
function items(v: unknown, keep: number[]) {
  return list(v).flatMap(raw => {
    const i = obj(raw), slot = num(i.slot), id = num(i.id), count = num(i.count);
    if (slot === null || id === null || count === null) return [];
    return [{ slot, id, count, name: str(i.name), options: options(i.optionsWithIndex), protected: keep.includes(id) }];
  });
}
export function projectSnapshot(raw: unknown, identity: {
  character: string; world: string; session: string; profile: string; seq: number;
  now: number; freshAt: number | null; keep: number[];
}): Observation {
  const outer = obj(raw), s = obj(outer.state), p = obj(s.player), bank = obj(s.bank), dialog = obj(s.dialog);
  if (typeof p.name === "string" && p.name.toLowerCase() !== identity.character) throw new Error("CHARACTER_MISMATCH");
  const plane = num(p.level), x = num(p.worldX), zCoord = num(p.worldZ);
  const entities: Observation["entities"] = [];
  if (plane !== null) for (const [field, kind] of [["nearbyNpcs","npc"],["nearbyLocs","object"],["groundItems","ground_item"]] as const) {
    list(s[field]).forEach((raw, ordinal) => {
      const e = obj(raw), id = num(e.id), ex = num(e.tileX) ?? num(e.x), ez = num(e.tileZ) ?? num(e.z);
      if (id === null || ex === null || ez === null) return;
      entities.push({ ref: [identity.session,identity.seq,kind,ordinal].join(":"),
        content_id: id, index: num(e.index), kind, name: str(e.name), position: { x: ex, z: ez, plane },
        reachable: bool(e.reachable), options: options(e.optionsWithIndex), combat_level: num(e.combatLevel),
        hp: num(e.hp), max_hp: num(e.maxHp), in_combat: bool(e.inCombat), ...(num(e.count) !== null ? {count: num(e.count)!} : {}) });
    });
  }
  return Observation.parse({
    schema_version: "1.0", character: identity.character, world: identity.world, world_epoch: null,
    session_id: identity.session, profile_id: identity.profile, seq: identity.seq,
    tick: num(s.tick), observed_at: identity.now, fresh_at: identity.freshAt, provenance: "cli-player-observation",
    connected: outer.connected === true, position: plane !== null && x !== null && zCoord !== null ? { x, z: zCoord, plane } : null,
    own_player_index: observedPlayerIndex(p.index),
    hp: num(p.hp), max_hp: num(p.maxHp), life_id: num(p.lifeId), respawns: num(p.respawnCount),
    skills: list(s.skills).flatMap(raw => {
      const v = obj(raw), current = num(v.level), base = num(v.baseLevel), xp = num(v.experience);
      return current !== null && base !== null && xp !== null ? [{ name: str(v.name), current, base, xp }] : [];
    }),
    capacity: Array.isArray(s.inventory) ? 28 : null,
    inventory: items(s.inventory,identity.keep), equipment: items(s.equipment,identity.keep),
    bank: { open: bool(bank.isOpen), items: bank.isOpen === true ? items(bank.items,identity.keep) : null },
    shop_open: bool(obj(s.shop).isOpen),
    dialog: { open: bool(dialog.isOpen), waiting: bool(dialog.isWaiting),
      text: str(dialog.text) || list(dialog.allComponents).filter(c=>obj(c).type===4).map(c=>str(obj(c).text)).filter(Boolean).join('\n').slice(0,4096),
      options: options(dialog.options,"index") },
    entities, feedback: list(s.gameMessages).slice(-10).map(m => str(obj(m).text)),
    ...(p.combat && typeof p.animId === 'number' ? { activity: {
      animation: p.animId, target_index: obj(p.combat).targetIndex ?? -1,
      target_type: obj(p.combat).targetType ?? 'none', last_damage_tick: obj(p.combat).lastDamageTick ?? -1,
      modal_open: s.modalOpen === true, modal_id: s.modalInterface ?? -1,
      design_open: s.modalOpen === true && s.modalInterface === 3559,
      events: combatEvents(s.combatEvents),
      style: num(obj(s.combatStyle).currentStyle), styles: list(obj(s.combatStyle).styles).flatMap(raw => {
        const st = obj(raw), index = num(st.index);
        return index === null ? [] : [{index, name: str(st.name), skill: list(st.trainsSkills).map(str).join(',')}];
      }),
    }} : {}),
    // inCombat is a target indicator, NOT evidence of danger: fishing targets also set it.
    danger: { active: null, damage_margin: null },
    unavailable: ["authoritative-world-epoch","server-action-status","spawn-generation","threat-model","quest-journal","local-collision",
      ...(!Array.isArray(s.inventory) ? ["inventory"] : []), ...(!Array.isArray(s.equipment) ? ["equipment"] : []),
      ...(!Array.isArray(s.skills) ? ["skills"] : []), ...(bank.isOpen !== true ? ["fresh-bank-contents"] : [])],
  });
}
/** Safe read-only transport; never connects, registers, waits or dispatches gameplay. */
export class ClawscapeObserver implements Adapter {
  private seq = 0;
  private lastTick: number | null = null;
  private freshAt: number | null = null;
  private session = crypto.randomUUID();
  constructor(private gameRoot: string, private cliHome: string, private character: string,
    private world: string, private profile: string, private keep: number[] = []) {}
  async snapshot() {
    const config = z.object({ server: z.url() }).parse(JSON.parse(readFileSync(join(this.cliHome,"config.jsonl"),"utf8")));
    if (new URL(config.server).origin !== new URL(this.world).origin) throw new Error("WORLD_MISMATCH");
    if (!/^[a-z][a-z0-9]{0,11}$/.test(this.character)) throw new Error("INVALID_CHARACTER");
    const child = Bun.spawn([process.execPath,resolve(this.gameRoot,"src/cli.ts"),"--character",this.character,"state"], {
      cwd: resolve(this.gameRoot), env: { ...process.env, CLAWSCAPE_HOME: resolve(this.cliHome) },
      stdout: "pipe", stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(),5000);
    try {
      const output = await new Response(child.stdout).text();
      if (await child.exited !== 0 || output.length > 4_000_000) throw new Error("CLI_STATE_UNAVAILABLE");
      const raw: unknown = JSON.parse(output);
      const tick = num(obj(obj(raw).state).tick), now = Date.now();
      if (this.lastTick !== null && tick !== null && tick < this.lastTick) {
        this.session = crypto.randomUUID(); this.freshAt = null;
      } else if (tick !== null && this.lastTick !== null && tick > this.lastTick) this.freshAt = now;
      this.lastTick = tick;
      return projectSnapshot(raw,{ character: this.character, world: this.world, session: this.session,
        profile: this.profile, seq: ++this.seq, now, freshAt: this.freshAt, keep: this.keep });
    } finally { clearTimeout(timer); }
  }
  async dispatch(_intent: Intent): Promise<never> { throw new Error("LIVE_DISPATCH_RELEASE_GATE"); }
}
