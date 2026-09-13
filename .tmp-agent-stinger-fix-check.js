#!/usr/bin/env bun
// @bun

// src/agent.ts
import {
  appendFileSync,
  existsSync as existsSync5,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync8,
  writeFileSync as writeFileSync5
} from "fs";
import { resolve as resolve5 } from "path";

// src/navigation/controller.ts
import { readFileSync, writeFileSync, existsSync } from "fs";

// src/runtime-policy.ts
function dialogueOption(options) {
  const valid = options.filter((o) => Number.isInteger(o.index));
  return valid.find((o) => /access my bank|bank account|cook all/i.test(o.text)) ?? valid.find((o) => /continue|^yes|cook/i.test(o.text)) ?? valid[0];
}
function bankOption(options) {
  return options.find((o) => /^use-quickly$/i.test(o.text)) ?? options.find((o) => /^bank$/i.test(o.text));
}
var isFood = (item) => item.optionsWithIndex?.some((o) => /^eat$/i.test(o.text)) === true;
function isThreatened(state) {
  const combat = state.player?.combat;
  if (!combat)
    return false;
  const recentDamage = Number(combat.lastDamageTick) >= 0 && Number(state.tick) - Number(combat.lastDamageTick) <= 10;
  if (recentDamage)
    return true;
  if (!combat.inCombat)
    return false;
  if (combat.targetType === "player")
    return true;
  const target = state.nearbyNpcs?.find((n) => n.index === combat.targetIndex);
  return target?.optionsWithIndex?.some((o) => /^attack$/i.test(o.text)) === true;
}
function harvestLevel(name) {
  return { tree: 1, oak: 15, willow: 30, maple: 45, yew: 60, "magic tree": 75 }[name.toLowerCase()] ?? Infinity;
}
function bowArrowCap(name) {
  if (/^(shortbow|longbow)$/i.test(name))
    return 2;
  if (/^oak (shortbow|longbow)$/i.test(name))
    return 3;
  if (/^willow (shortbow|longbow)$/i.test(name))
    return 4;
  if (/^maple (shortbow|longbow)$/i.test(name))
    return 5;
  if (/^(yew|magic) (shortbow|longbow)/i.test(name))
    return 6;
  return 0;
}
function hasUsableArrows(bow, equipment) {
  return equipment.some((i) => {
    const metal = /^(bronze|iron|steel|mithril|adamant|rune) arrow/i.exec(i.name)?.[1]?.toLowerCase();
    const rank = ["bronze", "iron", "steel", "mithril", "adamant", "rune"].indexOf(metal ?? "") + 1;
    return rank > 0 && rank <= bowArrowCap(bow) && Number(i.count) > 0;
  });
}
function itemTotal(items, id) {
  return items.filter((i) => i.id === id).reduce((sum, i) => sum + i.count, 0);
}
function verifyBankTransfer(before, after, action) {
  const depositing = action.type === "bankDeposit";
  const source = depositing ? before.inventory : before.bank?.items;
  const item = source?.find((i) => i.slot === action.fields.slot);
  if (!item || !before.bank?.isOpen || !after.bank?.isOpen)
    return false;
  const invDelta = itemTotal(after.inventory, item.id) - itemTotal(before.inventory, item.id);
  const bankDelta = itemTotal(after.bank.items, item.id) - itemTotal(before.bank.items, item.id);
  return invDelta + bankDelta === 0 && (depositing ? bankDelta > 0 : invDelta > 0);
}

// src/navigation/geometry.ts
var distance = (a, b) => a.level === b.level ? Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) : Infinity;
function validTile(t) {
  return [t.x, t.z, t.level].every(Number.isInteger) && t.x >= 0 && t.z >= 0 && t.level >= 0 && t.level <= 3;
}
function interrupted(before, after) {
  if (!after?.player)
    return "missing-state";
  if (after.player.isDead || before.player.lifeId !== after.player.lifeId || before.player.respawnCount !== after.player.respawnCount)
    return "respawned";
  if (before.player.level !== after.player.level)
    return "plane-changed";
  if (after.player.hp < before.player.hp || isThreatened(after))
    return "danger";
  if (after.tick < before.tick)
    return "session-reset";
}

// src/navigation/controller.ts
var position = (s) => ({ x: s.player.worldX, z: s.player.worldZ, level: s.player.level });

class Navigator {
  port;
  file;
  planner;
  questTravel;
  worker;
  ready = false;
  fatal;
  sequence = 0;
  pending = new Map;
  legs = [];
  destination = "";
  expected;
  life;
  blocked = {};
  doors = [];
  lastTick = 0;
  recoveries = 0;
  safeTrail = [];
  escapeTarget;
  escapeLife;
  constructor(port, file, planner, questTravel = false) {
    this.port = port;
    this.file = file;
    this.planner = planner;
    this.questTravel = questTravel;
    if (existsSync(file)) {
      try {
        const old = JSON.parse(readFileSync(file, "utf8"));
        this.blocked = old.blocked ?? {};
        this.doors = old.doors ?? [];
        this.escapeTarget = old.escapeTarget;
        this.escapeLife = old.escapeLife;
        this.destination = old.destination ?? "";
        this.recoveries = old.recoveries ?? 0;
      } catch {}
    }
    if (planner) {
      this.ready = true;
      return;
    }
    this.worker = new Worker(new URL("./map-worker.ts", import.meta.url).href);
    this.worker.onmessage = ({ data }) => {
      if (data.ready) {
        this.ready = true;
        return;
      }
      const p = this.pending.get(data.id);
      if (!p)
        return;
      this.pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data);
    };
    this.worker.onerror = (event) => {
      this.fatal = event.message;
      for (const p of this.pending.values())
        p.reject(new Error(event.message));
      this.pending.clear();
    };
  }
  close() {
    this.worker?.terminate();
  }
  async prepare(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.ready) {
      if (this.fatal)
        throw new Error(this.fatal);
      if (Date.now() >= deadline)
        throw new Error("map-initialization-timeout");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async dispatch(type, fields) {
    const result = await this.port.act(type, fields);
    if (result?.success === false || result?.error)
      throw new Error(`dispatch-rejected: ${result.reason ?? result.error}`);
    return result;
  }
  blockedUntil(to) {
    return this.blocked[JSON.stringify(to)]?.until ?? 0;
  }
  async plan(from, to) {
    const id = ++this.sequence;
    this.doors = this.doors.filter((d) => d.until > Date.now());
    let timer;
    try {
      return await Promise.race([
        this.planner ? this.planner(from, to, this.doors.map((d) => d.door)) : new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.worker.postMessage({ id, from, to, blocked: this.doors.map((d) => d.door), questTravel: this.questTravel });
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("planner-timeout")), 15000);
          timer.unref();
        })
      ]);
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
  async assess(from, to) {
    if (this.fatal)
      return { status: "blocked", reason: this.fatal };
    if (!this.ready)
      return { status: "loading-map" };
    if (this.blockedUntil(to) > Date.now())
      return { status: "blocked", reason: "route-cooldown" };
    try {
      const plan = await this.plan(from, to);
      if (distance(plan.legs.at(-1)?.target ?? from, to) !== 0)
        return { status: "blocked", reason: "partial-path" };
      if (plan.unmappedTiles > 0)
        return { status: "blocked", reason: "unverified-collision-coverage" };
      let previous = from, cost = 0;
      for (const leg of plan.legs) {
        cost += distance(previous, leg.target);
        previous = leg.target;
      }
      return { status: "ready", cost, conditionalDoors: plan.legs.reduce((n, l) => n + l.doors.length, 0), hash: plan.hash };
    } catch (error) {
      return { status: "blocked", reason: String(error) };
    }
  }
  record(status, state, extra = {}) {
    const record = { time: new Date().toISOString(), status, position: position(state), tick: state.tick, destination: this.destination, nextWaypoint: this.legs[0]?.target, blocked: this.blocked, doors: this.doors, escapeTarget: this.escapeTarget, escapeLife: this.escapeLife, recoveries: this.recoveries, ...extra };
    writeFileSync(this.file, JSON.stringify(record, null, 2));
    return { state, navigation: record };
  }
  block(state, to, reason) {
    this.blocked[JSON.stringify(to)] = { until: Date.now() + 60000, reason };
    this.legs = [];
    return this.record("blocked", state, { reason, retryAfter: this.blockedUntil(to) });
  }
  async escape(state) {
    const at = position(state);
    if (state.player.isDead || this.escapeLife !== undefined && this.escapeLife !== state.player.lifeId) {
      this.escapeTarget = undefined;
      this.escapeLife = undefined;
      this.safeTrail = [];
      this.legs = [];
      this.expected = undefined;
      return this.record("interrupted", state, { reason: "respawned" });
    }
    const inChickenPen = (t) => t.level === 0 && t.x >= 3224 && t.x <= 3236 && t.z >= 3290 && t.z <= 3301;
    if (inChickenPen(at) && this.escapeTarget && inChickenPen(this.escapeTarget)) {
      this.escapeTarget = undefined;
      this.legs = [];
      this.expected = undefined;
    }
    if (at.level === 0 && at.x >= 3236 && at.x <= 3242 && at.z >= 3288 && at.z <= 3301 && isThreatened(state)) {
      this.escapeTarget = { x: 3238, z: 3275, level: 0 };
    }
    this.escapeTarget ??= at.level === 0 && at.x >= 3224 && at.x <= 3236 && at.z >= 3290 && at.z <= 3301 ? { x: 3238, z: 3295, level: 0 } : at.level === 0 && at.x >= 3076 && at.x <= 3094 && at.z >= 3229 && at.z <= 3247 ? { x: 3094, z: 3226, level: 0 } : this.safeTrail.find((t) => distance(at, t) >= 8 && distance(at, t) <= 48 && !inChickenPen(t));
    this.escapeLife = state.player.lifeId;
    if (!this.escapeTarget)
      return this.record("interrupted", state, { reason: "danger-no-verified-exit" });
    const trip = await this.step(this.escapeTarget, state, true);
    return { state: trip.state, navigation: { ...trip.navigation, escape: true } };
  }
  interrupt(state, reason) {
    return reason === "danger" ? this.escape(state) : Promise.resolve(this.record("interrupted", state, { reason }));
  }
  async step(to, initial, escaping = false) {
    let state = initial;
    if (this.fatal)
      return this.block(state, to, this.fatal);
    if (initial.player?.isDead)
      return this.record("interrupted", state, { reason: "respawned" });
    if (!escaping && isThreatened(initial))
      return this.escape(state);
    if (!escaping) {
      this.escapeTarget = undefined;
      this.escapeLife = undefined;
    }
    const interruption = (next) => {
      const reason = interrupted(initial, next);
      return escaping && reason === "danger" ? undefined : reason;
    };
    if (!this.safeTrail.length)
      this.safeTrail.push(position(state));
    if (this.lastTick > initial.tick || this.life !== undefined && this.life !== initial.player.lifeId) {
      this.legs = [];
      this.expected = undefined;
      this.safeTrail = [];
    }
    this.lastTick = initial.tick;
    this.life = initial.player.lifeId;
    if (position(state).level !== to.level)
      return this.block(state, to, "transition-required");
    if (distance(position(state), to) === 0) {
      this.legs = [];
      this.destination = JSON.stringify(to);
      return this.record("arrived", state);
    }
    if (this.blockedUntil(to) > Date.now())
      return this.record("blocked", state, { reason: this.blocked[JSON.stringify(to)]?.reason });
    if (!this.ready) {
      state = await this.port.wait(2);
      return this.record("loading-map", state);
    }
    const key = JSON.stringify(to);
    if (key !== this.destination || !this.legs.length || this.expected && distance(position(state), this.expected)) {
      if (key !== this.destination)
        this.recoveries = 0;
      this.destination = key;
      this.doors = this.doors.filter((d) => d.until > Date.now());
      try {
        const plan = await this.plan(position(state), to);
        if (distance(plan.legs.at(-1)?.target ?? position(state), to) !== 0)
          return this.block(state, to, "partial-path");
        if (plan.unmappedTiles > 0)
          return this.block(state, to, "unverified-collision-coverage");
        this.legs = plan.legs;
        state = await this.port.state();
        const reason = interruption(state);
        if (reason)
          return this.interrupt(state, reason);
      } catch (error) {
        return this.block(state, to, String(error));
      }
    }
    const leg = this.legs[0];
    if (!leg)
      return this.block(state, to, "empty-route");
    try {
      for (const door of leg.doors) {
        const loc = state.nearbyLocs?.find((l) => l.level === door.level && l.x === door.x && l.z === door.z && l.reachable && /^(gate|door|large door)$/i.test(l.name) && l.optionsWithIndex?.some((o) => /^open$/i.test(o.text)));
        if (!loc)
          continue;
        const option = loc.optionsWithIndex.find((o) => /^open$/i.test(o.text));
        await this.dispatch("interactLoc", { x: loc.x, z: loc.z, locId: loc.id, optionIndex: option.opIndex });
        let opened = false;
        for (let poll = 0;poll < 12; poll += 2) {
          state = await this.port.wait(2);
          const reason = interruption(state);
          if (reason)
            return this.interrupt(state, reason);
          const current = state.nearbyLocs?.find((l) => l.id === loc.id && l.x === loc.x && l.z === loc.z);
          if (!current || !current.optionsWithIndex?.some((o) => /^open$/i.test(o.text))) {
            opened = true;
            break;
          }
        }
        if (!opened) {
          this.doors.push({ door, until: Date.now() + 60000 });
          this.legs = [];
          this.expected = position(state);
          if (++this.recoveries > 2)
            return this.block(state, to, "door-retry-budget");
          return this.record("replanning", state, { reason: "door-did-not-open" });
        }
      }
      await this.dispatch("walkTo", { x: leg.target.x, z: leg.target.z, running: true });
      let previous = position(state), stationary = 0;
      for (let ticks = 0;ticks < 18; ticks += 2) {
        state = await this.port.wait(2);
        const reason = interruption(state);
        if (reason)
          return this.interrupt(state, reason);
        const current = position(state);
        if (distance(current, leg.target) === 0) {
          this.legs.shift();
          this.expected = current;
          if (!escaping) {
            this.safeTrail.push(current);
            this.safeTrail = this.safeTrail.slice(-12);
          }
          return this.record(distance(current, to) === 0 ? "arrived" : "progress", state);
        }
        stationary = distance(previous, current) === 0 ? stationary + 2 : 0;
        if (stationary >= 6)
          return this.block(state, to, "no-progress");
        previous = current;
      }
      return this.block(state, to, "leg-timeout");
    } catch (error) {
      return this.block(state, to, `dispatch: ${String(error)}`);
    }
  }
}

// src/economy/metalworking.ts
import { readFileSync as readFileSync3 } from "fs";
import { resolve as resolve2 } from "path";

// src/training/catalog.ts
import { readFileSync as readFileSync2 } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
var GUIDE_REVIEW = {
  reviewedAt: "2026-09-07",
  sources: [
    { id: "melee", url: "https://oldschool.runescape.wiki/w/Free-to-play_melee_training", hint: "Early Lumbridge chickens, cows and goblins; equipment and food matter." },
    { id: "ranged", url: "https://www.osrsguide.com/osrs-ranged-guide/", hint: "Lumbridge animals and goblins, then Barbarian Village; treat level bands as trial hints." }
  ],
  excluded: ["Minotaurs, flesh crawlers, ankou and Stronghold routes: absent from this 2004 content", "Modern items, rates, banking, safespots and unlock assumptions are not imported", "Giants and other floor/quest routes await verified transitions"]
};
var definitions = [
  ["chicken", 1],
  ["cow", 1],
  ["goblin", 5],
  ["goblin_armed", 5],
  ["goblin_helmet", 5],
  ["barbarian", 20]
];
var hints = [
  ["east-chickens", "Lumbridge east chicken enclosure", "chicken", "m50_51"],
  ["fred-chickens", "Fred farm chickens", "chicken", "m49_51"],
  ["east-cows", "Lumbridge east cattle field", "cow", "m50_51"],
  ["windmill-cows", "Lumbridge west cattle field", "cow", "m49_51"],
  ["lumbridge-goblins", "East Lumbridge goblins", "goblin", "m50_50"],
  ["lumbridge-armed-goblins", "North Lumbridge armed goblins", "goblin_armed", "m50_51"],
  ["village-barbarians", "Barbarian Village ground floor", "barbarian", "m48_53"]
];
function mapEntries(contents, mapName, section) {
  const [, mx, mz] = /^m(\d+)_(\d+)$/.exec(mapName);
  const block = contents.split(`==== ${section} ====`)[1]?.split("====")[0] ?? "";
  return [...block.matchAll(/^(\d+) (\d+) (\d+): (\d+)(?: (\d+))?(?: (\d+))?/gm)].map((m) => ({
    level: Number(m[1]),
    x: Number(mx) * 64 + Number(m[2]),
    z: Number(mz) * 64 + Number(m[3]),
    id: Number(m[4]),
    shape: Number(m[5] ?? 0),
    angle: Number(m[6] ?? 0)
  }));
}
function loadCatalog(upstream = resolve(import.meta.dir, "../../../tmp/clawscape/upstream")) {
  const evidence = [], hash = createHash("sha256");
  const read = (path) => {
    const data = readFileSync2(resolve(upstream, path), "utf8");
    hash.update(path).update(data);
    evidence.push(path);
    return data;
  };
  const pack = read("server/content/pack/npc.pack");
  const configPath = "server/content/scripts/_unpack/225/all.npc";
  const configs = read(configPath);
  const monsters = definitions.map(([symbol, minSkill]) => {
    const id = Number(new RegExp(`^(\\d+)=${symbol}$`, "m").exec(pack)?.[1]);
    const block = configs.split(`[${symbol}]`)[1]?.split(`
[`)[0] ?? "";
    const field = (key) => new RegExp(`^${key}=(.+)$`, "m").exec(block)?.[1]?.trim();
    const name = field("name"), combatLevel = Number(field("vislevel")), hp = Number(field("hitpoints"));
    if (!Number.isInteger(id) || !name || !/op\d=Attack/.test(block) || !(combatLevel > 0 && hp > 0))
      throw new Error(`Unsupported catalog monster: ${symbol}`);
    return { id, symbol, name, combatLevel, hp, minSkill, respawnTicks: Number(field("respawnrate") ?? 100), source: `${configPath}#${symbol}` };
  });
  const maps = new Map;
  const sites = hints.map(([id, name, symbol, mapName]) => {
    const source = `server/content/maps/${mapName}.jm2`;
    if (!maps.has(mapName))
      maps.set(mapName, read(source));
    const monster = monsters.find((m) => m.symbol === symbol);
    const points = mapEntries(maps.get(mapName), mapName, "NPC").filter((p) => p.id === monster.id && p.level === 0).map(({ x, z, level }) => ({ x, z, level }));
    if (!points.length)
      throw new Error(`Missing source spawns: ${id}`);
    return { id, name, monster, points, source, guideIds: symbol === "barbarian" ? ["ranged"] : ["melee", "ranged"] };
  });
  read("sdk/collision-data.json");
  hash.update(JSON.stringify({ guides: GUIDE_REVIEW, definitions, hints }));
  return { namespace: `local-274-${hash.digest("hex")}`, monsters, sites, evidence };
}

// src/economy/metalworking.ts
var economyTrack = (_s, m) => m?.objectives?.intent?.track ?? "woodworking";
var total = (items, id) => items.filter((i) => i.id === id).reduce((n, i) => n + Number(i.count), 0);
var pickLevels = { bronze: 1, iron: 1, steel: 6, mithril: 21, adamant: 31, rune: 41 };
var canMine = (s) => [...s.inventory ?? [], ...s.equipment ?? []].some((i) => {
  const metal = /^(bronze|iron|steel|mithril|adamant|rune) pickaxe$/i.exec(i.name)?.[1]?.toLowerCase();
  return metal && skillLevel(s, "mining") >= pickLevels[metal];
});
var rockHints;
function miningHints() {
  if (!rockHints) {
    const map = "m51_52";
    rockHints = mapEntries(readFileSync3(resolve2(import.meta.dir, "../../../tmp/clawscape/upstream/server/content/maps/" + map + ".jm2"), "utf8"), map, "LOC").filter((p) => p.level === 0 && p.x >= 3280 && p.x <= 3292 && p.z >= 3360 && p.z <= 3372 && [2090, 2091, 2092, 2093, 2094, 2095].includes(p.id));
  }
  return rockHints;
}
var action = (id, type, fields = {}, waitTicks = 2) => ({ id: "economy-metal-" + id, type, fields, waitTicks });
var walk = (id, x, z) => action(id, "walkTo", { x, z, level: 0 });
var close = () => action("close", "closeModal", {}, 1);
var product = (s, bar) => bar === 2349 ? skillLevel(s, "smithing") >= 5 ? { name: "Bronze arrowheads", id: 39 } : { name: "Bronze dagger", id: 1205 } : skillLevel(s, "smithing") >= 20 ? { name: "Iron arrowheads", id: 40 } : { name: "Iron dagger", id: 1203 };
function metalDialog(s, m) {
  const mm = m.metal;
  if (mm?.phase !== "smith" || !mm.product || !s.dialog?.isOpen || s.dialog.isWaiting)
    return;
  const options = s.dialog.options ?? [];
  if (options.some((o) => /continue|congratulations/i.test(o.text)))
    return;
  const norm = (x) => x.toLowerCase().replace(/[^a-z]/g, "");
  const chosen = options.find((o) => Number.isInteger(o.index) && norm(o.text).includes(norm(mm.product)));
  if (chosen)
    return action("smith-product", "clickDialogOption", { optionIndex: chosen.index }, 5);
  mm.smithBlockedUntil = Date.now() + 5 * 60000;
  mm.phase = "bank";
  m.reason = "Smithing product not exposed by the observed interface; bank bars and continue safe smelting";
  return close();
}
function metalNext(s, m, blocked = () => false) {
  const mm = m.metal ??= {}, inv = s.inventory ?? [], bank = s.bank?.isOpen ? s.bank.items ?? [] : m.bankItems ?? [];
  const count = (id) => total(inv, id), all = (id) => count(id) + total(bank, id);
  const bankAction = () => bankAt(s, undefined, blocked, m.bankCooldowns ??= {});
  const service = (name, x, z) => {
    if (Math.max(Math.abs(s.player.worldX - x), Math.abs(s.player.worldZ - z)) === 0) {
      if (mm.serviceTick !== s.tick) {
        mm.serviceTick = s.tick;
        mm.servicePolls = (mm.servicePolls ?? 0) + 1;
      }
      if ((mm.servicePolls ?? 0) >= 3) {
        mm[name === "furnace" ? "smeltBlockedUntil" : "smithBlockedUntil"] = Date.now() + 300000;
        mm.phase = "bank";
        mm.servicePolls = 0;
        m.reason = "Arrived at " + name + " hint but no usable service was observed; bank inputs and defer";
        return bankAction();
      }
      return [action("inspect-" + name, "wait", {}, 3)];
    }
    mm.servicePolls = 0;
    return [walk(name, x, z)];
  };
  delete m.processing;
  delete m.product;
  delete m.harvest;
  delete m.selling;
  m.selectedSite = "varrock-southeast-mine";
  m.goal = "mining-smithing-supply-chain";
  m.reason = m.objectives?.intent?.reason ?? "Develop a useful mining/smithing supply chain; the task is selected by its outcome, not by maxing another skill.";
  const useful = (i) => isFletchedOutput(i) || /^(.*logs|logs|.*ore|.*bar|.*arrowheads|.*dagger|uncut .*)$/i.test(i.name);
  if (s.bank?.isOpen) {
    m.bankItems = bank;
    const keep = (i) => i.id === 995 || i.id === 2347 || /pickaxe$/i.test(i.name) || i.optionsWithIndex?.some((o) => /^eat$/i.test(o.text));
    const deposit = !mm.loading && inv.find((i) => useful(i) || !keep(i));
    if (deposit)
      return [action("deposit-" + deposit.id, "bankDeposit", { slot: deposit.slot, amount: count(deposit.id) })];
    if (!canMine(s)) {
      const tool = bank.find((i) => canMine({ ...s, inventory: [i], equipment: [] }));
      if (tool && inv.length < 28)
        return [action("withdraw-pick", "bankWithdraw", { slot: tool.slot, amount: 1 })];
    }
    if (!count(2347)) {
      const hammer = bank.find((i) => i.id === 2347);
      if (hammer && inv.length < 28)
        return [action("withdraw-hammer", "bankWithdraw", { slot: hammer.slot, amount: 1 })];
    }
    const coins = bank.find((i) => i.id === 995);
    if (count(995) < 25 && coins && (!count(2347) || !canMine(s)))
      return [action("withdraw-tool-cash", "bankWithdraw", { slot: coins.slot, amount: Math.min(25 - count(995), coins.count) })];
    if (count(995) > 250) {
      const c = inv.find((i) => i.id === 995);
      return [action("secure-gold", "bankDeposit", { slot: c.slot, amount: count(995) - 250 })];
    }
    if (!mm.loading) {
      const bar = bank.find((i) => [2349, 2351].includes(i.id) && i.count > 0 && (i.id === 2349 || skillLevel(s, "smithing") >= 15));
      if (bar && (mm.smithBlockedUntil ?? 0) <= Date.now() && inv.length < 28) {
        mm.loading = true;
        mm.phase = "smith";
        return [action("withdraw-bars", "bankWithdraw", { slot: bar.slot, amount: Math.min(12, 28 - inv.length, bar.count) })];
      }
      if ((mm.smeltBlockedUntil ?? 0) <= Date.now() && total(bank, 436) > 0 && total(bank, 438) > 0 && 28 - inv.length >= 2) {
        mm.loading = true;
        mm.phase = "smelt";
        mm.ore = 436;
      }
    }
    if (mm.loading && mm.phase === "smelt") {
      const pairs = Math.min(8, total(bank, 436) + count(436), total(bank, 438) + count(438), Math.floor((28 - inv.length + count(436) + count(438)) / 2));
      const id = [436, 438].find((id) => count(id) < pairs), row = bank.find((i) => i.id === id);
      if (row)
        return [action("withdraw-paired-ore", "bankWithdraw", { slot: row.slot, amount: pairs - count(row.id) })];
    }
    if (!mm.loading)
      mm.phase = "gather";
    return [close()];
  }
  delete mm.loading;
  if (!canMine(s)) {
    m.goal = "obtain-mining-tool";
    if (bank.some((i) => canMine({ ...s, inventory: [i], equipment: [] })) || count(995) < 6)
      return bankAction();
    if (s.shop?.isOpen) {
      const pick = s.shop.shopItems?.find((i) => i.name === "Bronze pickaxe" && i.count > 0 && i.buyPrice > 0 && i.buyPrice <= count(995) - 5);
      return pick ? [action("buy-pick", "shopBuy", { slot: pick.slot, amount: 1, itemId: pick.id, expectedPrice: pick.buyPrice })] : [close()];
    }
    return shopAt(s, /^bob$/i, { x: 3232, z: 3203 });
  }
  if (!count(2347)) {
    if (total(bank, 2347) || count(995) < 6)
      return bankAction();
    if (s.shop?.isOpen) {
      const hammer = s.shop.shopItems?.find((i) => i.id === 2347 && i.count > 0 && i.buyPrice > 0 && i.buyPrice <= count(995) - 5);
      return hammer ? [action("buy-hammer", "shopBuy", { slot: hammer.slot, amount: 1, itemId: hammer.id, expectedPrice: hammer.buyPrice })] : [close()];
    }
    return shopAt(s, /^shop keeper$|^shop assistant$/i, { x: 3218, z: 3415 });
  }
  if (s.shop?.isOpen)
    return [close()];
  if (inv.some((i) => isFletchedOutput(i) || /^(.*logs|logs)$/i.test(i.name)) || mm.phase === "bank")
    return bankAction();
  const useIron = mm.phase === "smelt" ? mm.ore === 440 : skillLevel(s, "mining") >= 15 && skillLevel(s, "smithing") >= 15;
  mm.ore = useIron ? 440 : 436;
  const ready = useIron ? count(440) > 0 : count(436) > 0 && count(438) > 0;
  if (mm.phase === "smelt" && !ready)
    mm.phase = "smith";
  if (mm.phase === "smelt") {
    if ((mm.smeltBlockedUntil ?? 0) > Date.now()) {
      mm.phase = "bank";
      return bankAction();
    }
    m.goal = "smelt-" + (useIron ? "iron" : "bronze");
    const furnace = s.nearbyLocs?.find((l) => l.id === 2781 && l.reachable === true && l.optionsWithIndex?.some((o) => /^smelt$/i.test(o.text)));
    if (Number(s.player.animId) >= 0)
      return [action("smelt-working", "wait", {}, 3)];
    if (!furnace)
      return service("furnace", 3229, 3255);
    mm.servicePolls = 0;
    return [action("smelt-ore", "useItemOnLoc", { itemSlot: inv.find((i) => i.id === mm.ore).slot, x: furnace.x, z: furnace.z, locId: furnace.id }, 5)];
  }
  const bar = count(2349) > 0 ? 2349 : count(2351) > 0 ? 2351 : undefined;
  if (mm.phase === "smith" && bar) {
    if ((mm.smithBlockedUntil ?? 0) > Date.now()) {
      mm.phase = "bank";
      return bankAction();
    }
    const target = product(s, bar);
    mm.product = target.name;
    mm.productId = target.id;
    m.goal = "smith-" + target.name.toLowerCase().replaceAll(" ", "-");
    const dialog = metalDialog(s, m);
    if (dialog)
      return [dialog];
    if (s.modalOpen) {
      mm.smithBlockedUntil = Date.now() + 300000;
      mm.phase = "bank";
      m.reason = "Smithing inventory interface needs a verified product mapping; retain bars";
      return [close()];
    }
    if (Number(s.player.animId) >= 0)
      return [action("smith-working", "wait", {}, 3)];
    const anvil = s.nearbyLocs?.find((l) => l.id === 2783 && l.reachable === true);
    if (!anvil)
      return service("anvil", 3187, 3425);
    mm.servicePolls = 0;
    return [action("smith-input", "useItemOnLoc", { itemSlot: inv.find((i) => i.id === bar).slot, x: anvil.x, z: anvil.z, locId: anvil.id }, 2)];
  }
  if (mm.phase === "smith") {
    mm.phase = "bank";
    return bankAction();
  }
  if (ready && (useIron ? count(440) >= 12 : count(436) >= 8 && count(438) >= 8)) {
    mm.phase = "smelt";
    return metalNext(s, m, blocked);
  }
  if (inv.length >= 28) {
    if (ready) {
      mm.phase = "smelt";
      return metalNext(s, m, blocked);
    }
    mm.phase = "bank";
    return bankAction();
  }
  if ((mm.cooldownUntil ?? 0) > Date.now())
    return [action("resource-cooldown", "wait", {}, 5)];
  const wanted = useIron ? 440 : all(436) <= all(438) ? 436 : 438;
  const ids = wanted === 436 ? [2090, 2091] : wanted === 438 ? [2094, 2095] : [2092, 2093];
  const hints = miningHints().filter((p) => ids.includes(p.id));
  const rocks = (s.nearbyLocs ?? []).filter((l) => ids.includes(l.id) && l.reachable === true && hints.some((p) => p.x === l.x && p.z === l.z) && l.optionsWithIndex?.some((o) => /^mine$/i.test(o.text))).sort((a, b) => a.distance - b.distance);
  m.goal = "mine-" + (wanted === 436 ? "copper" : wanted === 438 ? "tin" : "iron");
  if (rocks[0]) {
    delete mm.missing;
    const r = rocks[0];
    return [action("mine-" + r.x + "-" + r.z, "interactLoc", { locId: r.id, x: r.x, z: r.z, optionIndex: r.optionsWithIndex.find((o) => /^mine$/i.test(o.text)).opIndex }, 5)];
  }
  if (Math.max(Math.abs(s.player.worldX - 3285), Math.abs(s.player.worldZ - 3365)) > 10)
    return [walk("mine-route", 3285, 3365)];
  if (mm.lastTick !== s.tick) {
    mm.lastTick = s.tick;
    mm.missing = (mm.missing ?? 0) + 1;
  }
  if ((mm.missing ?? 0) >= 3) {
    mm.cooldownUntil = Date.now() + 60000;
    mm.missing = 0;
    m.reason = "No source-matched live ore found; retry after depletion cooldown";
  }
  return [action("ore-respawn", "wait", {}, 5)];
}
function validateMetal(s, a, before) {
  if (!a.id.startsWith("economy-metal-"))
    return true;
  if (before && /^bank(Withdraw|Deposit)$/.test(a.type)) {
    const old = a.type === "bankWithdraw" ? before.bank?.items : before.inventory, live = a.type === "bankWithdraw" ? s.bank?.items : s.inventory;
    const id = old?.find((i) => i.slot === a.fields.slot)?.id;
    return s.bank?.isOpen === true && id !== undefined && live?.some((i) => i.slot === a.fields.slot && i.id === id) && total(live ?? [], id) >= a.fields.amount;
  }
  if (a.type === "interactLoc")
    return s.nearbyLocs?.some((l) => l.id === a.fields.locId && l.x === a.fields.x && l.z === a.fields.z && l.reachable === true && l.optionsWithIndex?.some((o) => o.opIndex === a.fields.optionIndex && /^mine$/i.test(o.text)));
  if (before && a.type === "clickDialogOption")
    return s.dialog?.isOpen && s.dialog.options?.some((o) => o.index === a.fields.optionIndex && o.text === before.dialog?.options?.find((p) => p.index === o.index)?.text);
  if (a.type === "shopBuy")
    return s.shop?.isOpen === true && s.shop.shopItems?.some((i) => i.id === a.fields.itemId && i.slot === a.fields.slot && i.count > 0 && i.buyPrice === a.fields.expectedPrice) && total(s.inventory ?? [], 995) >= a.fields.expectedPrice + 5;
  if (a.type === "useItemOnLoc")
    return s.inventory?.some((i) => i.slot === a.fields.itemSlot && [436, 438, 440, 2349, 2351].includes(i.id) && (!before || i.id === before.inventory?.find((b) => b.slot === i.slot)?.id)) && s.nearbyLocs?.some((l) => l.id === a.fields.locId && l.x === a.fields.x && l.z === a.fields.z && l.reachable === true);
  return true;
}

// src/economy/bowmaking.ts
var BOWS = [
  { input: 50, output: 841, level: 5, name: "Shortbow" },
  { input: 48, output: 839, level: 10, name: "Longbow" },
  { input: 54, output: 843, level: 20, name: "Oak shortbow" },
  { input: 56, output: 845, level: 25, name: "Oak longbow" },
  { input: 60, output: 849, level: 35, name: "Willow shortbow" },
  { input: 58, output: 847, level: 40, name: "Willow longbow" },
  { input: 64, output: 853, level: 50, name: "Maple shortbow" },
  { input: 62, output: 851, level: 55, name: "Maple longbow" },
  { input: 68, output: 857, level: 65, name: "Yew shortbow" },
  { input: 66, output: 855, level: 70, name: "Yew longbow" },
  { input: 72, output: 861, level: 80, name: "Magic shortbow" },
  { input: 70, output: 859, level: 85, name: "Magic longbow" }
];
var BOW_SITES = { sheep: { x: 3051, z: 3517, level: 0 }, wheel: { x: 3082, z: 3430, level: 0 }, flax: { x: 2889, z: 3424, level: 0 }, shop: { x: 3218, z: 3415, level: 0 } };
var total2 = (items, id) => items.filter((i) => i.id === id).reduce((n, i) => n + Number(i.count), 0);
var at = (s, p) => s.player.level === p.level && Math.max(Math.abs(s.player.worldX - p.x), Math.abs(s.player.worldZ - p.z)) === 0;
var a = (id, type, fields = {}, waitTicks = 2) => ({ id: "economy-bow-" + id, type, fields, waitTicks });
var material = (id) => [1737, 1759, 1779, 1777].includes(id) || BOWS.some((b) => b.input === id);
var bowReserve = (m) => m.bowmaking?.active && m.bowmaking.input !== undefined ? { [m.bowmaking.input]: Math.max(0, (m.bowmaking.target ?? 8) - (m.bowmaking.made ?? 0)), 1777: Math.max(0, (m.bowmaking.target ?? 8) - (m.bowmaking.made ?? 0)) } : {};
function bowBlocked(m, reason, now = Date.now()) {
  const b = m.bowmaking ??= {};
  b.active = false;
  b.reason = reason;
  b.cooldownUntil = now + 10 * 60000;
  if (m.objectives?.intent?.mode === "finish")
    m.objectives.blocked[m.objectives.intent.id] = b.cooldownUntil;
  m.goal = "bowmaking-blocked";
  m.reason = reason;
}
function bowNext(s, m, blocked = () => false, now = Date.now()) {
  const intent = m.objectives?.intent;
  if (intent?.mode !== "finish")
    return [];
  const b = m.bowmaking ??= {}, inv = s.inventory ?? [], bank = s.bank?.isOpen ? s.bank.items ?? [] : m.bankItems ?? [];
  const count = (id) => total2(inv, id), all = (id) => count(id) + total2(bank, id), remaining = () => Math.max(0, b.target - b.made);
  const close = () => [a("close", "closeModal", {}, 1)];
  const useBank = () => bankAt(s, undefined, blocked, m.bankCooldowns ??= {});
  const fail = (reason) => {
    bowBlocked(m, reason, now);
    return s.shop?.isOpen || s.bank?.isOpen ? close() : [a("deferred", "wait", {}, 3)];
  };
  if ((b.cooldownUntil ?? 0) > now)
    return [a("cooldown", "wait", {}, 5)];
  if (!b.active) {
    const recipe = BOWS.find((r) => r.input === intent.inputId && r.output === intent.outputId && skillLevel(s, "fletching") >= r.level);
    if (!recipe || all(recipe.input) <= 0)
      return fail("No usable unstrung stock; retain the finishing goal until inputs exist");
    const price = m.objectives.prices[recipe.input], strings = m.objectives.prices[1777];
    Object.assign(b, {
      active: true,
      phase: "prepare",
      input: recipe.input,
      output: recipe.output,
      target: Math.min(8, all(recipe.input)),
      made: 0,
      started: now,
      lastProgress: now,
      life: s.player.lifeId,
      failed: 0,
      cost: 0,
      inputValue: price && now - price.at < 30 * 60000 ? price.price : null,
      stringsValue: all(1777) > 0 ? strings && now - strings.at < 30 * 60000 ? strings.price : null : 0
    });
    delete m.processing;
    delete m.product;
    delete m.harvest;
    delete m.selling;
  }
  if (b.life !== s.player.lifeId || s.player.isDead)
    return fail("Life changed during bowmaking; reassess supplies before another trial");
  if (now - (b.lastProgress ?? now) > 8 * 60000)
    return fail("No verified bowmaking progress for eight minutes; defer this chain");
  m.goal = "bowmaking-" + b.phase;
  m.reason = b.reason = `Crafting ${skillLevel(s, "crafting")}/10; finish ${b.made}/${b.target} ${intent.inputName} using flax bowstrings, not wool`;
  const needWool = skillLevel(s, "crafting") < 10;
  const needsStrings = all(1777) < remaining();
  if ((b.phase === "wool" || b.phase === "spin") && s.interface?.isOpen) {
    const label = b.phase === "wool" ? "Wool" : "Flax", option = productionDialog(s.interface.options ?? [], label);
    if (option?.componentId)
      return [a(b.phase === "wool" ? "spin-wool" : "spin-flax", "clickComponent", { componentId: option.componentId }, 3)];
    return fail("Spinning interface did not expose the observed material and Make 10 option");
  }
  if (s.modalOpen && !s.bank?.isOpen && !s.shop?.isOpen && !s.interface?.isOpen && b.phase !== "complete")
    return [a("close-stalled-interface", "closeModal", {}, 1)];
  const visit = (key) => {
    const p = BOW_SITES[key];
    if (!at(s, p))
      return [a("route-" + key, "walkTo", p)];
    if (b.missing?.key !== key)
      b.missing = { key, tick: s.tick, count: 0 };
    if (b.missing.tick !== s.tick) {
      b.missing.tick = s.tick;
      b.missing.count++;
    }
    return b.missing.count >= 3 ? fail("Reached " + key + " hint but no usable target was observed") : [a("inspect-" + key, "wait", {}, 4)];
  };
  if (s.bank?.isOpen) {
    m.bankItems = bank;
    if (b.phase === "deposit" || b.phase === "prepare") {
      const row = inv.find((i) => material(i.id) || i.id === b.output || /^(.*logs|logs|.*ore|.*bar|arrow shaft)$/i.test(i.name));
      if (row && row.id !== b.input && !(row.id === b.output && b.made === 0))
        return [a("deposit-material", "bankDeposit", { slot: row.slot, amount: count(row.id) })];
      if (b.phase === "deposit" && b.made >= b.target) {
        b.phase = "complete";
        return close();
      }
      b.phase = "load";
    }
    const required = new Set(needWool && needsStrings ? [1737] : needsStrings ? [1779, 1777] : [b.input, 1777]);
    const clutter = inv.find((i) => material(i.id) && !required.has(i.id) || i.id === b.output && b.made > 0);
    if (clutter)
      return [a("bank-spare-material", "bankDeposit", { slot: clutter.slot, amount: count(clutter.id) })];
    const spare = inv.find((i) => [841, 1351, 1265, 1438, 946].includes(i.id) && i.id !== b.input && i.id !== b.output);
    if (spare)
      return [a("bank-spare-tool", "bankDeposit", { slot: spare.slot, amount: count(spare.id) })];
    const reserve = count(995) > 100 ? inv.find((i) => i.id === 995) : undefined;
    if (reserve)
      return [a("secure-cash", "bankDeposit", { slot: reserve.slot, amount: count(995) - 100 })];
    const money = bank.find((i) => i.id === 995);
    if (count(995) < 10 && !count(1735) && money)
      return [a("tool-cash", "bankWithdraw", { slot: money.slot, amount: Math.min(10 - count(995), money.count) })];
    const food = bank.find((i) => /^(cabbage|shrimps|anchovies|trout|salmon|bread|lobster|swordfish)$/i.test(i.name));
    if (foodCount(s) < 3 && food && inv.length < 25)
      return [a("withdraw-food", "bankWithdraw", { slot: food.slot, amount: Math.min(3 - foodCount(s), food.count) })];
    const tool = bank.find((i) => i.id === 1735);
    if (needWool && needsStrings && !count(1735) && tool && inv.length < 28)
      return [a("withdraw-shears", "bankWithdraw", { slot: tool.slot, amount: 1 })];
    let desired, quantity = 0;
    if (needWool && needsStrings) {
      desired = 1737;
      quantity = 8;
    } else if (needsStrings) {
      desired = 1779;
      quantity = remaining() - all(1777);
    } else if (count(1777) < remaining()) {
      desired = 1777;
      quantity = remaining();
    } else {
      desired = b.input;
      quantity = remaining();
    }
    const row = bank.find((i) => i.id === desired);
    if (row && quantity > count(desired) && inv.length < 28)
      return [a("withdraw-input", "bankWithdraw", { slot: row.slot, amount: Math.min(quantity - count(desired), row.count, 28 - inv.length) })];
    b.phase = needWool && needsStrings ? count(1737) > 0 ? "wool" : "shear" : count(1777) >= remaining() ? count(b.input) >= remaining() ? "string" : "load" : count(1779) > 0 ? "spin" : "flax";
    return close();
  }
  if (s.shop?.isOpen) {
    if (needWool && needsStrings && !count(1735)) {
      const row = s.shop.shopItems?.find((i) => i.id === 1735 && i.count > 0 && i.buyPrice > 0 && i.buyPrice <= count(995) - 5 && i.buyPrice <= 10);
      if (row && inv.length < 28)
        return [a("buy-shears", "shopBuy", { slot: row.slot, amount: 1, itemId: row.id, expectedPrice: row.buyPrice })];
      return fail("No affordable shears in the observed general store; preserve cash and defer");
    }
    return close();
  }
  if (b.phase === "complete")
    return close();
  if (b.phase === "prepare" || b.phase === "deposit")
    return useBank();
  if (foodCount(s) < 1)
    return fail("Bowmaking travel needs carried food; replenish supplies before retrying");
  if (Number(s.player.animId ?? -1) >= 0)
    return [a("working", "wait", {}, 3)];
  if (b.made >= b.target) {
    b.phase = "deposit";
    return useBank();
  }
  if (count(1777) > 0 && count(b.input) > 0) {
    b.phase = "string";
    return [a("string", "useItemOnItem", { sourceSlot: inv.find((i) => i.id === 1777).slot, targetSlot: inv.find((i) => i.id === b.input).slot }, 3)];
  }
  if (!needsStrings) {
    b.phase = "load";
    return useBank();
  }
  if (needWool) {
    if (count(1737) > 0 && (count(1737) >= 8 || b.phase === "wool" || inv.length >= 28))
      b.phase = "wool";
    else
      b.phase = "shear";
    if (b.phase === "shear") {
      if (!count(1735)) {
        if (all(1735) || count(995) < 6)
          return useBank();
        const npc = s.nearbyNpcs?.find((n) => /^Shop keeper$|^Shop assistant$/i.test(n.name) && n.reachable === true && n.optionsWithIndex?.some((o) => /^trade$/i.test(o.text)));
        if (npc)
          return [a("trade-tools", "interactNpc", { npcIndex: npc.index, optionIndex: npc.optionsWithIndex.find((o) => /^trade$/i.test(o.text)).opIndex })];
        return visit("shop");
      }
      if (inv.length >= 28) {
        b.phase = "prepare";
        return useBank();
      }
      const sheep = s.nearbyNpcs?.filter((n) => n.id === 43 && n.reachable === true && n.distance <= 8 && n.x >= 3043 && n.x <= 3060 && n.z >= 3507 && n.z < 3520).sort((a, b) => a.distance - b.distance)[0];
      if (!sheep)
        return visit("sheep");
      delete b.missing;
      return [a("shear", "useItemOnNpc", { itemSlot: inv.find((i) => i.id === 1735).slot, npcIndex: sheep.index }, 3)];
    }
  } else
    b.phase = count(1779) > 0 ? "spin" : "flax";
  if (b.phase === "flax") {
    if (total2(bank, 1779) > 0 || total2(bank, 1777) > count(1777))
      return useBank();
    if (inv.length >= 28) {
      b.phase = "prepare";
      return useBank();
    }
    const loc = s.nearbyLocs?.filter((l) => l.id === 2646 && l.reachable === true && l.x >= 2880 && l.x <= 2895 && l.z >= 3418 && l.z <= 3444 && l.optionsWithIndex?.some((o) => /^pick$/i.test(o.text))).sort((a, b) => a.distance - b.distance)[0];
    if (!loc)
      return visit("flax");
    delete b.missing;
    return [a("pick-flax", "interactLoc", { locId: loc.id, x: loc.x, z: loc.z, optionIndex: loc.optionsWithIndex.find((o) => /^pick$/i.test(o.text)).opIndex }, 3)];
  }
  if (b.phase === "spin" && count(1779) + count(1777) < remaining() && inv.length < 28 && Math.abs(s.player.worldX - BOW_SITES.flax.x) < 15) {
    const loc = s.nearbyLocs?.find((l) => l.id === 2646 && l.reachable === true && l.optionsWithIndex?.some((o) => /^pick$/i.test(o.text)));
    if (loc)
      return [a("pick-flax", "interactLoc", { locId: loc.id, x: loc.x, z: loc.z, optionIndex: loc.optionsWithIndex.find((o) => /^pick$/i.test(o.text)).opIndex }, 3)];
    return [a("flax-respawn", "wait", {}, 5)];
  }
  const input = b.phase === "wool" ? 1737 : 1779, row = inv.find((i) => i.id === input);
  if (!row) {
    b.phase = "prepare";
    return useBank();
  }
  const wheel = s.nearbyLocs?.find((l) => l.id === 2644 && l.x === 3081 && l.z === 3430 && l.reachable === true && l.optionsWithIndex?.some((o) => /^spin$/i.test(o.text)));
  if (!wheel || !at(s, BOW_SITES.wheel))
    return visit("wheel");
  delete b.missing;
  return [a(input === 1737 ? "open-spin-wool" : "open-spin-flax", "useItemOnLoc", { itemSlot: row.slot, locId: wheel.id, x: wheel.x, z: wheel.z }, 3)];
}
function validateBow(s, a, before) {
  if (!a.id.startsWith("economy-bow-"))
    return true;
  const f = a.fields ?? {}, inv = s.inventory ?? [];
  const same = (slot) => inv.find((i) => i.slot === slot)?.id === before.inventory?.find((i) => i.slot === slot)?.id;
  if (a.type === "useItemOnNpc")
    return same(f.itemSlot) && inv.some((i) => i.slot === f.itemSlot && i.id === 1735) && s.nearbyNpcs?.some((n) => n.index === f.npcIndex && n.id === 43 && n.reachable === true && n.distance <= 8 && n.z < 3520);
  if (a.type === "useItemOnItem")
    return same(f.sourceSlot) && same(f.targetSlot) && inv.some((i) => i.slot === f.sourceSlot && i.id === 1777) && BOWS.some((r) => r.input === inv.find((i) => i.slot === f.targetSlot)?.id && skillLevel(s, "fletching") >= r.level);
  if (a.type === "clickComponent")
    return s.interface?.isOpen === true && before.interface?.options?.some((o) => o.componentId === f.componentId && /^make 10/i.test(o.text));
  if (a.type === "useItemOnLoc")
    return same(f.itemSlot) && inv.some((i) => i.slot === f.itemSlot && (i.id === 1737 || i.id === 1779 && skillLevel(s, "crafting") >= 10)) && s.player.level === 0 && s.nearbyLocs?.some((l) => l.id === 2644 && l.x === f.x && l.z === f.z && l.reachable === true);
  if (a.type === "interactLoc")
    return s.player.level === 0 && s.nearbyLocs?.some((l) => l.id === f.locId && l.x === f.x && l.z === f.z && l.reachable === true && l.optionsWithIndex?.some((o) => o.opIndex === f.optionIndex && /^pick$/i.test(o.text)));
  if (a.type === "interactNpc")
    return s.nearbyNpcs?.some((n) => n.index === f.npcIndex && n.id === before.nearbyNpcs?.find((n) => n.index === f.npcIndex)?.id && n.reachable === true && n.optionsWithIndex?.some((o) => o.opIndex === f.optionIndex && /^trade$/i.test(o.text)));
  if (a.type === "shopBuy")
    return s.shop?.isOpen === true && s.shop.shopItems?.some((i) => i.id === 1735 && i.slot === f.slot && i.count > 0 && i.buyPrice === f.expectedPrice) && total2(inv, 995) >= f.expectedPrice + 5;
  if (/^bank(Withdraw|Deposit)$/.test(a.type)) {
    const old = a.type === "bankWithdraw" ? before.bank?.items : before.inventory, live = a.type === "bankWithdraw" ? s.bank?.items : inv;
    const id = old?.find((i) => i.slot === f.slot)?.id;
    return s.bank?.isOpen === true && id !== undefined && live?.some((i) => i.slot === f.slot && i.id === id) && total2(live ?? [], id) >= f.amount;
  }
  return true;
}
function observeBow(before, after, a, m, now = Date.now()) {
  const b = m.bowmaking;
  if (!b?.active)
    return;
  if (before.player.lifeId !== after.player.lifeId || after.player.isDead) {
    bowBlocked(m, "Life changed during bowmaking", now);
    return;
  }
  const inv = before.inventory ?? [], next = after.inventory ?? [], change = (id) => total2(next, id) - total2(inv, id);
  b.verified ??= { wool: 0, strings: 0, bows: 0 };
  const key = a.id === "economy-bow-spin-wool" ? "wool" : a.id === "economy-bow-spin-flax" ? "strings" : a.id === "economy-bow-string" ? "bows" : undefined;
  const input = key === "wool" ? 1737 : key === "strings" ? 1779 : b.input, output = key === "wool" ? 1759 : key === "strings" ? 1777 : b.output;
  const made = key && change(input) < 0 && change(output) > 0 && (key !== "bows" || change(1777) < 0) ? Math.min(-change(input), change(output)) : 0;
  if (made && key) {
    b.verified[key] += made;
    if (key === "bows")
      b.made = (b.made ?? 0) + made;
    b.lastProgress = now;
    b.failed = 0;
  } else if (key) {
    b.failed = (b.failed ?? 0) + 1;
    if (b.failed >= 2)
      bowBlocked(m, "Repeated " + key + " action produced no verified input/output change", now);
  }
  if (a.id === "economy-bow-shear" && change(1737) > 0 || a.id === "economy-bow-pick-flax" && change(1779) > 0 || /^bank(Deposit|Withdraw)$/.test(a.type) && JSON.stringify(inv) !== JSON.stringify(next)) {
    b.lastProgress = now;
    b.failed = 0;
  }
  if (a.id === "economy-bow-buy-shears" && change(1735) > 0 && change(995) < 0) {
    b.cost = (b.cost ?? 0) - change(995);
    b.lastProgress = now;
  }
  if (a.type === "closeModal" && before.bank?.isOpen && !after.bank?.isOpen && b.phase === "complete") {
    b.active = false;
    b.trialComplete = true;
    b.completedAt = now;
    const rows = (b.samples ??= {})[b.output] ??= [];
    rows.push({ units: b.made, seconds: (now - b.started) / 1000, inputValue: b.inputValue ?? null, stringsValue: b.stringsValue ?? null, cost: b.cost ?? 0, at: now });
    b.samples[b.output] = rows.slice(-5);
    m.reason = "Verified finished-bow batch banked; compare net value before the next job";
    if (m.objectives) {
      delete m.objectives.intent;
      delete m.objectives.cycle;
      m.objectives.completed++;
    }
  }
}

// src/progression-policy.ts
var BANKS = [
  { name: "varrock-west", x: 3185, z: 3436, level: 0 },
  { name: "edgeville", x: 3094, z: 3491, level: 0 }
];
var skillLevel = (s, name) => Number(s.skills?.find((x) => String(x.name).toLowerCase() === name.toLowerCase())?.baseLevel ?? s.skills?.find((x) => String(x.name).toLowerCase() === name.toLowerCase())?.level ?? 1);
var foodCount = (s) => (s.inventory ?? []).filter((i) => i.optionsWithIndex?.some((o) => /^eat$/i.test(o.text))).reduce((n, i) => n + Number(i.count), 0);
function activeOpponent(s) {
  const c = s.player?.combat;
  return c?.inCombat && c.targetType === "npc" ? s.nearbyNpcs?.find((n) => n.index === c.targetIndex && n.optionsWithIndex?.some((o) => /^attack$/i.test(o.text))) : undefined;
}
function shouldHeal(s, ranged = false) {
  const hp = Number(s.player?.hp), max = Number(s.player?.maxHp);
  return Number.isFinite(hp) && max > 0 && hp < max && hp <= max * (ranged ? 0.75 : 0.65) && foodCount(s) > 0;
}
function combatDisposition(s, economy = false, ranged = false) {
  const target = activeOpponent(s);
  const damageAge = Number(s.tick) - Number(s.player?.combat?.lastDamageTick);
  const newUnattributedDamage = Number(s.player?.combat?.lastDamageTick) >= 0 && damageAge >= 0 && damageAge <= 2;
  if (s.player?.combat?.targetType === "player")
    return "recover";
  if (target) {
    const known = /^(rat|giant rat|chicken|cow|cow calf|goblin|man|woman|barbarian|giant spider|skeleton|zombie|hill giant|moss giant)$/i.test(target.name);
    const hp = Number(s.player?.hp), max = Number(s.player?.maxHp);
    const usableAmmo = !ranged || hasUsableArrows(s.combatStyle?.weaponName ?? "", s.equipment ?? []);
    if (!economy && known && usableAmmo && hp > Math.max(4, max * 0.4) && foodCount(s) > 0)
      return "engaged";
    return "recover";
  }
  return newUnattributedDamage ? "recover" : "quiet";
}
function nearbyAmmoRecovery(s) {
  if (s.player?.combat?.inCombat || (s.inventory?.length ?? 28) >= 28)
    return [];
  const arrow = s.groundItems?.filter((i) => i.reachable === true && Number(i.distance) <= 6 && hasUsableArrows(s.combatStyle?.weaponName ?? "", [i])).sort((a, b) => a.distance - b.distance)[0];
  return arrow ? [{ id: "recover-arrows-" + arrow.x + "-" + arrow.z, type: "pickupItem", fields: { x: arrow.x, z: arrow.z, itemId: arrow.id }, waitTicks: 8 }] : [];
}
function quiverRefill(s) {
  const bow = s.combatStyle?.weaponName ?? "";
  if (hasUsableArrows(bow, s.equipment ?? []) || Number(s.player?.hp) <= Number(s.player?.maxHp) * 0.6)
    return [];
  const arrows = s.inventory?.find((i) => hasUsableArrows(bow, [i]) && i.optionsWithIndex?.some((o) => /^wield$|^equip$/i.test(o.text)));
  const option = arrows?.optionsWithIndex.find((o) => /^wield$|^equip$/i.test(o.text));
  return arrows && option ? [{ id: "wield-ammo-" + arrows.slot, type: "useInventoryItem", fields: { slot: arrows.slot, optionIndex: option.opIndex }, waitTicks: 2 }] : [];
}
function meleeTrainingSkill(attack, strength) {
  return strength < 40 ? "strength" : attack < 40 ? "attack" : "strength";
}
function fletchingRecipe(log, level) {
  const tiers = [
    ["logs", 5, 10, ""],
    ["oak logs", 20, 25, "Oak "],
    ["willow logs", 35, 40, "Willow "],
    ["maple logs", 50, 55, "Maple "],
    ["yew logs", 65, 70, "Yew "],
    ["magic logs", 80, 85, "Magic "]
  ];
  const row = tiers.find((t) => t[0] === log.toLowerCase());
  if (!row)
    return null;
  if (level >= row[2])
    return row[3] + "Long Bow";
  if (level >= row[1])
    return row[3] + "Short Bow";
  return row[0] === "logs" ? "Arrow Shafts" : null;
}
function productionDialog(options, label) {
  const norm = (v) => v.toLowerCase().replace(/[^a-z]/g, "");
  const product = options.find((o) => Number.isInteger(o.index) && norm(o.text).includes(norm(label)));
  return options.find((o) => product && Number.isInteger(product.componentId) && o.componentId === product.componentId - 2 && /^make 10$/i.test(o.text)) ?? product;
}
var axeRank = (name) => /pickaxe|battleaxe/i.test(name) ? 0 : ["bronze axe", "iron axe", "steel axe", "black axe", "mithril axe", "adamant axe", "rune axe"].indexOf(name.toLowerCase()) + 1;
var isFletchedOutput = (i) => [48, 50, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72].includes(Number(i.id));
var axeLevels = [0, 1, 1, 6, 6, 21, 31, 41];
var near = (s, p, r = 2) => Number(s.player?.level) === (p.level ?? 0) && Math.max(Math.abs(s.player.worldX - p.x), Math.abs(s.player.worldZ - p.z)) <= r;
var coins = (items) => items.filter((i) => /^coins$/i.test(i.name)).reduce((n, i) => n + Number(i.count), 0);
function woodSites(s, processing = true) {
  const wc = skillLevel(s, "woodcutting"), fletch = skillLevel(s, "fletching");
  const axe = Math.max(0, ...[...s.inventory ?? [], ...s.equipment ?? []].map((i) => axeRank(i.name)));
  const sites = [];
  if (wc >= 60 && (!processing || fletch >= 65) && axe >= 3)
    sites.push({ name: "edgeville-yew", tree: "Yew", x: 3088, z: 3480, level: 0, bank: BANKS[1], reason: "Use the collision-proven east approach outside the 3x3 yew footprint; test throughput with an upgraded axe" });
  if (wc >= 30)
    sites.push({ name: "edgeville-willow", tree: "Willow", x: 3113, z: 3487, level: 0, bank: BANKS[1], reason: "Reach the east side of the source willow footprint near Edgeville bank" });
  sites.push({ name: "varrock-oak", tree: wc >= 15 ? "Oak" : "Tree", x: 3170, z: 3420, level: 0, bank: BANKS[0], reason: "Use the east approach outside the 3x3 oak footprint near Varrock West bank" });
  return sites;
}
var resource = (i) => isFletchedOutput(i) || /^(logs|oak logs|willow logs|maple logs|yew logs|magic logs|arrow shaft.*|.*ore|.*bar)$/i.test(i.name);
function walk2(id, p, reason) {
  return [{ id, type: "walkTo", fields: { x: p.x, z: p.z, level: p.level ?? 0, reason }, waitTicks: 2 }];
}
function close2() {
  return [{ id: "economy-close-interface", type: "closeModal", waitTicks: 1 }];
}
function bankAt(s, preferred, blocked = () => false, unavailable = {}) {
  const booth = (s.nearbyLocs ?? []).find((l) => /bank booth|bank chest/i.test(l.name) && l.reachable === true && l.optionsWithIndex?.some((o) => /^use-quickly$|^bank$/i.test(o.text)));
  if (booth)
    return [{ id: "economy-open-bank", type: "interactLoc", fields: { x: booth.x, z: booth.z, locId: booth.id, optionIndex: booth.optionsWithIndex.find((o) => /^use-quickly$|^bank$/i.test(o.text)).opIndex }, waitTicks: 2 }];
  const ordered = [...BANKS].sort((a, b) => Math.hypot(s.player.worldX - a.x, s.player.worldZ - a.z) - Math.hypot(s.player.worldX - b.x, s.player.worldZ - b.z));
  if (preferred)
    ordered.sort((a, b) => Number(b.name === preferred.name) - Number(a.name === preferred.name));
  for (const bank of BANKS)
    if (near(s, bank, 0))
      unavailable[bank.name] = Date.now() + 300000;
  const destination = ordered.find((p) => !blocked("economy-bank-" + p.name) && (unavailable[p.name] ?? 0) <= Date.now());
  return destination ? walk2("economy-bank-" + destination.name, destination, "Try a feasible bank; arrival still requires an observed usable booth") : [{ id: "economy-bank-alternatives-blocked", type: "wait", waitTicks: 5 }];
}
function shopAt(s, name, destination) {
  const npc = s.nearbyNpcs?.find((n) => name.test(n.name) && n.reachable === true);
  const trade = npc?.optionsWithIndex?.find((o) => /^trade$/i.test(o.text));
  if (npc && trade)
    return [{ id: "economy-trade-" + npc.index, type: "interactNpc", fields: { npcIndex: npc.index, optionIndex: trade.opIndex }, waitTicks: 2 }];
  return near(s, destination, 0) ? [{ id: "economy-shop-not-visible", type: "wait", waitTicks: 5 }] : walk2("economy-shop-" + destination.x, destination, "Obtain the required tool through an observed shop");
}
function economyNext(s, m, blocked = () => false) {
  if (m.objectives && !m.objectives.intent) {
    m.goal = "review-profit-prerequisites";
    m.reason = m.objectives.decision?.blocker ?? "No supported positive or unmeasured production option; preserve assets until an alternative is available";
    return [{ id: "economy-review-profit-prerequisites", type: "wait", waitTicks: 5 }];
  }
  if (economyTrack(s, m) === "metalworking")
    return metalNext(s, m, blocked);
  if (m.objectives?.intent?.mode === "finish")
    return bowNext(s, m, blocked);
  const intent = m.objectives?.intent, processLogs = intent?.mode !== "logs";
  const inv = s.inventory ?? [], eq = s.equipment ?? [], all = [...inv, ...eq];
  const cash = coins(inv), bestAxe = Math.max(0, ...all.map((i) => axeRank(i.name)));
  const hasPick = all.some((i) => /^(bronze|iron|steel|mithril|adamant|rune) pickaxe$/i.test(i.name));
  const knife = inv.find((i) => /^knife$/i.test(i.name));
  const fletch = skillLevel(s, "fletching");
  const site = woodSites(s, processLogs).find((p) => (!intent?.site || p.name === intent.site) && !blocked("economy-site-" + p.name) && (m.siteCooldowns?.[p.name] ?? 0) <= Date.now());
  m.selectedSite = site?.name;
  const useBank = (preferred) => bankAt(s, preferred, blocked, m.bankCooldowns ??= {});
  if (m.processing && !inv.some((i) => String(i.name).toLowerCase() === m.processing)) {
    delete m.processing;
    delete m.product;
  }
  if (s.bank?.isOpen) {
    m.bankItems = s.bank.items ?? [];
    const material = inv.find((i) => resource(i) && String(i.name).toLowerCase() !== m.processing && !m.selling);
    if (material) {
      m.goal = "bank-production-batch";
      return [{ id: "economy-deposit-" + material.slot, type: "bankDeposit", fields: { slot: material.slot, amount: inv.filter((i) => i.id === material.id).reduce((n, i) => n + Number(i.count), 0) }, waitTicks: 2 }];
    }
    const storedTool = m.bankItems.find((i) => !bestAxe && axeRank(i.name) > 0 || !hasPick && !intent && /^bronze pickaxe$/i.test(i.name) || processLogs && !knife && /^knife$/i.test(i.name));
    if (storedTool && inv.length < 28)
      return [{ id: "economy-withdraw-tool", type: "bankWithdraw", fields: { slot: storedTool.slot, amount: 1 }, waitTicks: 2 }];
    const bankCoins = m.bankItems.find((i) => /^coins$/i.test(i.name));
    if (cash < 25 && bankCoins && (bestAxe < 3 || !hasPick))
      return [{ id: "economy-withdraw-tool-fund", type: "bankWithdraw", fields: { slot: bankCoins.slot, amount: Math.min(250 - cash, Number(bankCoins.count)) }, waitTicks: 2 }];
    if (m.processing || m.selling)
      return close2();
    const storedLogs = processLogs && knife ? m.bankItems.filter((i) => (!intent || i.id === intent.inputId) && fletchingRecipe(i.name, fletch) && Number(i.count) > 0).sort((a, b) => ["logs", "oak logs", "willow logs", "maple logs", "yew logs", "magic logs"].indexOf(b.name.toLowerCase()) - ["logs", "oak logs", "willow logs", "maple logs", "yew logs", "magic logs"].indexOf(a.name.toLowerCase()))[0] : undefined;
    if (storedLogs && inv.length < 25) {
      m.processing = storedLogs.name.toLowerCase();
      m.product = intent?.recipe ?? fletchingRecipe(storedLogs.name, fletch);
      m.goal = "batch-fletching";
      return [{ id: "economy-withdraw-fletching-batch", type: "bankWithdraw", fields: { slot: storedLogs.slot, amount: Math.min(24, 28 - inv.length, Number(storedLogs.count)) }, waitTicks: 2 }];
    }
    if (bestAxe < 3 && cash < 250) {
      const sell = m.bankItems.find((i) => isFletchedOutput(i) && Number(i.count) > 0);
      if (sell && inv.length < 25) {
        m.selling = true;
        m.goal = "fund-tool-upgrade";
        return [{ id: "economy-withdraw-sale-batch", type: "bankWithdraw", fields: { slot: sell.slot, amount: Math.min(20, 28 - inv.length, Number(sell.count)) }, waitTicks: 2 }];
      }
    }
    if (cash > 250) {
      const c = inv.find((i) => /^coins$/i.test(i.name));
      return [{ id: "economy-bank-surplus", type: "bankDeposit", fields: { slot: c.slot, amount: cash - 250 }, waitTicks: 2 }];
    }
    return close2();
  }
  if (s.shop?.isOpen) {
    const stock = (s.shop.shopItems ?? []).filter((i) => Number(i.count) > 0 && Number.isFinite(i.buyPrice) && i.buyPrice > 0 && i.buyPrice <= cash);
    const axe = stock.filter((i) => axeRank(i.name) > bestAxe && skillLevel(s, "woodcutting") >= axeLevels[axeRank(i.name)] && i.buyPrice <= cash - (!hasPick ? 1 : 0)).sort((a, b) => axeRank(b.name) - axeRank(a.name))[0];
    const pick = !hasPick ? stock.find((i) => /^bronze pickaxe$/i.test(i.name)) : undefined;
    const buy = axe ?? pick;
    if (buy)
      return [{ id: "economy-buy-tool-" + buy.id, type: "shopBuy", fields: { slot: buy.slot, amount: 1, reason: "Source-compatible tool; observed price within carried budget" }, waitTicks: 2 }];
    if (m.selling) {
      const sale = inv.find(isFletchedOutput);
      const offer = s.shop.playerItems?.find((i) => i.id === sale?.id && Number(i.sellPrice) > 0);
      if (sale && offer)
        return [{ id: "economy-sell-product-" + sale.slot, type: "shopSell", fields: { slot: sale.slot, amount: 1 }, waitTicks: 2 }];
      if (!sale)
        m.selling = false;
    }
    return close2();
  }
  if ((!bestAxe || !hasPick && !intent || bestAxe < 3 && cash >= 200) && !m.processing && !m.selling) {
    m.goal = "obtain-tools";
    m.reason = "Recover/upgrade axe; carry a bronze pickaxe before any mining trip";
    if (!bestAxe && cash < 16 || !hasPick && cash < 1) {
      if (coins(m.bankItems ?? []) > 0 || (m.bankItems ?? []).some((i) => axeRank(i.name) > 0))
        return useBank();
      m.reason = "No cash/tool available: need a banked sale batch or a verified free tool source";
      return useBank();
    }
    return shopAt(s, /^bob$/i, { x: 3232, z: 3203 });
  }
  if (processLogs && !knife) {
    m.goal = "obtain-fletching-knife";
    m.reason = "Normal ground spawn at Lumbridge, map m50_50 OBJ 0 24 2:946";
    const item = s.groundItems?.find((i) => /^knife$/i.test(i.name) && i.reachable === true);
    if (item)
      return near(s, item, 1) ? [{ id: "economy-pickup-knife", type: "pickupItem", fields: { x: item.x, z: item.z, itemId: item.id }, waitTicks: 2 }] : walk2("economy-knife-spawn", item, "Reach the observed knife pile before attempting pickup");
    return near(s, { x: 3224, z: 3202 }, 0) ? [{ id: "economy-wait-knife-respawn", type: "wait", waitTicks: 5 }] : walk2("economy-knife-spawn", { x: 3224, z: 3202 }, m.reason);
  }
  if (m.selling) {
    if (inv.some(isFletchedOutput))
      return shopAt(s, /^shop keeper$|^shop assistant$/i, { x: 3218, z: 3415 });
    delete m.selling;
  }
  if (processLogs && m.processing) {
    if (Number(s.player?.animId) >= 0)
      return [{ id: "economy-continue-production", type: "wait", waitTicks: 2 }];
    const log = inv.find((i) => String(i.name).toLowerCase() === m.processing);
    const recipe = log && (intent?.recipe ?? fletchingRecipe(log.name, fletch));
    if (recipe) {
      m.product = recipe;
      m.goal = "batch-fletching";
      m.reason = "Knife + " + log.name + " -> " + recipe + "; verify Fletching XP and output";
      return [{ id: "economy-fletch-" + log.slot, type: "useItemOnItem", fields: { sourceSlot: knife.slot, targetSlot: log.slot }, waitTicks: 2 }];
    }
  }
  if (inv.length >= 28 || inv.some((i) => isFletchedOutput(i) || /arrow shaft/i.test(i.name))) {
    m.goal = "bank-production-batch";
    m.reason = "Deposit products and preserve tools before the next batch";
    return useBank(site?.bank);
  }
  if (processLogs && (m.bankItems ?? []).some((i) => (!intent || i.id === intent.inputId) && fletchingRecipe(i.name, fletch) && Number(i.count) > 0)) {
    m.goal = "collect-banked-inputs";
    m.reason = "Process existing usable logs before spending time on another gathering trip";
    return useBank();
  }
  if (!site) {
    m.goal = "gathering-cooldown";
    m.reason = "All prepared gathering sites temporarily unavailable";
    return [{ id: "economy-sites-blocked", type: "wait", waitTicks: 5 }];
  }
  m.goal = "gather-" + site.tree.toLowerCase();
  m.reason = site.reason;
  if (!near(s, site, 12))
    return walk2("economy-site-" + site.name, site, site.reason);
  const trees = (s.nearbyLocs ?? []).filter((l) => l.name.toLowerCase() === site.tree.toLowerCase() && l.reachable === true && l.optionsWithIndex?.some((o) => /^chop/i.test(o.text)) && Math.hypot(l.x - site.x, l.z - site.z) < 20);
  trees.sort((a, b) => Number(a.distance) - Number(b.distance));
  const tree = trees.find((l) => l.id === m.harvest?.id && l.x === m.harvest?.x && l.z === m.harvest?.z) ?? trees[0];
  if (tree) {
    delete m.missingResource;
    if (m.harvest?.x === tree.x && m.harvest?.z === tree.z && Number(s.player.animId) >= 0)
      return [{ id: "economy-continue-harvest", type: "wait", waitTicks: 2 }];
    m.harvest = { id: tree.id, x: tree.x, z: tree.z };
    return [{ id: "economy-" + site.tree.toLowerCase() + "-" + tree.x + "-" + tree.z, type: "interactLoc", fields: { x: tree.x, z: tree.z, locId: tree.id, optionIndex: tree.optionsWithIndex.find((o) => /^chop/i.test(o.text)).opIndex }, waitTicks: 5 }];
  }
  delete m.harvest;
  if (m.missingResource?.site !== site.name)
    m.missingResource = { site: site.name, polls: 0, tick: -1 };
  if (m.missingResource.tick !== s.tick) {
    m.missingResource.tick = s.tick;
    m.missingResource.polls++;
  }
  if (m.missingResource.polls >= 3) {
    (m.siteCooldowns ??= {})[site.name] = Date.now() + 60000;
    delete m.missingResource;
  }
  return [{ id: "economy-resource-respawn", type: "wait", waitTicks: 5 }];
}

// src/training/discovery.ts
import { existsSync as existsSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "fs";
var fresh = () => ({ sites: {}, observations: {}, exploration: { window: 0, trips: 0 } });
var outcomes = () => ({ encounters: 0, kills: 0, productive: 0, xp: 0, ticks: 0, damage: 0, food: 0, ammo: 0, escapes: 0, deaths: 0 });
var at2 = (s) => ({ x: s.player.worldX, z: s.player.worldZ, level: s.player.level });
var xp = (s) => (s.skills ?? []).filter((v) => /^(attack|strength|defence|ranged|magic|hitpoints)$/i.test(v.name)).reduce((n, v) => n + Number(v.experience ?? 0), 0);
var ammo = (s) => [...s.inventory ?? [], ...s.equipment ?? []].filter((i) => hasUsableArrows(s.combatStyle?.weaponName ?? "", [i])).reduce((n, i) => n + Number(i.count), 0);
var metal = (name) => ["bronze", "iron", "steel", "black", "mithril", "adamant", "rune"].findIndex((m) => name.toLowerCase().includes(m)) + 1;
var context = (s, ranged) => `${ranged ? "ranged" : "melee"}:${s.combatStyle?.weaponName ?? "unknown"}:def${Math.floor(skillLevel(s, "defence") / 10)}:skill${Math.floor(skillLevel(s, ranged ? "ranged" : "strength") / 10)}`;
function trainingReadiness(s, m, ranged) {
  if (!s.player || s.player.isDead || isThreatened(s) || s.bank?.isOpen || s.shop?.isOpen || s.dialog?.isOpen)
    return "safety-or-interface";
  if ((s.inventory?.length ?? 28) >= 28)
    return "inventory-full";
  const minimumFood = Number(s.player.combatLevel) <= 5 ? 1 : 3;
  if (!(Number(s.player.hp) > Number(s.player.maxHp) * 0.6) || foodCount(s) < minimumFood)
    return "health-or-food";
  if (skillLevel(s, ranged ? "ranged" : "strength") < m.minSkill)
    return "skill-prerequisite";
  const weapon = String(s.combatStyle?.weaponName ?? "");
  if (ranged) {
    if (!hasUsableArrows(weapon, s.equipment ?? []))
      return "compatible-quiver-required";
    if (ammo(s) < (m.minSkill >= 20 ? 30 : 15))
      return "ammo-trip-reserve";
  } else if (!/sword|scimitar|dagger|mace|axe|spear|warhammer/i.test(weapon) || /pickaxe/i.test(weapon))
    return "melee-weapon-required";
  const trialFood = !ranged && skillLevel(s, "strength") >= 60 ? 3 : 5;
  if (m.minSkill >= 20 && (Number(s.player.maxHp) < 20 || foodCount(s) < trialFood || !ranged && metal(weapon) < 2 && skillLevel(s, "strength") < 60))
    return "trial-equipment-or-supplies";
}

class TrainingDiscovery {
  file;
  character;
  catalog;
  ranged;
  economy;
  now;
  memory;
  document;
  routeCache = new Map;
  constructor(file, character, catalog, ranged = false, economy = false, now = Date.now) {
    this.file = file;
    this.character = character;
    this.catalog = catalog;
    this.ranged = ranged;
    this.economy = economy;
    this.now = now;
    this.document = { version: 1, character, worlds: {} };
    if (existsSync2(file)) {
      const saved = JSON.parse(readFileSync4(file, "utf8"));
      if (saved.character !== character || saved.version !== 1)
        throw new Error("Training memory identity/version mismatch");
      this.document = saved;
    }
    this.memory = this.document.worlds[catalog.namespace] ??= fresh();
    for (const h of catalog.sites)
      this.memory.sites[h.id] ??= {
        id: h.id,
        name: h.name,
        monsterId: h.monster.id,
        combatLevel: h.monster.combatLevel,
        points: h.points,
        source: "guide",
        evidence: h.source,
        guideIds: h.guideIds,
        sightings: 0,
        failures: 0,
        cooldownUntil: 0,
        stats: {},
        observationPasses: 0
      };
  }
  save() {
    writeFileSync2(this.file, JSON.stringify(this.document, null, 2) + `
`);
  }
  timedOut(s) {
    return !!this.memory.pending && s.player?.lifeId === this.memory.pending.life && s.tick > this.memory.pending.tick + 180;
  }
  validateAction(s, action) {
    const site = this.memory.sites[action.fields?.trainingSite];
    const monster = this.catalog.monsters.find((m) => m.id === site?.monsterId);
    if (!site || !monster || site.cooldownUntil > this.now() || trainingReadiness(s, monster, this.ranged))
      return false;
    if (action.type === "walkTo")
      return site.points.some((p) => p.x === action.fields?.x && p.z === action.fields?.z && p.level === action.fields?.level);
    const target = s.nearbyNpcs?.find((n) => n.index === action.fields?.npcIndex);
    return !!target && target.hp !== 0 && this.monster(target)?.id === monster.id && target.reachable === true && target.inCombat !== true && target.distance <= 8 && target.optionsWithIndex?.some((o) => o.opIndex === action.fields?.optionIndex && /^attack$/i.test(o.text));
  }
  actionFailed() {
    this.finish(false, false);
    this.save();
  }
  monster(n) {
    return this.catalog.monsters.find((m) => m.id === n.id && m.name.toLowerCase() === String(n.name).toLowerCase() && m.combatLevel === n.combatLevel);
  }
  observe(s) {
    if (!s.player || !validTile(at2(s)))
      return;
    const stamp = `${s.player.lifeId}:${s.tick}`;
    if (this.memory.lastObserved === stamp)
      return;
    this.memory.lastObserved = stamp;
    const time = new Date(this.now()).toISOString();
    for (const n of [...(s.nearbyNpcs ?? []).map((n) => ({ ...n, kind: "npc" })), ...(s.nearbyLocs ?? []).map((n) => ({ ...n, kind: "loc" }))]) {
      const p = { x: n.tileX ?? n.x, z: n.tileZ ?? n.z, level: n.level ?? s.player.level };
      if (!validTile(p) || !Number.isInteger(n.id))
        continue;
      const key = `${n.kind}:${n.id}:${p.level}:${Math.floor(p.x / 16)}:${Math.floor(p.z / 16)}:${n.combatLevel ?? ""}`;
      const old = this.memory.observations[key];
      this.memory.observations[key] = { kind: n.kind, typeId: n.id, name: n.name, position: p, combatLevel: n.combatLevel, firstSeen: old?.firstSeen ?? time, lastSeen: time, sightings: (old?.sightings ?? 0) + 1, reachable: n.reachable === true };
      const monster = n.kind === "npc" && this.monster(n);
      if (!monster || p.level !== s.player.level)
        continue;
      let site = Object.values(this.memory.sites).find((site) => site.monsterId === monster.id && site.points.some((point) => distance(point, p) <= 20));
      if (!site && n.reachable === true && Object.keys(this.memory.sites).length < 128) {
        const id = `observed-${key}`;
        site = this.memory.sites[id] = { id, name: `${n.name} observed at ${p.x},${p.z}`, monsterId: monster.id, combatLevel: monster.combatLevel, points: [at2(s)], source: "observed", evidence: `state:${stamp}:${time}`, guideIds: [], sightings: 0, failures: 0, cooldownUntil: 0, stats: {}, observationPasses: 0 };
      }
      if (site) {
        site.firstSeen ??= time;
        site.lastSeen = time;
        site.sightings++;
      }
    }
    const entries = Object.entries(this.memory.observations).sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
    this.memory.observations = Object.fromEntries(entries.slice(0, 512));
    this.save();
  }
  finish(escaped, dead) {
    const e = this.memory.pending;
    if (!e)
      return;
    const site = this.memory.sites[e.siteId];
    if (site) {
      const stats = site.stats[e.context] ??= outcomes();
      stats.encounters++;
      stats.kills += Number(e.confirmedKill);
      stats.productive += Number(e.xp > 0 && !escaped && !dead);
      stats.xp += e.xp;
      stats.ticks += e.ticks;
      stats.damage += e.damage;
      stats.food += e.food;
      stats.ammo += e.ammo;
      stats.escapes += Number(escaped);
      stats.deaths += Number(dead);
      if (escaped || dead)
        this.block(site.id, dead ? "death-observed" : "retreat-observed", dead ? 30 * 60000 : 5 * 60000);
      else if (e.xp > 0) {
        site.observationPasses = 0;
        if (this.memory.commitment?.siteId === site.id)
          this.memory.commitment.encounters++;
      }
    }
    delete this.memory.pending;
  }
  beforeAction(s, action) {
    if (!action.id.startsWith("training-attack-"))
      return;
    if (this.memory.pending)
      this.finish(false, false);
    const n = s.nearbyNpcs?.find((n) => n.index === action.fields?.npcIndex), siteId = action.fields?.trainingSite;
    if (!n || !this.monster(n) || !this.memory.sites[siteId])
      return;
    this.memory.pending = { siteId, index: n.index, monsterId: n.id, life: s.player.lifeId, tick: s.tick, context: context(s, this.ranged), xp: 0, ticks: 0, damage: 0, food: 0, ammo: 0, confirmedKill: false };
  }
  afterAction(before, after, action) {
    const e = this.memory.pending;
    if (e) {
      const dead = after.player?.isDead || after.player?.lifeId !== e.life || Number(after.player?.respawnCount ?? 0) > Number(before.player?.respawnCount ?? 0);
      const reset = after.tick < before.tick;
      if (!dead && !reset) {
        e.xp += Math.max(0, xp(after) - xp(before));
        e.ticks += Math.max(0, after.tick - before.tick);
        const eventDamage = (after.combatEvents ?? []).filter((v) => v.tick > before.tick && v.tick <= after.tick && v.type === "damage_taken" && v.targetType === "player").reduce((n, v) => n + Number(v.damage ?? 0), 0);
        e.damage += Math.max(eventDamage, Number(before.player.hp) - Number(after.player.hp), 0);
        e.food += Math.max(0, foodCount(before) - foodCount(after));
        e.ammo += Math.max(0, ammo(before) - ammo(after));
      }
      const target = after.nearbyNpcs?.find((n) => n.index === e.index && n.id === e.monsterId);
      e.confirmedKill ||= target?.hp === 0;
      const fighting = after.player?.combat?.inCombat && after.player.combat.targetType === "npc" && after.player.combat.targetIndex === e.index;
      if (dead || reset || action.type === "retreat" || e.confirmedKill || !fighting && after.tick > e.tick + 4)
        this.finish(action.type === "retreat", !!dead);
    }
    this.observe(after);
    this.save();
  }
  block(siteId, reason, duration = 5 * 60000) {
    const site = this.memory.sites[siteId];
    if (!site)
      return;
    site.failures++;
    site.cooldownUntil = this.now() + duration;
    site.observationPasses = 0;
    delete site.emptySinceTick;
    if (this.memory.commitment?.siteId === siteId)
      delete this.memory.commitment;
    this.memory.status = { reason, siteId, retryAt: site.cooldownUntil };
    this.routeCache.clear();
    this.save();
  }
  async route(from, to, probe) {
    const key = `${JSON.stringify(from)}>${JSON.stringify(to)}`;
    const cached = this.routeCache.get(key);
    if (cached && cached.until > this.now())
      return cached.route;
    const route = await probe(from, to);
    if (route.status !== "loading-map")
      this.routeCache.set(key, { until: this.now() + 30000, route });
    if (this.routeCache.size > 128)
      this.routeCache.delete(this.routeCache.keys().next().value);
    return route;
  }
  score(site, s, cost) {
    const m = this.catalog.monsters.find((m) => m.id === site.monsterId);
    const stats = site.stats[context(s, this.ranged)];
    const prior = m.minSkill >= 20 ? 7 : m.hp >= 8 ? 4 : m.hp >= 5 ? 3 : 2;
    if (!stats?.ticks)
      return prior + (site.sightings ? 0.5 : 0) - cost / 80;
    const weight = Math.min(1, stats.encounters / 3);
    const measured = stats.xp / stats.ticks * 4 - stats.damage / Math.max(1, stats.encounters) * 0.2 - stats.food / Math.max(1, stats.encounters) - stats.ammo / Math.max(1, stats.encounters) * 0.05 - stats.escapes * 4 - stats.deaths * 20;
    return prior * (1 - weight) + measured * weight - cost / 80;
  }
  async next(s, probe) {
    this.observe(s);
    if (this.economy)
      return [];
    if (!s.player || !validTile(at2(s)))
      return [{ id: "training-await-valid-state", type: "wait", waitTicks: 5 }];
    if (isThreatened(s))
      return [{ id: "training-await-combat-clear", type: "wait", waitTicks: 2 }];
    if (this.memory.pending) {
      const e = this.memory.pending;
      if (e.life !== s.player.lifeId || s.tick < e.tick || s.tick > e.tick + 180)
        this.finish(false, e.life !== s.player.lifeId);
    }
    const now = this.now(), origin = at2(s);
    const wait = (reason) => {
      this.memory.status = { reason, selectedSite: this.memory.commitment?.siteId, retryAt: this.memory.retryAt };
      this.save();
      return [{ id: "training-observe-" + reason, type: "wait", waitTicks: 5 }];
    };
    if (this.memory.retryAt && now < this.memory.retryAt)
      return wait("discovery-cooldown");
    if (now - this.memory.exploration.window >= 10 * 60000)
      this.memory.exploration = { window: now, trips: 0 };
    const candidates = Object.values(this.memory.sites).filter((site) => {
      const m = this.catalog.monsters.find((m) => m.id === site.monsterId);
      return m && site.cooldownUntil <= now && !trainingReadiness(s, m, this.ranged) && site.points.some((p) => p.level === origin.level);
    });
    const highestReadyTier = Math.max(0, ...candidates.map((site) => site.combatLevel));
    const higherTierReady = highestReadyTier >= 5;
    const committedBefore = this.memory.commitment && this.memory.sites[this.memory.commitment.siteId];
    if (higherTierReady && committedBefore && committedBefore.combatLevel < highestReadyTier)
      delete this.memory.commitment;
    const tierBias = (site) => higherTierReady && site.combatLevel === highestReadyTier ? 1e4 : 0;
    const viable = candidates.sort((a, b) => tierBias(b) + this.score(b, s, Math.min(...b.points.map((p) => distance(origin, p)))) - tierBias(a) - this.score(a, s, Math.min(...a.points.map((p) => distance(origin, p)))));
    const commitment = this.memory.commitment;
    const committed = viable.find((site) => site.id === commitment?.siteId);
    const hold = committed && commitment && (now - commitment.since < 180000 || commitment.encounters < 3) && now - commitment.since < 600000;
    const ordered = hold ? [committed] : [...committed ? [committed] : [], ...viable.filter((v) => v !== committed)].slice(0, 8);
    const choices = [];
    let loading = false;
    for (const site of ordered) {
      if (!site.sightings && site.id !== commitment?.siteId && this.memory.exploration.trips >= 2 && site.combatLevel < 5)
        continue;
      const points = site.id === commitment?.siteId && commitment.approaches?.length ? commitment.approaches : [...site.points].sort((a, b) => distance(origin, a) - distance(origin, b)).slice(0, 3);
      const offset = site.observationPasses % points.length;
      for (const point of [...points.slice(offset), ...points.slice(0, offset)]) {
        const route = await this.route(origin, point, probe);
        if (route.status === "loading-map") {
          loading = true;
          break;
        }
        if (route.status !== "ready")
          continue;
        const cost = route.cost ?? 0;
        choices.push({ site, point, cost, score: tierBias(site) + this.score(site, s, cost) - (route.conditionalDoors ?? 0) * 0.15 });
        break;
      }
      if (loading)
        break;
      if (!choices.some((c) => c.site === site))
        this.block(site.id, "no-feasible-approach", 60000);
    }
    if (loading)
      return wait("loading-map");
    if (!choices.length && hold && !this.memory.commitment)
      return this.next(s, probe);
    choices.sort((a, b) => b.score - a.score);
    let chosen = choices[0];
    const current = choices.find((c) => c.site.id === commitment?.siteId);
    if (current && (hold || !chosen || chosen.score < current.score + 1.5))
      chosen = current;
    if (!chosen) {
      this.memory.retryAt = now + 30000;
      return wait("no-viable-reachable-site");
    }
    const { site, point } = chosen;
    if (this.memory.commitment?.siteId !== site.id) {
      if (!site.sightings)
        this.memory.exploration.trips++;
      this.memory.commitment = { siteId: site.id, since: now, encounters: 0 };
    }
    this.memory.commitment.approaches ??= [point, ...[...site.points].sort((a, b) => distance(origin, a) - distance(origin, b)).filter((p) => distance(p, point) !== 0).slice(0, 2)];
    this.memory.status = { selectedSite: site.id, source: site.source, guideIds: site.guideIds, routeCost: chosen.cost, score: chosen.score, predictedReachable: true, liveVerified: false };
    const target = (s.nearbyNpcs ?? []).filter((n) => this.monster(n)?.id === site.monsterId && n.hp !== 0 && n.reachable === true && n.inCombat !== true && Number(n.distance) <= 8 && n.optionsWithIndex?.some((o) => /^attack$/i.test(o.text)) && site.points.some((p) => distance(p, { x: n.tileX ?? n.x, z: n.tileZ ?? n.z, level: s.player.level }) <= 20)).sort((a, b) => a.distance - b.distance)[0];
    if (target) {
      site.observationPasses = 0;
      delete site.emptySinceTick;
      this.save();
      return [{ id: `training-attack-${site.id}`, type: "interactNpc", fields: { npcIndex: target.index, optionIndex: target.optionsWithIndex.find((o) => /^attack$/i.test(o.text)).opIndex, trainingSite: site.id }, waitTicks: 6 }];
    }
    const monster = this.catalog.monsters.find((m) => m.id === site.monsterId);
    if (site.emptySinceTick !== undefined && s.tick < site.emptySinceTick) {
      site.emptySinceTick = s.tick;
      site.observationPasses = 0;
    }
    if (site.observationPasses >= 3) {
      if (s.tick - (site.emptySinceTick ?? s.tick) >= Math.min(90, monster.respawnTicks))
        this.block(site.id, "empty-or-unusable-site");
      return wait("bounded-respawn-window");
    }
    if (distance(origin, point) > 0) {
      this.save();
      return [{ id: `training-travel-${site.id}`, type: "walkTo", fields: { ...point, trainingSite: site.id, reason: "Observe a source-compatible training site; arrival does not prove an encounter" }, waitTicks: 2 }];
    }
    site.emptySinceTick ??= s.tick;
    if (site.lastObservationTick !== s.tick) {
      site.lastObservationTick = s.tick;
      site.observationPasses++;
    }
    if (site.observationPasses >= 3 && s.tick - site.emptySinceTick >= Math.min(90, monster.respawnTicks)) {
      this.block(site.id, "empty-or-unusable-site");
      return wait("site-observation-budget");
    }
    this.save();
    return wait("site-respawn-observation");
  }
}

// src/controller-lease.ts
import { openSync, closeSync, readFileSync as readFileSync5, writeFileSync as writeFileSync3, unlinkSync, existsSync as existsSync3 } from "fs";
import { randomUUID } from "crypto";
function acquireController(file) {
  if (existsSync3(file)) {
    let old;
    try {
      old = JSON.parse(readFileSync5(file, "utf8"));
    } catch {
      throw new Error("Controller lock unreadable; inspect before starting");
    }
    if (!Number.isInteger(old.pid) || old.pid < 1)
      throw new Error("Invalid controller lock");
    try {
      process.kill(old.pid, 0);
      throw new Error("A local controller already owns this profile");
    } catch (error) {
      if (error.code !== "ESRCH")
        throw error;
    }
    unlinkSync(file);
  }
  const owner = { pid: process.pid, nonce: randomUUID() };
  const fd = openSync(file, "wx");
  try {
    writeFileSync3(fd, JSON.stringify(owner));
  } finally {
    closeSync(fd);
  }
  return () => {
    try {
      if (JSON.parse(readFileSync5(file, "utf8")).nonce === owner.nonce)
        unlinkSync(file);
    } catch {}
  };
}

// src/skill-cli.ts
import { homedir } from "os";
import { resolve as resolve3 } from "path";
function skillCommand(character, args, env = process.env) {
  if (!/^[a-z][a-z0-9]{0,11}$/.test(character))
    throw new Error("Invalid character");
  if (args.some((a) => ["--character", "--server"].includes(a)))
    throw new Error("Identity override rejected");
  const full = ["state", "act", "wait"].includes(args[0] ?? "") && !args.includes("--full");
  return [
    env.CLAWSCAPE_PYTHON ?? "python",
    env.CLAWSCAPE_SKILL_CLI ?? resolve3(homedir(), ".codex/skills/clawscape/clawscape.py"),
    "--character",
    character,
    ...args,
    ...full ? ["--full"] : []
  ];
}
async function callSkill(character, args, home) {
  const child = Bun.spawn(skillCommand(character, args), {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAWSCAPE_HOME: home }
  });
  const errorOutput = new Response(child.stderr).text();
  const timeoutMs = ["connect", "disconnect", "act", "wait"].includes(args[0] ?? "") ? 110000 : 20000;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    let raw = "";
    for await (const chunk of child.stdout) {
      raw += Buffer.from(chunk).toString("utf8");
      if (raw.length > 4000000) {
        child.kill();
        throw new Error("CLI response too large");
      }
    }
    const code = await child.exited;
    let reply;
    try {
      reply = JSON.parse(raw);
    } catch {
      let reason = "";
      try {
        reason = String(JSON.parse(await errorOutput).error ?? "").slice(0, 500);
      } catch {}
      throw new Error(`CLI ${args[0]} unavailable (exit ${code})${reason ? ": " + reason : ""}`);
    }
    if (!reply || typeof reply !== "object" || Array.isArray(reply))
      throw new Error("Invalid CLI response");
    if (code !== 0 || reply.error)
      throw new Error(`CLI ${args[0]}: ${String(reply.error ?? "unavailable")}`);
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

// src/goals/catalog.ts
import { readFileSync as readFileSync6 } from "fs";
import { resolve as resolve4 } from "path";
import { createHash as createHash2 } from "crypto";
var block = (text, key) => text.split("[" + key + "]")[1]?.split(/\r?\n\[/)[0] ?? "";
var field = (text, key) => {
  const prefix = key + (key.includes("=") ? "," : "=");
  return text.split(/\r?\n/).find((l) => l.startsWith(prefix))?.slice(prefix.length)?.trim();
};
function loadGearCatalog(upstream = resolve4(import.meta.dir, "../../../tmp/clawscape/upstream")) {
  const evidence = [], hash = createHash2("sha256");
  const read = (p) => {
    const t = readFileSync6(resolve4(upstream, p), "utf8");
    evidence.push(p);
    hash.update(p).update(t);
    return t;
  };
  const pack = new Map(read("server/content/pack/obj.pack").split(/\r?\n/).filter((l) => /^\d+=/.test(l)).map((l) => [l.slice(l.indexOf("=") + 1), Number(l.slice(0, l.indexOf("=")))]));
  const id = (symbol) => {
    const n = pack.get(symbol);
    if (n === undefined)
      throw new Error("Missing source item " + symbol);
    return n;
  };
  const metal = ["bronze", "iron", "steel", "black", "mithril", "adamant", "rune"];
  const metalLevel = [1, 1, 5, 10, 20, 30, 40];
  const items = [];
  const add = (symbol, family, file, contents, level, skill, quality) => {
    const data = block(contents, symbol), name = field(data, "name");
    if (!data || !name)
      return;
    const g = { id: id(symbol), name, symbol, family, quality, requires: [{ skill, level }], methods: [], source: file + "#" + symbol, tool: family === "axe" || family === "pickaxe" };
    items.push(g);
    return g;
  };
  for (const [type, file] of [["scimitar", "scimitars"], ["sword", "swords"], ["longsword", "longswords"]]) {
    const path = "server/content/scripts/skill_combat/configs/melee/" + file + ".obj", contents = read(path);
    metal.forEach((m, i) => {
      const data = block(contents, m + "_" + type);
      const strength = Number(field(data, "param=strengthbonus") ?? 0), slash = Number(field(data, "param=slashattack") ?? 0), stab = Number(field(data, "param=stabattack") ?? 0);
      add(m + "_" + type, "melee", path, contents, metalLevel[i], "attack", (strength + Math.max(slash, stab)) / (type === "longsword" ? 5 : 4));
    });
  }
  const axePath = "server/content/scripts/skill_woodcutting/configs/axes/axes.obj", axes = read(axePath);
  metal.forEach((m, i) => add(m + "_axe", "axe", axePath, axes, [1, 1, 6, 6, 21, 31, 41][i], "woodcutting", i + 1));
  const pickPath = "server/content/scripts/skill_mining/configs/pickaxes.obj", picks = read(pickPath);
  ["bronze", "iron", "steel", "mithril", "adamant", "rune"].forEach((m, i) => add(m + "_pickaxe", "pickaxe", pickPath, picks, [1, 1, 6, 21, 31, 41][i], "mining", i + 1));
  const bowPath = "server/content/scripts/skill_combat/configs/ranged/bows.obj", bows = read(bowPath);
  ["shortbow", "oak_shortbow", "willow_shortbow", "maple_shortbow", "yew_shortbow", "magic_shortbow"].forEach((symbol, i) => add(symbol, "bow", bowPath, bows, [1, 5, 20, 30, 40, 50][i], "ranged", i + 1));
  const leatherPath = "server/content/scripts/skill_crafting/configs/leather/leather_gear.obj", leather = read(leatherPath);
  for (const [symbol, family, level, quality] of [["leather_chaps", "legs", 1, 2], ["dragonhide_chaps", "legs", 40, 8], ["leather_vambraces", "hands", 1, 1], ["dragon_vambraces", "hands", 40, 8]]) {
    add(symbol, family, leatherPath, leather, level, "ranged", quality);
  }
  const shopSpecs = [
    ["bobs-brilliant-axes", "Bob", 3232, 3203, 0, true],
    ["varrock-swordshop", "Shop keeper|Shop assistant", 3203, 3397, 0, true],
    ["zekes-superior-scimitars", "Zeke", 3288, 3190, 0, true],
    ["lowes-archery-emporium", "Lowe", 3232, 3423, 0, true],
    ["scavvos-rune-store", "Scavvo", 3191, 3351, 1, false],
    ["nurmofs-pickaxe-shop", "Nurmof", 2998, 9844, 0, false],
    ["aarons-archery-appendages", "Armour salesman", 2667, 3436, 0, false]
  ];
  const shops = shopSpecs.map(([key, npc, x, z, level, enabled]) => {
    const source = "wiki/shops/" + key + ".md", text = read(source);
    const shop = {
      id: key,
      name: text.split(/\r?\n/)[0].replace(/^# /, ""),
      npc,
      x,
      z,
      level,
      enabled,
      source,
      blocker: enabled ? undefined : key === "scavvos-rune-store" ? "32 Quest Points and verified guild/floor transition required" : "Service route/transition not yet supported"
    };
    for (const match of text.matchAll(/\| \[([^\]]+)\]\([^)]*\) \| (\d+) \| (\d+) gp/g)) {
      const gear = items.find((i) => i.name.toLowerCase() === match[1].toLowerCase());
      if (gear && Number(match[2]) > 0)
        gear.methods.push({ id: "buy:" + key + ":" + gear.id, kind: "buy", shop, priceHint: Number(match[3]), source, blocker: shop.blocker });
    }
    return shop;
  });
  const ingredient = (symbol, count) => ({ id: id(symbol), name: symbol.replaceAll("_", " "), count });
  const smithPath = "server/content/scripts/skill_smithing/configs/smithing/smithing.dbrow", smith = read(smithPath);
  const craftPath = "server/content/scripts/skill_crafting/configs/leather/leather.dbrow", craft = read(craftPath);
  const stringPath = "server/content/scripts/skill_fletching/configs/stringing/bows.dbrow", strings = read(stringPath);
  for (const gear of items) {
    const recipe = block(smith, gear.symbol);
    if (recipe)
      gear.methods.push({
        id: "smith:" + gear.id,
        kind: "craft",
        recipe: "smith",
        skill: "smithing",
        level: Number(field(recipe, "data=levelrequired")),
        inputs: [ingredient(field(recipe, "data=bar"), Number(field(recipe, "data=bar_amount"))), ingredient("hammer", 1)],
        source: smithPath + "#" + gear.symbol,
        prerequisites: ["Train Smithing to the recipe level", "Obtain bars: buy them or mine ores and coal, then smelt", "Carry a hammer; use a verified anvil"]
      });
    for (const row of craft.split(/\r?\n\[/)) {
      if (field(row, "data=product") !== gear.symbol)
        continue;
      const [material, count] = field(row, "data=leather").split(",");
      gear.methods.push({
        id: "craft:" + gear.id,
        kind: "craft",
        recipe: "leather",
        skill: "crafting",
        level: Number(field(row, "data=levelrequired")),
        inputs: [ingredient(material, Number(count)), ingredient("needle", 1), ingredient("thread", 1)],
        source: craftPath,
        prerequisites: ["Obtain the correct hide from a supported dragon (not a guessed drake source) or buy it", "Tan hide into leather; raw hide is not a crafting input", "Carry needle and thread; meet Crafting level"]
      });
    }
    for (const row of strings.split(/\r?\n\[/)) {
      if (field(row, "data=product")?.split(",")[0] !== gear.symbol)
        continue;
      gear.methods.push({
        id: "string:" + gear.id,
        kind: "craft",
        recipe: "string",
        skill: "fletching",
        level: Number(field(row, "data=level")),
        inputs: [ingredient(field(row, "data=item"), 1), ingredient("bow_string", 1)],
        source: stringPath,
        prerequisites: ["Cut the correct log and fletch its unstrung bow at the required level", "Obtain bowstring; string the bow (unstrung output cannot be equipped)"]
      });
    }
    const wiki = "wiki/items/" + gear.name.toLowerCase().replaceAll(" ", "-") + ".md";
    try {
      const info = read(wiki);
      for (const m of info.matchAll(/Dropped by: \[([^\]]+)\]\([^)]*\) \(([^)]+)\)/g))
        gear.methods.push({
          id: "drop:" + gear.id + ":" + m[1],
          kind: "drop",
          source: wiki,
          blocker: "Requires verified safe encounter, travel and measured kill/drop time",
          prerequisites: [m[1] + " drop " + m[2], "Food, suitable gear, replacement-cost budget, and safe return route"]
        });
    } catch {}
  }
  hash.update("goal-catalog-v1");
  return { namespace: hash.digest("hex"), items, shops, evidence };
}

// src/goals/planner.ts
import { existsSync as existsSync4, readFileSync as readFileSync7 } from "fs";

// src/goals/persistence.ts
import { writeFileSync as writeFileSync4, renameSync } from "fs";
function saveGoalJson(file, value, replace = renameSync) {
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync4(tmp, JSON.stringify(value, null, 2));
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0;; attempt++) {
    try {
      replace(tmp, file);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 8)
        throw error;
      Atomics.wait(delay, 0, 0, 10 * (attempt + 1));
    }
  }
}

// src/goals/planner.ts
var dist = (s, p) => Math.max(Math.abs(Number(s.player?.worldX) - p.x), Math.abs(Number(s.player?.worldZ) - p.z));
var funds = (items) => items.filter((i) => /^coins$/i.test(i.name)).reduce((n, i) => n + Number(i.count), 0);
var norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
var qty = (s, id) => itemTotal([...s.inventory ?? [], ...s.equipment ?? []], id);
var protectedItem = (i) => isFood(i) || /axe|pickaxe|knife|hammer|needle|thread|talisman|rune|bow|arrow|sword|scimitar|shield|net|tinderbox/i.test(i.name);
function usable(g, s) {
  return g.requires.every((r) => skillLevel(s, r.skill) >= r.level);
}
function recipeReady(m, s, bank = []) {
  const missing = [];
  if (m.skill && skillLevel(s, m.skill) < (m.level ?? 1))
    missing.push(`${m.skill} ${m.level} (now ${skillLevel(s, m.skill)})`);
  for (const i of m.inputs ?? [])
    if (qty(s, i.id) + itemTotal(bank, i.id) < i.count)
      missing.push(`${i.count} ${i.name}`);
  return missing;
}
function compareMethods(item, s, m, now = Date.now()) {
  return item.methods.map((method) => {
    const blockers = [], totalCash = funds(s.inventory ?? []) + funds(m.bank);
    if (method.blocker)
      blockers.push(method.blocker);
    if ((m.cooldowns[method.id] ?? 0) > now)
      blockers.push("Temporary failure cooldown");
    if (m.uncertain?.method === method.id)
      blockers.push("Uncertain previous transaction; inspect before retry");
    let seconds = null, cashNeeded = 0;
    if (method.kind === "buy") {
      cashNeeded = m.prices[method.id] ?? method.priceHint ?? Infinity;
      if (!Number.isFinite(cashNeeded))
        blockers.push("Unknown price");
      seconds = method.shop ? 20 + dist(s, method.shop) * 0.7 : 20;
      if (cashNeeded + cashReserve(totalCash) > totalCash) {
        blockers.push("Earn or withdraw the purchase budget");
        seconds = null;
      }
    } else if (method.kind === "craft") {
      blockers.push(...recipeReady(method, s, m.bank));
      seconds = blockers.length ? null : method.recipe === "smith" ? 60 : 15;
    } else {
      seconds = null;
    }
    const sample = m.samples[method.id];
    if (sample && seconds !== null)
      seconds = Math.max(seconds, sample.seconds / sample.count);
    return { item, method, seconds, cashNeeded, blockers, estimated: !sample };
  });
}
var cashReserve = (wealth) => Math.min(100, Math.max(5, Math.floor(wealth * 0.15)));
function selectUpgrade(choices, owned) {
  const practical = choices.filter((c) => c.blockers.length === 0 && c.seconds !== null && c.seconds <= 15 * 60);
  const best = practical.sort((a, b) => (b.item.quality - (owned.get(b.item.family) ?? 0)) / (b.seconds + 60) - (a.item.quality - (owned.get(a.item.family) ?? 0)) / (a.seconds + 60))[0];
  if (best)
    return practical.filter((c) => c.item.family === best.item.family && c.seconds <= best.seconds + 120).sort((a, b) => b.item.quality - a.item.quality || a.seconds - b.seconds)[0];
  const funding = choices.filter((c) => c.method.kind === "buy" && c.blockers.every((b) => b === "Earn or withdraw the purchase budget")).sort((a, b) => a.cashNeeded - b.cashNeeded || b.item.quality - a.item.quality);
  const cheapest = funding[0];
  return cheapest ? funding.filter((c) => c.item.family === cheapest.item.family && c.cashNeeded <= cheapest.cashNeeded + 200).sort((a, b) => b.item.quality - a.item.quality || a.cashNeeded - b.cashNeeded)[0] : undefined;
}

class EquipmentGoals {
  file;
  role;
  ranged;
  now;
  workIntent;
  setWorkIntent(intent) {
    this.workIntent = intent;
  }
  memory;
  catalog;
  constructor(file, catalog, role, ranged, now = () => Date.now()) {
    this.file = file;
    this.role = role;
    this.ranged = ranged;
    this.now = now;
    this.catalog = catalog;
    let old;
    try {
      if (existsSync4(file))
        old = JSON.parse(readFileSync7(file, "utf8"));
    } catch {}
    this.memory = old?.version === 1 && old.namespace === catalog.namespace ? old : { version: 1, namespace: catalog.namespace, bank: [], bankCheckedAt: 0, cooldowns: {}, prices: {}, samples: {}, completed: [] };
  }
  save() {
    saveGoalJson(this.file, this.memory);
  }
  seedBank(items) {
    if (!this.memory.bankCheckedAt && !this.memory.bank.length)
      this.memory.bank = items;
  }
  families(_s) {
    return this.role === "economy" ? this.workIntent?.track === "metalworking" ? ["pickaxe"] : ["axe"] : this.ranged ? ["bow", "legs", "hands"] : ["melee"];
  }
  item() {
    return this.catalog.items.find((i) => i.id === this.memory.active?.item);
  }
  method() {
    return this.item()?.methods.find((m) => m.id === this.memory.active?.method);
  }
  strategicMeleeTarget(s) {
    if (this.role !== "brawler" || this.ranged || skillLevel(s, "attack") < 40)
      return;
    const rune = this.catalog.items.find((i) => i.symbol === "rune_scimitar");
    return rune && itemTotal([...s.equipment ?? [], ...s.inventory ?? [], ...this.memory.bank], rune.id) === 0 ? rune : undefined;
  }
  crafting() {
    return this.memory.active?.phase === "craft";
  }
  interrupt(reason) {
    const a = this.memory.active;
    if (a) {
      a.pausedAt ??= this.now();
      a.suspendedReason = reason;
      this.save();
    }
  }
  action(id, type, fields = {}, waitTicks = 2) {
    return { id: "goal-" + id, type, fields: { ...fields, goalMethod: this.memory.active?.method ?? "bank-audit" }, waitTicks };
  }
  finish(s) {
    const g = this.item(), a = this.memory.active;
    if (!g || !a)
      return;
    if (g.tool ? qty(s, g.id) > 0 : itemTotal(s.equipment ?? [], g.id) > 0) {
      this.memory.completed.push({ item: g.id, name: g.name, method: a.method, at: this.now() });
      this.memory.completed = this.memory.completed.slice(-100);
      const sample = this.memory.samples[a.method] ??= { count: 0, seconds: 0 };
      sample.count++;
      sample.seconds += (this.now() - a.started) / 1000;
      delete this.memory.active;
      delete this.memory.lastAttempt;
    }
  }
  plan(s) {
    if (s.bank?.isOpen) {
      this.memory.bank = s.bank.items ?? [];
      this.memory.bankCheckedAt = this.now();
    }
    this.finish(s);
    const strategic = this.strategicMeleeTarget(s);
    const current = this.item();
    if (strategic && current && current.id !== strategic.id && current.family === "melee")
      delete this.memory.active;
    if (s.shop?.isOpen)
      for (const stock of s.shop.shopItems ?? []) {
        const item = this.catalog.items.find((i) => i.id === stock.id);
        if (!item || !(stock.count > 0) || !(stock.buyPrice > 0) || !Number.isFinite(stock.buyPrice))
          continue;
        const key = "observed-buy:" + stock.id;
        if (!item.methods.some((m) => m.id === key))
          item.methods.push({
            id: key,
            kind: "buy",
            priceHint: stock.buyPrice,
            source: "live shop observation",
            shop: { id: key, name: "Observed open shop", npc: "(?!)", x: s.player.worldX, z: s.player.worldZ, level: s.player.level, enabled: true, source: "live shop observation" }
          });
        this.memory.prices[key] = stock.buyPrice;
      }
    const families = this.families(s), owned = new Map;
    for (const i of this.catalog.items)
      if (usable(i, s) && qty(s, i.id) > 0)
        owned.set(i.family, Math.max(owned.get(i.family) ?? 0, i.quality));
    const options = this.catalog.items.filter((i) => families.includes(i.family) && usable(i, s) && i.quality > (owned.get(i.family) ?? 0));
    const choices = options.flatMap((i) => compareMethods(i, s, this.memory, this.now()));
    const active = this.memory.active;
    if (active) {
      const item = this.item(), method = this.method();
      const current = choices.find((c) => c.method.id === active.method);
      const possessionRoute = /^(owned|bank):/.test(active.method);
      if (!item || !families.includes(item.family) || !method && !possessionRoute || !usable(item, s) || item.quality < (owned.get(item.family) ?? 0) || (this.memory.cooldowns[active.method] ?? 0) > this.now() || this.memory.uncertain?.method === active.method)
        delete this.memory.active;
      else if (qty(s, item.id) === 0 && current?.blockers.some((b) => b !== "Earn or withdraw the purchase budget"))
        delete this.memory.active;
      else if (current && qty(s, item.id) === 0 && this.now() - active.started > 30000) {
        const better = selectUpgrade(choices.filter((c) => c.item.family === item.family), owned);
        if (better && better.item.quality > item.quality * 1.2 && better.blockers.length === 0 && better.seconds !== null && better.seconds <= (current.seconds ?? 900) + 120)
          delete this.memory.active;
      }
    }
    if (!this.memory.active) {
      if (strategic) {
        this.memory.active = { item: strategic.id, method: "milestone:rune-scimitar", started: this.now(), lastProgress: this.now(), phase: "milestone", reason: "Attack 40 reached; pursue Rune scimitar while building quest access, Smithing or purchase capital", attempts: 0 };
      }
    }
    if (!this.memory.active) {
      const held = this.catalog.items.filter((i) => families.includes(i.family) && usable(i, s) && qty(s, i.id) > 0 && !i.tool && itemTotal(s.equipment ?? [], i.id) === 0).filter((i) => i.quality > Math.max(0, ...this.catalog.items.filter((g) => g.family === i.family && itemTotal(s.equipment ?? [], g.id) > 0).map((g) => g.quality))).sort((a, b) => b.quality - a.quality)[0];
      const stored = options.filter((i) => itemTotal(this.memory.bank, i.id) > 0).sort((a, b) => b.quality - a.quality)[0];
      const choice = selectUpgrade(choices, owned), item = held ?? stored ?? choice?.item;
      if (item)
        this.memory.active = {
          item: item.id,
          method: held ? "owned:" + item.id : stored ? "bank:" + item.id : choice.method.id,
          started: this.now(),
          lastProgress: this.now(),
          phase: "plan",
          reason: "",
          attempts: 0
        };
    }
    const target = this.item();
    this.memory.overview = {
      updatedAt: new Date(this.now()).toISOString(),
      target: target?.name ?? null,
      goal: this.memory.active,
      longTerm: this.catalog.items.filter((i) => families.includes(i.family) && usable(i, s)).sort((a, b) => b.quality - a.quality).slice(0, 4).map((i) => ({ name: i.name, family: i.family, requires: i.requires })),
      alternatives: choices.map((c) => ({ item: c.item.name, method: c.method.id, kind: c.method.kind, seconds: c.seconds, estimated: c.estimated, cashNeeded: Number.isFinite(c.cashNeeded) ? c.cashNeeded : null, blockers: c.blockers, prerequisites: c.method.prerequisites, source: c.method.source })),
      cash: { carried: funds(s.inventory ?? []), banked: funds(this.memory.bank), bankObservedAt: this.memory.bankCheckedAt || null },
      capital: this.role === "economy" ? {
        targetCoins: this.workIntent ? null : 2000,
        observedCoins: funds(s.inventory ?? []) + funds(this.memory.bank),
        complete: this.workIntent ? this.workIntent.allowLiquidation === false || ![...s.inventory ?? [], ...this.memory.bank].some((i) => ([48, 50, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72].includes(i.id) || i.id === this.workIntent.outputId) && i.count > (this.workIntent.reserve?.[i.id] ?? 0)) : funds(s.inventory ?? []) + funds(this.memory.bank) >= 2000,
        reason: this.workIntent ? "Sell useful surplus to grow net wealth; retain materials assigned to a verified goal" : "Turn banked products into a liquid upgrade reserve before another production batch"
      } : undefined,
      status: target ? "working" : "deferred-or-current-kit-sufficient",
      note: "Unknown effort is not zero. Unsupported mining/training/tanning/dragon trips remain prerequisites, not dispatched actions."
    };
    this.save();
    return this.memory.overview;
  }
  bank(s) {
    const booth = s.nearbyLocs?.filter((l) => /bank booth|bank chest/i.test(l.name) && l.reachable && l.optionsWithIndex?.some((o) => /^use-quickly$|^bank$/i.test(o.text))).sort((a, b) => a.distance - b.distance)[0];
    if (booth)
      return this.action("open-bank", "interactLoc", { x: booth.x, z: booth.z, locId: booth.id, optionIndex: booth.optionsWithIndex.find((o) => /^use-quickly$|^bank$/i.test(o.text)).opIndex });
    const banks = [{ x: 3185, z: 3436, level: 0 }, { x: 3094, z: 3491, level: 0 }].sort((a, b) => dist(s, a) - dist(s, b));
    return this.action("bank-route", "walkTo", banks[0]);
  }
  shop(s, shop) {
    const npc = s.nearbyNpcs?.filter((n) => new RegExp("^(" + shop.npc + ")$", "i").test(n.name) && n.reachable && Math.max(Math.abs(n.x - shop.x), Math.abs(n.z - shop.z)) <= 8).sort((a, b) => a.distance - b.distance).find((n) => n.optionsWithIndex?.some((o) => /^trade$/i.test(o.text)));
    if (npc)
      return this.action("trade-" + shop.id, "interactNpc", { npcIndex: npc.index, optionIndex: npc.optionsWithIndex.find((o) => /^trade$/i.test(o.text)).opIndex });
    return this.action("shop-route-" + shop.id, "walkTo", { x: shop.x, z: shop.z, level: shop.level, reason: "Find and verify " + shop.name });
  }
  async next(s, assess) {
    this.plan(s);
    const g = this.item(), a = this.memory.active, m = this.method();
    if (a?.method === "milestone:rune-scimitar") {
      a.phase = "milestone";
      a.reason = "Rune scimitar target: build capital or Smithing/quest prerequisites; skip intermediate weapon purchases";
      this.save();
      return;
    }
    if (this.memory.supportBlocked && this.memory.supportBlocked.until > this.now()) {
      if (a) {
        a.phase = "waiting-prerequisite";
        a.reason = this.memory.supportBlocked.reason;
      }
      this.save();
      return;
    }
    if (a?.pausedAt !== undefined) {
      a.lastProgress += this.now() - a.pausedAt;
      delete a.pausedAt;
      delete a.suspendedReason;
    }
    if (a && a.phase !== "plan" && this.now() - a.lastProgress > 180000) {
      this.defer("No verified goal progress for three minutes");
      return;
    }
    if (!g || !a) {
      if (this.role !== "economy")
        return;
      const capital = this.capital(s);
      this.save();
      if (capital?.type === "walkTo") {
        const to = capital.fields, checked = await assess({ x: s.player.worldX, z: s.player.worldZ, level: s.player.level }, { x: to.x, z: to.z, level: to.level ?? 0 });
        if (checked.status !== "ready")
          return;
      }
      return capital;
    }
    const inv = s.inventory ?? [];
    const held = inv.find((i) => i.id === g.id), equipped = itemTotal(s.equipment ?? [], g.id) > 0;
    let action;
    if (held && !equipped && !g.tool) {
      if (s.bank?.isOpen || s.shop?.isOpen)
        action = this.action("close-to-equip", "closeModal");
      else {
        const op = held.optionsWithIndex?.find((o) => /^wield$|^wear$/i.test(o.text));
        if (op)
          action = this.action("equip-" + g.id, "useInventoryItem", { slot: held.slot, optionIndex: op.opIndex, expectedItemId: g.id });
      }
      a.phase = "equip";
      a.reason = "Verify the actual equipped item, not dispatch success";
    } else if (!this.memory.bankCheckedAt && (this.memory.auditBlockedUntil ?? 0) <= this.now() && !s.shop?.isOpen) {
      a.phase = "bank-audit";
      a.reason = "Inspect owned gear, ingredients and funds before buying duplicates";
      action = this.bank(s);
    } else if (s.bank?.isOpen) {
      const stored = s.bank.items.find((i) => i.id === g.id);
      const missing = m?.inputs?.find((i) => qty(s, i.id) < i.count && itemTotal(s.bank.items, i.id) > 0);
      const cash = s.bank.items.find((i) => /^coins$/i.test(i.name));
      const budget = (this.memory.prices[a.method] ?? m?.priceHint ?? 0) + cashReserve(funds(inv) + funds(s.bank.items));
      if (inv.length >= 28) {
        const spare = inv.find((i) => !protectedItem(i) && !/^coins$/i.test(i.name));
        if (spare)
          action = this.action("deposit-space", "bankDeposit", { slot: spare.slot, amount: spare.count });
      } else if (stored)
        action = this.action("withdraw-kit", "bankWithdraw", { slot: stored.slot, amount: 1, expectedItemId: stored.id });
      else if (missing)
        action = this.action("withdraw-input", "bankWithdraw", { slot: s.bank.items.find((i) => i.id === missing.id).slot, amount: Math.min(missing.count - qty(s, missing.id), itemTotal(s.bank.items, missing.id)), expectedItemId: missing.id });
      else if (cash && funds(inv) < budget)
        action = this.action("withdraw-fund", "bankWithdraw", { slot: cash.slot, amount: Math.min(cash.count, Math.ceil(budget - funds(inv))), expectedItemId: cash.id });
      else
        action = this.action("close-bank", "closeModal");
      a.phase = "bank-withdrawal";
      a.reason = "Use existing possessions before earning or crafting more";
    } else if (a.method.startsWith("bank:"))
      action = this.bank(s);
    else if (m?.kind === "buy") {
      const budget = this.memory.prices[m.id] ?? m.priceHint ?? Infinity;
      if (s.shop?.isOpen) {
        const stock = s.shop.shopItems?.find((i) => i.id === g.id && i.count > 0 && Number.isFinite(i.buyPrice) && i.buyPrice > 0);
        if (stock) {
          this.memory.prices[m.id] = stock.buyPrice;
          if (stock.buyPrice <= funds(inv) - cashReserve(funds(inv)))
            action = this.action("buy-" + g.id, "shopBuy", { slot: stock.slot, amount: 1, itemId: g.id, expectedPrice: stock.buyPrice });
          else
            action = this.action("close-to-fund", "closeModal");
        } else if (a.phase === "funding")
          action = this.funding(s, budget);
        else {
          this.defer("Shop has no observed affordable target stock");
          action = this.action("close-unavailable-shop", "closeModal");
        }
      } else if (funds(inv) < budget + cashReserve(funds(inv))) {
        a.phase = "funding";
        a.reason = `Build ${budget} gp plus supply reserve for ${g.name}`;
        action = funds(this.memory.bank) > 0 && this.now() - this.memory.bankCheckedAt < 600000 ? this.bank(s) : this.funding(s, budget);
      } else {
        a.phase = "shopping";
        a.reason = "Buy using current stock and price, not the guide price";
        action = this.shop(s, m.shop);
      }
    } else if (m?.kind === "craft") {
      const missing = recipeReady(m, s);
      a.phase = "craft";
      a.reason = "Use owned materials; verify finished item and skill XP";
      if (missing.length)
        action = this.bank(s);
      else if (s.dialog?.isOpen) {
        const label = s.dialog.options?.find((o) => norm(o.text).includes(norm(g.name)) && Number.isInteger(o.index));
        if (label)
          action = this.action("craft-product", "clickDialogOption", { optionIndex: label.index });
        else {
          this.defer("Recipe interface lacks an observed product option");
          action = this.action("close-unknown-recipe", "closeModal");
        }
      } else if (m.recipe === "smith") {
        const anvil = s.nearbyLocs?.find((l) => /^anvil$/i.test(l.name) && (l.reachable || l.distance <= 2));
        action = anvil ? this.action("smith-input", "useItemOnLoc", { itemSlot: inv.find((i) => i.id === m.inputs[0].id).slot, x: anvil.x, z: anvil.z, locId: anvil.id }) : this.action("anvil-route", "walkTo", { x: 3187, z: 3425, level: 0 });
      } else {
        const first = m.recipe === "leather" ? m.inputs[1] : m.inputs[0], second = m.recipe === "leather" ? m.inputs[0] : m.inputs[1];
        action = this.action("craft-input", "useItemOnItem", { sourceSlot: inv.find((i) => i.id === first.id).slot, targetSlot: inv.find((i) => i.id === second.id).slot });
      }
    }
    if (action?.type === "walkTo") {
      const dest = action.fields, check = await assess({ x: s.player.worldX, z: s.player.worldZ, level: s.player.level }, { x: dest.x, z: dest.z, level: dest.level ?? 0 });
      if (check.status === "loading-map")
        return this.action("map-loading", "wait", {}, 2);
      if (check.status !== "ready") {
        this.routeBlocked(a, "Route blocked: " + check.reason);
        return;
      }
      if (dist(s, { x: dest.x, z: dest.z }) === 0) {
        this.routeBlocked(a, "Arrived at hint but service was not observed");
        return;
      }
    }
    if (action)
      a.attempts++;
    this.save();
    return action;
  }
  capital(s) {
    if (this.workIntent?.allowLiquidation === false)
      return;
    const inv = s.inventory ?? [], wealth = funds(inv) + funds(this.memory.bank), target = 2000;
    if (this.memory.overview)
      this.memory.overview.capital = {
        targetCoins: target,
        observedCoins: wealth,
        complete: wealth >= target,
        reason: "Convert banked production into a modest liquid upgrade reserve; this is a budget milestone, not an assumed item price"
      };
    if (wealth >= target && !this.workIntent || this.memory.uncertain || (this.memory.cooldowns["capital"] ?? 0) > this.now())
      return;
    const reserve = (id) => this.workIntent?.reserve?.[id] ?? 0;
    const eligible = (i) => [48, 50, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72].includes(i.id) || i.id === this.workIntent?.outputId;
    const sale = (i) => eligible(i) && itemTotal(inv, i.id) > reserve(i.id);
    const storedSale = (i) => eligible(i) && i.count > reserve(i.id);
    if (this.workIntent && [1511, 1515, 1519, 1521].includes(this.workIntent.outputId ?? 0) && !s.shop?.isOpen) {
      const carried = itemTotal(inv, this.workIntent.outputId);
      if (carried > 0 && carried < 16 || carried === 0 && !this.memory.bank.some((i) => storedSale(i) && i.count >= 16))
        return;
    }
    const estimate = (i) => {
      const q = this.workIntent?.prices?.[i.id];
      return q && this.now() - q.at < 30 * 60000 ? q.price : 0;
    };
    if (this.workIntent && this.memory.overview)
      this.memory.overview.capital = { targetCoins: null, observedCoins: wealth, complete: !inv.some(sale) && !this.memory.bank.some(storedSale), reason: "Sell surplus output for ongoing net wealth; no fixed wealth or skill-level finish line" };
    if (s.bank?.isOpen) {
      if (inv.some(sale))
        return this.action("capital-close-bank", "closeModal");
      const stored = s.bank.items.filter(storedSale).sort((a, b) => estimate(b) - estimate(a) || b.count - a.count)[0];
      if (stored && inv.length < 28)
        return this.action("capital-withdraw", "bankWithdraw", { slot: stored.slot, amount: Math.min(20, 28 - inv.length, stored.count - reserve(stored.id)), expectedItemId: stored.id });
      return;
    }
    if (s.shop?.isOpen) {
      const item = inv.find(sale), offer = s.shop.playerItems?.find((i) => i.id === item?.id && i.sellPrice > 0);
      if (item && offer)
        return this.action("capital-sale", "shopSell", { slot: item.slot, amount: 1, itemId: item.id, expectedPrice: offer.sellPrice });
      return this.action("capital-close-shop", "closeModal");
    }
    if (inv.some(sale))
      return this.shop(s, { id: "capital-general", name: "Varrock General Store", npc: "Shop keeper|Shop assistant", x: 3218, z: 3415, level: 0, enabled: true, source: "wiki/shops/varrock-general-store.md" });
    if (this.memory.bank.some(storedSale) || !this.memory.bankCheckedAt)
      return this.bank(s);
    return;
  }
  validate(s, a) {
    if (!a.id.startsWith("goal-"))
      return true;
    if (a.type === "shopBuy") {
      const row = s.shop?.shopItems?.find((i) => i.slot === a.fields?.slot && i.id === a.fields?.itemId && i.count >= a.fields?.amount);
      return s.shop?.isOpen === true && !!row && row.buyPrice === a.fields?.expectedPrice && funds(s.inventory ?? []) >= row.buyPrice * a.fields.amount + cashReserve(funds(s.inventory ?? []));
    }
    if (a.type === "shopSell")
      return s.shop?.isOpen === true && s.inventory?.some((i) => i.slot === a.fields?.slot && i.id === a.fields?.itemId && i.count >= a.fields?.amount) && s.shop.playerItems?.some((i) => i.id === a.fields?.itemId && i.sellPrice === a.fields?.expectedPrice && i.sellPrice > 0);
    if (a.fields?.expectedItemId !== undefined) {
      const source = a.type === "bankWithdraw" ? s.bank?.items : s.inventory;
      return (a.type !== "bankWithdraw" || s.bank?.isOpen === true) && source?.some((i) => i.slot === a.fields?.slot && i.id === a.fields?.expectedItemId);
    }
    return true;
  }
  funding(s, budget) {
    const inv = s.inventory ?? [];
    const axe = [...inv, ...s.equipment ?? []].find((i) => /^(bronze|iron|steel|black|mithril|adamant|rune) axe$/i.test(i.name));
    const sale = (i) => /^(logs|oak logs|willow logs|yew logs|cowhide)$/i.test(i.name) || [48, 50, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72].includes(i.id);
    if (s.shop?.isOpen) {
      if (!axe) {
        const quoted = s.shop.shopItems?.find((i) => /^bronze axe$/i.test(i.name) && i.count > 0 && Number.isFinite(i.buyPrice) && i.buyPrice > 0);
        if (quoted)
          this.memory.prices["support:bronze-axe"] = quoted.buyPrice;
        const tool = s.shop.shopItems?.find((i) => /^bronze axe$/i.test(i.name) && i.count > 0 && Number.isFinite(i.buyPrice) && i.buyPrice > 0 && i.buyPrice <= funds(inv) - cashReserve(funds(inv)));
        if (tool)
          return this.action("buy-funding-axe", "shopBuy", { slot: tool.slot, amount: 1, itemId: tool.id, expectedPrice: tool.buyPrice });
      }
      const item = inv.find(sale), offer = s.shop.playerItems?.find((i) => i.id === item?.id && Number(i.sellPrice) > 0);
      if (item && offer)
        return this.action("sell-funding", "shopSell", { slot: item.slot, amount: 1, itemId: item.id, expectedPrice: offer.sellPrice });
      return this.action("close-funded-shop", "closeModal");
    }
    const valueItems = inv.filter(sale);
    if (valueItems.length >= 6 || inv.length >= 28 && valueItems.length)
      return this.shop(s, { id: "funding-general", name: "Varrock General Store", npc: "Shop keeper|Shop assistant", x: 3218, z: 3415, level: 0, enabled: true, source: "wiki/shops/varrock-general-store.md" });
    const loot = s.groundItems?.filter((i) => i.reachable && i.distance <= 5 && (/^coins$/i.test(i.name) || sale(i))).sort((a, b) => a.distance - b.distance)[0];
    if (loot && inv.length < 28)
      return this.action("funding-loot", "pickupItem", { x: loot.x, z: loot.z, itemId: loot.id });
    const shortfall = budget + cashReserve(funds(inv)) - funds(inv);
    if (this.ranged && !axe && shortfall > 0 && shortfall <= 50 && Number(s.player.hp) >= Number(s.player.maxHp) * 0.85 && inv.filter(isFood).length >= 2) {
      const mark = s.nearbyNpcs?.find((n) => /^(man|woman)$/i.test(n.name) && n.reachable && n.distance <= 5 && n.optionsWithIndex?.some((o) => /^pickpocket$/i.test(o.text)));
      if (mark)
        return this.action("funding-pickpocket", "interactNpc", { npcIndex: mark.index, optionIndex: mark.optionsWithIndex.find((o) => /^pickpocket$/i.test(o.text)).opIndex }, 4);
    }
    if (!axe && funds(inv) >= (this.memory.prices["support:bronze-axe"] ?? 16) + cashReserve(funds(inv)))
      return this.shop(s, this.catalog.shops.find((p) => p.id === "bobs-brilliant-axes"));
    if (axe && inv.length < 28) {
      const trees = s.nearbyLocs?.filter((l) => (/^tree$/i.test(l.name) || /^oak$/i.test(l.name) && skillLevel(s, "woodcutting") >= 15) && l.reachable && l.distance <= 16 && l.optionsWithIndex?.some((o) => /^chop/i.test(o.text))).sort((a, b) => a.distance - b.distance);
      const tree = trees?.[0];
      if (tree)
        return Number(s.player?.animId) >= 0 ? this.action("funding-harvest-wait", "wait") : this.action("funding-chop", "interactLoc", { x: tree.x, z: tree.z, locId: tree.id, optionIndex: tree.optionsWithIndex.find((o) => /^chop/i.test(o.text)).opIndex }, 5);
      return this.action("funding-trees-route", "walkTo", { x: 3169, z: 3420, level: 0 });
    }
    this.memory.active.reason = `Funding blocked: ${budget} gp needed; obtain a gathering axe or verified loot/sale income first`;
    return;
  }
  routeBlocked(a, reason) {
    if (["funding", "bank-audit", "bank-withdrawal"].includes(a.phase)) {
      this.memory.supportBlocked = { until: this.now() + 60000, reason };
      a.phase = "waiting-prerequisite";
      a.reason = reason;
      this.save();
    } else
      this.defer(reason);
  }
  defer(reason) {
    const a = this.memory.active;
    if (a) {
      this.memory.cooldowns[a.method] = this.now() + 300000;
      (this.memory.blockedReasons ??= {})[a.method] = reason;
      if (a.phase === "bank-audit")
        this.memory.auditBlockedUntil = this.now() + 300000;
      a.reason = reason;
      a.phase = "blocked";
    } else
      this.memory.cooldowns["capital"] = this.now() + 300000;
    this.save();
  }
  failed(action, message) {
    if (!action.id.startsWith("goal-"))
      return;
    if (/unavailable|timeout|timed out/i.test(message) && ["shopBuy", "shopSell", "bankDeposit", "bankWithdraw", "useItemOnItem", "useItemOnLoc"].includes(action.type)) {
      this.memory.uncertain = { method: String(action.fields?.goalMethod), reason: "Transaction outcome unknown; not automatically replayed" };
    }
    this.defer(message);
  }
  after(before, after, action) {
    if (!action.id.startsWith("goal-"))
      return;
    let progress = before.player?.worldX !== after.player?.worldX || before.player?.worldZ !== after.player?.worldZ || JSON.stringify(before.inventory) !== JSON.stringify(after.inventory) || JSON.stringify(before.equipment) !== JSON.stringify(after.equipment) || before.bank?.isOpen !== after.bank?.isOpen || before.shop?.isOpen !== after.shop?.isOpen || JSON.stringify(before.dialog) !== JSON.stringify(after.dialog);
    if (action.type === "shopBuy")
      progress = qty(after, Number(action.fields?.itemId)) > qty(before, Number(action.fields?.itemId)) && funds(after.inventory) < funds(before.inventory);
    if (action.type === "shopSell")
      progress = qty(after, Number(action.fields?.itemId)) < qty(before, Number(action.fields?.itemId)) && funds(after.inventory) > funds(before.inventory);
    if (progress) {
      if (this.memory.active)
        this.memory.active.lastProgress = this.now();
      delete this.memory.lastAttempt;
    } else if (action.type !== "wait" && !action.id.includes("funding-chop")) {
      const signature = action.id + ":" + before.player?.worldX + ":" + before.player?.worldZ;
      const repeats = this.memory.lastAttempt?.signature === signature ? this.memory.lastAttempt.repeats + 1 : 1;
      this.memory.lastAttempt = { signature, repeats };
      if (repeats >= 2)
        this.defer("Two attempts without the intended effect");
    }
    this.finish(after);
    this.save();
  }
}

// src/economy/market.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { createHash as createHash3 } from "crypto";
var PEERS = ["clawscout", "stinger", "coincrafter"];
var TRANSFER_BLOCKER = "Player Trade option is not labelled in live state; item-offer transfer not live-verified. No automatic transfer or rendezvous.";
var FRESH = 30 * 60000;
var count = (items, id) => items.filter((i) => i.id === id).reduce((n, i) => n + Number(i.count), 0);
var compact = (items) => [...new Set(items.map((i) => i.id))].map((id) => ({ id, name: items.find((i) => i.id === id).name, count: count(items, id) }));
var hash = (v) => createHash3("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 20);
function bargain(input) {
  if (!Object.values(input).filter((v) => v !== null && v !== undefined).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) || !Number.isInteger(input.quantity) || input.quantity < 1)
    return null;
  const floor = Math.ceil(Math.max(input.sellerOutside, input.sellerCost) * input.quantity + input.handling + 1);
  const ceiling = Math.floor(Math.min(input.budget, input.buyerOutside * input.quantity - input.handling - 1));
  if (floor > ceiling)
    return null;
  const ask = Math.max(floor, Math.min(ceiling, Math.round((input.market ?? input.buyerOutside) * input.quantity)));
  const counter = Math.floor((floor + ask) / 2);
  return { floor, ceiling, ask, counter, quantity: input.quantity };
}
function peerDemand(s, character, catalog, bank = []) {
  const inv = s.inventory ?? [], eq = s.equipment ?? [], cash = count(inv, 995) + count(bank, 995), budget = Math.max(0, cash - cashReserve(cash));
  const family = character === "stinger" ? "bow" : "melee";
  const held = Math.max(0, ...catalog.items.filter((g) => g.family === family && count([...inv, ...eq, ...bank], g.id) > 0).map((g) => g.quality));
  const result = catalog.items.filter((g) => g.family === family && usable(g, s) && g.quality > held).map((g) => ({ id: g.id, name: g.name, quantity: 1, quality: g.quality }));
  if (character === "stinger") {
    const tiers = ["bronze", "iron", "steel", "mithril", "adamant", "rune"];
    const cap = bowArrowCap(s.combatStyle?.weaponName ?? "");
    const ammo = [882, 884, 886, 888, 890, 892].filter((_, i) => i + 1 <= cap);
    const reserve = ammo.reduce((n, id) => n + count([...inv, ...eq, ...bank], id), 0);
    if (reserve < 100)
      ammo.forEach((id, i) => result.unshift({ id, name: tiers[i] + " arrow", quantity: Math.min(100, 100 - reserve), quality: 0 }));
  }
  return { budget, items: character === "coincrafter" ? [] : result };
}

class PeerMarket {
  character;
  catalog;
  now;
  world;
  db;
  constructor(file, character, catalog, now = () => Date.now(), world = "https://clawscape.xyz") {
    this.character = character;
    this.catalog = catalog;
    this.now = now;
    this.world = world;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.exec("PRAGMA busy_timeout=15000;");
    try {
      this.db.exec("PRAGMA journal_mode=WAL;");
    } catch (error) {
      if (!/database is locked/i.test(error instanceof Error ? error.message : String(error)))
        throw error;
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS snapshots(world TEXT,character TEXT,at INTEGER,body TEXT,PRIMARY KEY(world,character));
      CREATE TABLE IF NOT EXISTS quotes(world TEXT,source TEXT,item INTEGER,kind TEXT,at INTEGER,price REAL,PRIMARY KEY(world,source,item,kind));
      CREATE TABLE IF NOT EXISTS deals(id TEXT PRIMARY KEY,world TEXT,seller TEXT,buyer TEXT,item INTEGER,body TEXT,stage TEXT,expires INTEGER);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,world TEXT,sender TEXT,target TEXT,body TEXT,status TEXT,at INTEGER);
      CREATE INDEX IF NOT EXISTS peer_message_queue ON messages(world,sender,status);`);
  }
  close() {
    this.db.close();
  }
  rows() {
    return this.db.query("SELECT character,body FROM snapshots WHERE world=? AND at>=?").all(this.world, this.now() - FRESH).map((r) => ({ character: r.character, ...JSON.parse(r.body) })).filter((r) => r.namespace === this.catalog.namespace);
  }
  enqueue(target, body, key) {
    if (!PEERS.includes(target) || target === this.character)
      return;
    const id = hash([this.world, this.character, target, key, Math.floor(this.now() / FRESH)]);
    this.db.query("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?)").run(id, this.world, this.character, target, body, "queued", this.now());
  }
  observe(s, bank, bankAt, production) {
    if (!PEERS.includes(this.character))
      return;
    this.db.query("UPDATE messages SET status='superseded' WHERE world=? AND sender=? AND status='queued' AND body LIKE '%after my two current skills reach 99%'").run(this.world, this.character);
    const freshBank = bankAt > 0 && this.now() - bankAt < FRESH ? bank : [];
    const body = {
      namespace: this.catalog.namespace,
      inventory: compact(s.inventory ?? []),
      bank: compact(freshBank),
      bankAt: bankAt || null,
      equipment: compact(s.equipment ?? []),
      demand: peerDemand(s, this.character, this.catalog, freshBank),
      skills: Object.fromEntries((s.skills ?? []).map((v) => [v.name.toLowerCase(), v.baseLevel ?? v.level])),
      production: this.character === "coincrafter" ? { objective: "Maximize sustainable net wealth; train or gather when it advances that outcome", ...production, transferBlocker: TRANSFER_BLOCKER } : undefined
    };
    this.db.query("INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?)").run(this.world, this.character, this.now(), JSON.stringify(body));
    if (s.shop?.isOpen) {
      const source = String(s.shop.name ?? "shop") + ":" + s.player.worldX + "," + s.player.worldZ;
      for (const [kind, items, field] of [["npc-buy", s.shop.shopItems ?? [], "buyPrice"], ["npc-sell", s.shop.playerItems ?? [], "sellPrice"]])
        for (const i of items) {
          if (!Number.isFinite(i[field]) || i[field] <= 0 || kind === "npc-buy" && !(i.count > 0))
            continue;
          if (kind === "npc-sell" && !/general/i.test(s.shop.name ?? "") && !s.shop.shopItems?.some((r) => r.id === i.id))
            continue;
          this.db.query("INSERT OR REPLACE INTO quotes VALUES (?,?,?,?,?,?)").run(this.world, source, i.id, kind, this.now(), i[field]);
        }
    }
    this.db.query("UPDATE messages SET status='expired' WHERE world=? AND status='queued' AND at<?").run(this.world, this.now() - FRESH);
    this.db.query("UPDATE deals SET stage='expired' WHERE world=? AND expires<? AND stage!='expired'").run(this.world, this.now());
    this.db.query("DELETE FROM messages WHERE world=? AND at<?").run(this.world, this.now() - 7 * 86400000);
    this.db.query("DELETE FROM deals WHERE world=? AND expires<?").run(this.world, this.now() - 7 * 86400000);
    this.negotiate();
  }
  negotiate() {
    const rows = this.rows(), mine = rows.find((r) => r.character === this.character);
    if (!mine)
      return;
    const producer = rows.find((r) => r.character === "coincrafter");
    if (this.character !== "coincrafter" && mine.demand.items.length && producer) {
      const ammo = mine.demand.items.some((i) => i.quantity > 1);
      this.enqueue("coincrafter", `Looking for ${this.character === "stinger" ? ammo ? "arrows and a finished shortbow upgrade" : "a finished shortbow upgrade" : "a better melee weapon"}. I can spare up to ${mine.demand.budget} gp after supplies. Anything worth buying?`, "request");
    }
    if (this.character === "coincrafter")
      for (const buyer of rows.filter((r) => r.character !== this.character && r.demand?.items.length)) {
        const stock = [...mine.inventory, ...mine.bank], demands = buyer.demand.items;
        const matches = demands.filter((d) => count(stock, d.id) > 0 && !mine.equipment.some((i) => i.id === d.id));
        if (!matches.length) {
          const unfinished = stock.some(isFletchedOutput), shafts = count(stock, 52) > 0;
          const requested = this.db.query("SELECT id FROM messages WHERE world=? AND sender=? AND target=? AND status IN ('submitted','echo-verified','submitted-unconfirmed') AND at>?").get(this.world, buyer.character, this.character, this.now() - FRESH);
          if (!requested)
            continue;
          this.enqueue(buyer.character, buyer.character === "stinger" ? `My ${unfinished ? "banked bows are unstrung" : "bow stock is not ready"}${shafts ? ", and shafts still need feathers and arrowheads" : ""}. I need to price the remaining materials before promising finished kit.` : "I have no spare melee upgrade yet. I will compare making your gear against buying it; Mining and Smithing are options when the costs and likely return justify them.", "stock-status-v2");
        }
        for (const d of matches) {
          const quotes = this.db.query("SELECT kind,price FROM quotes WHERE world=? AND item=? AND at>=?").all(this.world, d.id, this.now() - FRESH);
          const sells = quotes.filter((q) => q.kind === "npc-sell").map((q) => q.price), buys = quotes.filter((q) => q.kind === "npc-buy").map((q) => q.price);
          if (!sells.length || !buys.length)
            continue;
          const quantity = Math.min(d.quantity, count(stock, d.id)), terms = bargain({ quantity, sellerOutside: Math.max(...sells), sellerCost: 0, buyerOutside: Math.min(...buys), budget: buyer.demand.budget, handling: 2 });
          if (!terms)
            continue;
          if (this.db.query("SELECT id FROM deals WHERE world=? AND buyer=? AND stage!='expired'").get(this.world, buyer.character))
            break;
          const id = hash([this.world, this.character, buyer.character, d.id, Math.floor(this.now() / FRESH)]);
          const body = { ...terms, name: d.name, transferBlocker: TRANSFER_BLOCKER };
          this.db.query("INSERT OR IGNORE INTO deals VALUES (?,?,?,?,?,?,?,?)").run(id, this.world, this.character, buyer.character, d.id, JSON.stringify(body), "offered", this.now() + FRESH);
          this.enqueue(buyer.character, `I have ${quantity} ${d.name}. How about ${terms.ask} gp total? Both of us beat the shop prices I checked. Delivery is on hold until safe trading works.`, id + ":ask");
          break;
        }
      }
    for (const deal of this.db.query("SELECT * FROM deals WHERE world=? AND expires>? AND stage IN ('offered','countered')").all(this.world, this.now())) {
      const terms = JSON.parse(deal.body);
      if (deal.buyer === this.character && deal.stage === "offered" && mine.demand.items.some((d) => d.id === deal.item) && mine.demand.budget >= terms.counter) {
        this.db.query("UPDATE deals SET stage='countered' WHERE id=? AND stage='offered'").run(deal.id);
        this.enqueue(deal.seller, `Could you do ${terms.counter} gp for ${terms.quantity} ${terms.name}? That leaves my food and ammunition reserve intact.`, deal.id + ":counter");
      } else if (deal.seller === this.character && deal.stage === "countered" && terms.counter >= terms.floor && count([...mine.inventory, ...mine.bank], deal.item) >= terms.quantity) {
        this.db.query("UPDATE deals SET stage='agreed-pending-safe-transfer' WHERE id=? AND stage='countered'").run(deal.id);
        this.enqueue(deal.buyer, `${terms.counter} gp works for me. That is a provisional price, not a completed sale; we can settle once safe trading is available.`, deal.id + ":agree");
      }
    }
  }
  next(s) {
    if (!PEERS.includes(this.character) || s.modalOpen || s.dialog?.isOpen || s.bank?.isOpen || s.shop?.isOpen || s.player?.combat?.inCombat || Number(s.player?.animId) >= 0)
      return;
    const recent = this.db.query("SELECT id FROM messages WHERE world=? AND sender=? AND status IN ('submitted','echo-verified','submitted-unconfirmed') AND at>?").get(this.world, this.character, this.now() - 60000);
    if (recent)
      return;
    const row = this.db.query("SELECT * FROM messages WHERE world=? AND sender=? AND status='queued' ORDER BY at LIMIT 1").get(this.world, this.character);
    if (row)
      return { id: "peer-message-" + row.id, type: "privateMessage", fields: { targetName: row.target, message: row.body }, waitTicks: 2 };
  }
  before(action) {
    if (action.id.startsWith("peer-message-"))
      this.db.query("UPDATE messages SET status='submitted',at=? WHERE id=? AND status='queued'").run(this.now(), action.id.slice(13));
  }
  after(s, action) {
    if (!action.id.startsWith("peer-message-"))
      return;
    const echo = s.gameMessages?.some((m) => m.fromSelf && m.text?.toLowerCase() === String(action.fields?.message).toLowerCase());
    this.db.query("UPDATE messages SET status=? WHERE id=?").run(echo ? "echo-verified" : "submitted-unconfirmed", action.id.slice(13));
  }
  overview() {
    return {
      transferEnabled: false,
      blocker: TRANSFER_BLOCKER,
      agents: this.rows(),
      deals: this.db.query("SELECT * FROM deals WHERE world=? AND expires>?").all(this.world, this.now()).map((d) => ({ ...d, body: JSON.parse(d.body) })),
      messages: this.db.query("SELECT sender,target,body,status,at FROM messages WHERE world=? ORDER BY at DESC LIMIT 12").all(this.world)
    };
  }
}

// src/supply-policy.ts
function mayPickpocketForAmmo(inventorySlots, consecutiveAttempts) {
  return inventorySlots < 26 && consecutiveAttempts < 2;
}

// src/economy/objectives.ts
var count2 = (items, id) => items.filter((i) => i.id === id).reduce((n, i) => n + Number(i.count), 0);
var HORIZON = 30 * 60000;
function objectives(m) {
  return m.objectives ??= { prices: {}, samples: {}, completed: 0, lastProbe: 0, needs: [], blocked: {} };
}
function netProfitPerHour(e) {
  if (!e.saleable || ![e.revenue, e.materialCost, e.supplyCost, e.expectedLoss, e.seconds].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) || !(e.seconds > 0))
    return null;
  return (e.revenue - e.materialCost - e.supplyCost - e.expectedLoss) * 3600 / e.seconds;
}
function chooseOpportunity(choices, old, now, probe = false) {
  const eligible = choices.filter((c) => !c.blocked), demand = eligible.filter((c) => c.usefulNeed?.verified && c.usefulNeed.downstreamReady && c.usefulNeed.quantity > 0 && c.usefulNeed.expires > now);
  if (demand.length)
    return demand.find((c) => c.intent.id === old?.id) ?? demand[0];
  const scored = eligible.map((c) => ({ c, score: netProfitPerHour(c.economics) }));
  if (probe) {
    const unknown = scored.find((c) => c.score === null && c.c.intent.id !== old?.id);
    if (unknown)
      return unknown.c;
  }
  const ranked = scored.filter((c) => c.score !== null).sort((a, b) => b.score - a.score);
  const current = ranked.find((c) => c.c.intent.id === old?.id);
  if (ranked[0] && ranked[0].score > 0) {
    if (current && current.score >= ranked[0].score * 0.85)
      return current.c;
    return ranked[0].c;
  }
  return scored.find((c) => c.score === null && c.c.intent.id === old?.id)?.c ?? scored.find((c) => c.score === null)?.c;
}
var woods = {
  Tree: { input: 1511, name: "Logs", short: 50, long: 48 },
  Oak: { input: 1521, name: "Oak logs", short: 54, long: 56 },
  Willow: { input: 1519, name: "Willow logs", short: 60, long: 58 },
  Yew: { input: 1515, name: "Yew logs", short: 68, long: 66 }
};
function workOpportunities(s, m, now = Date.now()) {
  const memory = objectives(m), result = [];
  const add = (intent, blocked) => {
    const samples = (memory.samples[intent.id] ?? []).filter((v) => now - v.at < 24 * 3600000).slice(-5);
    const units = samples.reduce((n, v) => n + v.units, 0), seconds = samples.reduce((n, v) => n + v.seconds, 0), price = memory.prices[intent.outputId];
    const fresh = price && now - price.at < HORIZON;
    const saleOverhead = 120;
    const economics = {
      revenue: fresh && units > 0 ? price.price * units : null,
      materialCost: 0,
      supplyCost: units > 0 ? samples.reduce((n, v) => n + v.cost, 0) : null,
      expectedLoss: units > 0 ? samples.reduce((n, v) => n + v.loss, 0) : null,
      seconds: units > 0 ? seconds + saleOverhead * samples.filter((v) => !v.sold).length : null,
      saleable: !!fresh
    };
    const need = memory.needs.find((n) => n.outputId === intent.outputId && count2([...s.inventory ?? [], ...m.bankItems ?? []], intent.outputId) < n.quantity);
    result.push({ intent, economics, usefulNeed: need, blocked: blocked ?? ((memory.blocked[intent.id] ?? 0) > now ? "recent action failure" : undefined) });
  };
  const sites = woodSites(s, false);
  for (const site of sites) {
    const w = woods[site.tree];
    const recipe = fletchingRecipe(w.name, skillLevel(s, "fletching"));
    const common = { track: "woodworking", site: site.name, inputId: w.input, inputName: w.name };
    if (recipe) {
      const short = /short/i.test(recipe), outputId = /shafts/i.test(recipe) ? 52 : short ? w.short : w.long;
      add({ ...common, id: site.name + ":fletch:" + outputId, mode: "fletch", outputId, recipe, reason: "Produce saleable kit inputs; compare measured cycle return" }, (m.siteCooldowns?.[site.name] ?? 0) > now ? "resource cooldown" : undefined);
      if (!short && recipe !== "Arrow Shafts" && memory.needs.some((n) => n.outputId === w.short))
        add({ ...common, id: site.name + ":fletch:" + w.short, mode: "fletch", outputId: w.short, recipe: (site.tree === "Tree" ? "" : site.tree + " ") + "Short Bow", reason: "Bounded input for a verified equipment/production goal" });
    }
    add({ ...common, id: site.name + ":logs", mode: "logs", outputId: w.input, reason: "Sell useful raw materials when processing would reduce return" }, (m.siteCooldowns?.[site.name] ?? 0) > now ? "resource cooldown" : undefined);
  }
  const iron = skillLevel(s, "mining") >= 15 && skillLevel(s, "smithing") >= 15;
  add({ id: iron ? "metal:iron" : "metal:bronze", track: "metalworking", mode: "metal", inputId: iron ? 440 : 436, inputName: iron ? "Iron ore" : "Copper ore", outputId: iron ? skillLevel(s, "smithing") >= 20 ? 40 : 1203 : skillLevel(s, "smithing") >= 5 ? 39 : 1205, reason: "Test a mining/smithing production chain for future profitable goods" }, !canMine(s) || foodCount(s) === 0 ? "Needs a usable carried pickaxe and food" : undefined);
  for (const bow of [...BOWS].reverse())
    if (skillLevel(s, "fletching") >= bow.level && count2([...s.inventory ?? [], ...m.bankItems ?? []], bow.input) > 0) {
      const intent = { id: "finish-bow:" + bow.input, track: "woodworking", mode: "finish", inputId: bow.input, inputName: bow.name, outputId: bow.output, reason: "Unlock Crafting 10 and measure finished bows against unstrung sales" };
      add(intent, (m.bowmaking?.cooldownUntil ?? 0) > now ? "Bowmaking recovery cooldown" : undefined);
      const rows = (m.bowmaking?.samples?.[bow.output] ?? []).filter((r) => now - r.at < 24 * 3600000), units = rows.reduce((n, r) => n + r.units, 0), price = memory.prices[bow.output];
      result[result.length - 1].economics = {
        revenue: price && now - price.at < HORIZON && units > 0 ? price.price * units : null,
        materialCost: units > 0 && rows.every((r) => r.inputValue !== null && r.stringsValue !== null) ? rows.reduce((n, r) => n + (r.inputValue + r.stringsValue) * r.units, 0) : null,
        supplyCost: units > 0 ? rows.reduce((n, r) => n + r.cost, 0) : null,
        expectedLoss: units > 0 ? 0 : null,
        seconds: units > 0 ? rows.reduce((n, r) => n + r.seconds + 120, 0) : null,
        saleable: !!price && now - price.at < HORIZON
      };
    }
  return result;
}
function selectWork(s, m, now = Date.now()) {
  const memory = objectives(m), choices = workOpportunities(s, m, now);
  memory.needs = memory.needs.filter((n) => n.expires > now);
  const boundary = !s.shop?.isOpen && !s.dialog?.isOpen && !s.modalOpen && Number(s.player?.animId ?? -1) < 0 && !(s.inventory ?? []).some((i) => /^(.*logs|logs|.*ore|.*bar|.*arrowheads|.*dagger)$/i.test(i.name) || [48, 50, 54, 56, 58, 60, 66, 68].includes(i.id));
  if (!memory.intent && !boundary && m.metal?.phase) {
    const resume = choices.find((c) => c.intent.track === "metalworking" && !c.blocked);
    if (resume) {
      memory.intent = { ...resume.intent, reason: "Finish the pre-existing metal batch before comparing a new job" };
      memory.decision = { at: now, chosen: memory.intent, reason: "Resume existing batch; no new production-rate sample" };
      return memory.intent;
    }
  }
  const current = choices.find((c) => c.intent.id === memory.intent?.id);
  if (memory.intent?.mode === "finish" && m.bowmaking?.active && !current?.blocked)
    return memory.intent;
  if (memory.intent && !boundary && (!current || !current.blocked))
    return memory.intent;
  const probe = boundary && memory.completed - memory.lastProbe >= 5;
  const trialCount = (id) => (memory.trials?.[id] ?? 0) + (memory.samples[id]?.length ?? 0);
  const ordered = probe ? [...choices].sort((a, b) => trialCount(a.intent.id) - trialCount(b.intent.id)) : choices;
  const firstFinish = boundary && !m.bowmaking?.trialComplete ? choices.find((c) => c.intent.mode === "finish" && !c.blocked) : undefined;
  const chosen = firstFinish ?? chooseOpportunity(ordered, memory.intent, now, probe);
  if (probe)
    memory.lastProbe = memory.completed;
  if (probe && chosen)
    (memory.trials ??= {})[chosen.intent.id] = (memory.trials?.[chosen.intent.id] ?? 0) + 1;
  if (chosen) {
    if (memory.intent?.id !== chosen.intent.id) {
      delete memory.cycle;
      delete m.harvest;
      delete m.processing;
      delete m.product;
      delete m.metal;
    }
    memory.intent = { ...chosen.intent };
    const rate = netProfitPerHour(chosen.economics);
    memory.intent.reason = chosen.usefulNeed?.verified && chosen.usefulNeed.downstreamReady ? "Supply " + chosen.usefulNeed.goal : rate !== null ? `Estimated net ${Math.round(rate)} gp/hour from observed production and fresh prices; includes provisional sale travel allowance` : firstFinish ? "Bounded Crafting unlock and finished-bow trial; compare measured net value afterward" : probe ? "Bounded alternative production trial; profitability is unknown" : "Continue supported production while collecting price/throughput evidence; profitability is unknown";
    memory.decision = {
      at: now,
      objective: "Grow sustainable net wealth; skills and tools are investments",
      chosen: memory.intent,
      estimatedNetGpHour: rate,
      alternatives: choices.map((c) => ({ id: c.intent.id, estimatedNetGpHour: netProfitPerHour(c.economics), blocked: c.blocked ?? null })),
      notAnInflationOrOptimalityClaim: true
    };
  } else {
    delete memory.intent;
    memory.decision = { at: now, objective: "Grow sustainable net wealth", blocker: "No currently supported productive opportunity" };
  }
  if (memory.intent && !memory.cycle)
    memory.cycle = {
      id: memory.intent.id,
      started: now,
      produced: 0,
      gathered: 0,
      sold: false,
      expenses: 0,
      loss: 0,
      bankedInputs: false,
      incompleteStart: count2(s.inventory ?? [], memory.intent.inputId) > 0 || count2(s.inventory ?? [], memory.intent.outputId) > 0
    };
  return memory.intent;
}
function observeWork(before, after, a, m, now = Date.now()) {
  const memory = objectives(m), { intent, cycle } = memory;
  if (after.shop?.isOpen)
    for (const i of after.shop.playerItems ?? []) {
      if (!(i.sellPrice > 0) || !Number.isFinite(i.sellPrice))
        continue;
      if (!/general/i.test(after.shop.name ?? after.shop.shopName ?? "") && !after.shop.shopItems?.some((r) => r.id === i.id))
        continue;
      memory.prices[i.id] = { price: i.sellPrice, at: now, verifiedSale: false };
    }
  const cashChange = count2(after.inventory ?? [], 995) - count2(before.inventory ?? [], 995);
  if (a.type === "shopSell") {
    const item = before.inventory?.find((i) => i.slot === a.fields?.slot), sold = item ? count2(before.inventory, item.id) - count2(after.inventory ?? [], item.id) : 0;
    if (item && sold > 0 && cashChange > 0)
      memory.prices[item.id] = { price: cashChange / sold, at: now, verifiedSale: true };
  }
  if (!intent || !cycle)
    return;
  if (intent.mode === "finish")
    return;
  if (before.player?.lifeId !== after.player?.lifeId || after.player?.isDead) {
    delete memory.cycle;
    memory.blocked[intent.id] = now + 10 * 60000;
    return;
  }
  const delta = count2(after.inventory ?? [], intent.outputId) - count2(before.inventory ?? [], intent.outputId);
  if (!/^(bank|shop|useEquipment|useInventory|pickup|interactGround)/.test(a.type)) {
    if (delta > 0)
      cycle.produced += delta;
    cycle.gathered += Math.max(0, count2(after.inventory ?? [], intent.inputId) - count2(before.inventory ?? [], intent.inputId));
  }
  if (a.type === "shopBuy" && cashChange < 0)
    cycle.expenses -= cashChange;
  if (a.type === "bankWithdraw" && count2(after.inventory ?? [], intent.inputId) > cycle.gathered)
    cycle.bankedInputs = true;
  if (a.type === "shopSell" && delta < 0 && cashChange > 0)
    cycle.sold = true;
  if (a.type === "closeModal" && (before.bank?.isOpen && !after.bank?.isOpen || before.shop?.isOpen && !after.shop?.isOpen) && cycle.produced > 0) {
    if (!cycle.incompleteStart && !cycle.bankedInputs && now > cycle.started) {
      const rows = memory.samples[intent.id] ??= [];
      rows.push({ units: cycle.produced, seconds: (now - cycle.started) / 1000, cost: cycle.expenses, loss: cycle.loss, sold: cycle.sold, at: now });
      memory.samples[intent.id] = rows.slice(-5);
    }
    memory.completed++;
    delete memory.cycle;
  }
}

// src/goals/outcomes.ts
var mission = (role) => role === "economy" ? "Maximize sustainable net wealth; choose production, skill unlocks and tools by their value" : "Become stronger through useful equipment and build-compatible experience, while sustaining supplies and avoiding death";
function usefulXp(before, after, role, ranged) {
  const combat = new Set(ranged ? ["ranged", "magic", "hitpoints"] : ["attack", "strength", "hitpoints"]);
  let result = 0;
  for (const skill of after.skills ?? []) {
    const name = String(skill.name).toLowerCase(), old = before.skills?.find((x) => String(x.name).toLowerCase() === name);
    if (!old || Number(old.baseLevel ?? old.level) >= 99)
      continue;
    if (role !== "economy" && ["defence", "prayer"].includes(name))
      continue;
    if (role !== "economy" && !ranged && name === "attack" && Number(old.baseLevel ?? old.level) >= 40)
      continue;
    const gain = Math.max(0, Number(skill.experience ?? 0) - Number(old.experience ?? 0));
    result += gain * (role === "economy" ? 0.001 : combat.has(name) ? 0.01 : 0.001);
  }
  return result;
}
function outcomeReward(before, after, action, role, ranged, catalog) {
  let value = usefulXp(before, after, role, ranged);
  const quality = (s, family) => Math.max(0, ...catalog.items.filter((g) => g.family === family && usable(g, s) && (g.tool ? [...s.inventory ?? [], ...s.equipment ?? []] : s.equipment ?? []).some((i) => i.id === g.id)).map((g) => g.quality));
  for (const family of role === "economy" ? ["axe", "pickaxe"] : ranged ? ["bow", "legs", "hands"] : ["melee"])
    value += (quality(after, family) - quality(before, family)) * 2;
  const cash = (s) => (s.inventory ?? []).filter((i) => i.id === 995).reduce((n, i) => n + Number(i.count), 0);
  const item = before.inventory?.find((i) => i.slot === action.fields?.slot);
  const qty = (s) => item ? (s.inventory ?? []).filter((i) => i.id === item.id).reduce((n, i) => n + i.count, 0) : 0;
  if (action.type === "shopSell" && qty(after) < qty(before) && cash(after) > cash(before))
    value += (cash(after) - cash(before)) * (role === "economy" ? 0.1 : 0.01);
  if (action.type === "shopBuy" && cash(after) < cash(before))
    value += (cash(after) - cash(before)) * (role === "economy" ? 0.1 : 0.001);
  if (after.player?.isDead && !before.player?.isDead || after.player?.lifeId !== before.player?.lifeId || Number(after.player?.respawnCount ?? 0) > Number(before.player?.respawnCount ?? 0))
    value -= 100;
  if (action.type === "wait")
    value -= 0.05;
  return Number(value.toFixed(4));
}

// src/autonomy.ts
var inventorySignature = (state) => [...state.inventory ?? [], ...state.equipment ?? []].map((item) => `${item.id}:${item.count ?? 1}`).sort().join("|");
var skillSignature = (state) => (state.skills ?? []).map((skill) => `${skill.name}:${skill.level ?? skill.baseLevel}:${skill.experience ?? 0}`).sort().join("|");
var positionSignature = (state) => {
  const player = state.player ?? {};
  return `${player.worldX}:${player.worldZ}:${player.level}:${player.lifeId}`;
};
var passive = (action) => action.type === "wait";
function preferActive(options) {
  const active = options.filter((option) => !passive(option));
  return active.length ? active : options;
}
function intentFor(action) {
  if (action.id.startsWith("training-"))
    return "measure-training-site";
  if (action.id.startsWith("goal-"))
    return "acquire-or-fund-upgrade";
  if (action.id.startsWith("economy-"))
    return "sustain-production-profit";
  if (/ammo|arrow|knife|fletch/i.test(action.id))
    return "restore-ranged-supplies";
  if (/fish|cook|food|heal/i.test(action.id))
    return "restore-survival-supplies";
  if (/explore|scan/i.test(action.id))
    return "discover-a-verified-next-step";
  return "make-build-progress";
}
function madeProgress(before, after, action) {
  if (action.type === "wait" || action.type === "scanNearbyLocs")
    return false;
  if (action.type === "interactLoc" && /^(economy-|gather-safe|chop-)/.test(action.id)) {
    return inventorySignature(before) !== inventorySignature(after) || skillSignature(before) !== skillSignature(after);
  }
  if (positionSignature(before) !== positionSignature(after))
    return true;
  if (inventorySignature(before) !== inventorySignature(after))
    return true;
  if (skillSignature(before) !== skillSignature(after))
    return true;
  return Boolean(before.player?.combat?.inCombat) !== Boolean(after.player?.combat?.inCombat) || before.player?.hp !== after.player?.hp;
}
function recordAutonomy(memory, before, after, action, now = Date.now(), transient = false) {
  const intent = intentFor(action);
  const progressed = transient || madeProgress(before, after, action);
  memory.active = memory.active?.intent === intent ? { ...memory.active, action: action.id, lastProgress: progressed ? now : memory.active.lastProgress } : { intent, action: action.id, since: now, lastProgress: progressed ? now : 0, reason: action.id };
  memory.stalled ??= {};
  const prior = memory.stalled[action.id];
  const count = progressed ? 0 : (prior?.count ?? 0) + 1;
  memory.stalled[action.id] = { count, lastAt: now };
  return { stalled: count >= 2, intent };
}

// src/banking-policy.ts
function shouldDepositAtBank(name, inventoryFull, edible) {
  if (!edible)
    return true;
  return inventoryFull;
}
function shouldCloseAfterFoodWithdrawal(foodWithdrawalPending, hasFood) {
  return foodWithdrawalPending && hasFood;
}

// src/action-priority.ts
function preferRangedSupply(ranged, supplies, fallback) {
  return ranged && supplies.length > 0 ? supplies : fallback;
}

// src/agent.ts
var root = resolve5(import.meta.dir, "..");
var clawscapeHome = process.env.CLAWSCAPE_HOME ?? resolve5(root, "data", "online-home");
var arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
var character = arg("character", "demo");
var steps = Number(arg("steps", "40"));
var alpha = Number(arg("alpha", "0.25"));
var gamma = Number(arg("gamma", "0.90"));
var epsilon = Number(arg("epsilon", "0.15"));
var profile = arg("profile", "default").replace(/[^a-z0-9_-]/gi, "");
var role = arg("role", "brawler").replace(/[^a-z0-9_-]/gi, "");
var build = arg("build", "melee").replace(/[^a-z0-9_-]/gi, "");
var forever = process.argv.includes("--forever");
var forumEnabled = process.argv.includes("--forum");
var githubLearnings = process.argv.includes("--github-learnings");
var intervalMs = Number(arg("interval-ms", "5000"));
var BUILD = { attackCap: 40, defenceCap: 1, prayerCap: 1, strengthCheck: 40, foodTripMinimum: 3, foodTripTarget: 8, bankFoodReserve: 100 };
var WORLD_ROUTES = {
  lumbridge: { x: 3232, z: 3230 },
  lumbridgeKnife: { x: 3224, z: 3202 },
  lumbridgeTrees: { x: 3238, z: 3272 },
  varrockWestBank: { x: 3185, z: 3436 },
  varrockSouthEastMine: { x: 3285, z: 3365 },
  draynorFishing: { x: 3094, z: 3226 },
  lumbridgeCastle: { x: 3222, z: 3218 },
  wizardsTower: { x: 3105, z: 3162 },
  auburysRuneShop: { x: 3253, z: 3402 },
  lowesArchery: { x: 3233, z: 3425 },
  gerrantsFishingShop: { x: 3014, z: 3224 },
  draynorCooking: { x: 3100, z: 3257 },
  lumbridgeSwamp: { x: 3195, z: 3183 },
  barbarianVillage: { x: 3063, z: 3416 },
  edgeville: { x: 3098, z: 3488 }
};
var dataDir = profile === "" || profile === "default" ? resolve5(root, "data") : resolve5(root, "data", profile);
var qPath = resolve5(dataDir, "q-table-outcomes-v2.json");
var experiencePath = resolve5(dataDir, "experience.jsonl");
var observationsPath = resolve5(dataDir, "world-observations.jsonl");
var forumInboxPath = resolve5(dataDir, "forum-inbox.jsonl");
var forumStatePath = resolve5(dataDir, "forum-state.json");
var githubLearningPath = resolve5(dataDir, "github-learnings.jsonl");
var githubLearningStatePath = resolve5(dataDir, "github-learning-state.json");
mkdirSync2(dataDir, { recursive: true });
var loadQ = () => {
  if (!existsSync5(qPath))
    return {};
  try {
    return JSON.parse(readFileSync8(qPath, "utf8"));
  } catch {
    return {};
  }
};
var q = loadQ();
var navigator;
var training;
var travelAction = null;
var peerMarket;
var marketRetryAt = 0;
var workPath = resolve5(dataDir, "work-state.json");
var work = (() => {
  try {
    return { failures: {}, ...JSON.parse(readFileSync8(workPath, "utf8")) };
  } catch {
    return { failures: {} };
  }
})();
var saveWork = () => saveGoalJson(workPath, work);
var gearCatalog = loadGearCatalog();
var equipmentGoals = new EquipmentGoals(resolve5(dataDir, "equipment-goals.json"), gearCatalog, role, build === "ranged-magic");
equipmentGoals.seedBank(work.economy?.bankItems ?? work.bankItems ?? []);
function available(options) {
  const ready = options.filter((o) => (work.failures[o.id]?.until ?? 0) < Date.now());
  if (ready.length)
    return ready;
  return options.filter((o) => o.id === "autonomy-scan-current-area" || o.id === "autonomy-map-loading");
}
function noteFailure(action) {
  const count = (work.failures[action.id]?.count ?? 0) + 1;
  work.failures[action.id] = { count, until: Date.now() + Math.min(300000, 30000 * count) };
  if (role === "economy" && work.economy?.objectives?.intent && action.id.startsWith("economy-") && count >= 2)
    work.economy.objectives.blocked[work.economy.objectives.intent.id] = Date.now() + 300000;
  if (action.id.startsWith("economy-bow-") && work.economy && count >= 2)
    bowBlocked(work.economy, "Repeated action or route failure: " + action.id);
  if (typeof action.fields?.trainingSite === "string")
    training?.block(action.fields.trainingSite, "action-or-route-failed");
  saveWork();
}
function loadForumState() {
  if (!existsSync5(forumStatePath))
    return { sent: {}, replies: {} };
  try {
    return JSON.parse(readFileSync8(forumStatePath, "utf8"));
  } catch {
    return { sent: {}, replies: {} };
  }
}
function saveForumState(value) {
  writeFileSync5(forumStatePath, JSON.stringify(value, null, 2) + `
`);
}
function loadGitHubLearningState() {
  if (!existsSync5(githubLearningStatePath))
    return { queued: {}, published: {} };
  try {
    return JSON.parse(readFileSync8(githubLearningStatePath, "utf8"));
  } catch {
    return { queued: {}, published: {} };
  }
}
async function cliCall(args) {
  const result = await callSkill(character, args, clawscapeHome);
  if (result.error || result.success === false)
    throw new Error(`CLI rejected ${args[1] ?? args[0]}: ${result.reason ?? ""} ${result.message ?? result.error ?? ""}`);
  return result;
}
function stateFrom(value) {
  const state = value.state;
  const full = state && typeof state === "object" ? state : value;
  if (!full.player || !Array.isArray(full.inventory) || !Array.isArray(full.skills)) {
    throw new Error("Full connected state required; refusing summary or delta");
  }
  return full;
}
function text(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}
function level(state, name) {
  const skill = (state.skills ?? []).find((item) => text(item.name) === name);
  return typeof skill?.level === "number" ? skill.level : 1;
}
function progression(state) {
  return { objective: mission(role), autonomy: work.autonomy?.active, ...progressionDetails(state), ...role === "economy" ? { productionDecision: work.economy?.objectives?.decision } : {} };
}
function progressionDetails(state) {
  const equipment = equipmentGoals.plan(state);
  let runeMysteries = { complete: false, status: "not yet checked by the quest runner" };
  try {
    const saved = JSON.parse(readFileSync8(resolve5(dataDir, "rune-mysteries.json"), "utf8"));
    runeMysteries = { complete: saved.completed === true, stage: saved.stage, checkedAt: saved.journalAt, blocker: saved.blocked };
  } catch {}
  const equipmentBrief = { target: equipment.target, phase: equipment.goal?.phase, reason: equipment.goal?.reason, status: equipment.status };
  if (equipment.target)
    return { stage: "equipment-progression", goal: equipment.target, equipment: equipmentBrief, runeMysteries };
  if (equipment.capital && !equipment.capital.complete)
    return {
      stage: equipment.capital.targetCoins === null ? "realize-production-profit" : "fund-upgrades",
      goal: equipment.capital.targetCoins === null ? "Sell unreserved production surplus" : "Build liquid upgrade reserve",
      coins: equipment.capital.observedCoins,
      targetCoins: equipment.capital.targetCoins,
      reason: equipment.capital.reason,
      equipment: equipmentBrief,
      runeMysteries
    };
  if (role === "economy")
    return { stage: "banked-production", goal: work.economy?.goal ?? "recover tools, process stored logs, gather near a bank", reason: work.economy?.reason, selectedSite: work.economy?.selectedSite, woodcutting: level(state, "woodcutting"), fletching: level(state, "fletching"), runeMysteries, equipment: equipmentBrief };
  if (build === "ranged-magic")
    return { stage: "ranged-magic-foundation", goal: runeMysteries.complete ? "Maintain ranged supplies; essence access unlocked, rune production is the next implementation milestone" : "Maintain ranged supplies; complete Rune Mysteries with the single-owner quest runner", runeMysteries, style: "train with the bow while the magic supply route is unavailable", gear: "best useful acquired bow and compatible arrows", equipment: equipmentBrief };
  const attack = level(state, "attack");
  const strength = level(state, "strength");
  const foodCount = (state.inventory ?? []).reduce((sum, item) => /^(shrimp|anchovies|trout|salmon|sardines|herring|tuna|lobster|swordfish|bread|pizza)/i.test(String(item.name)) ? sum + (typeof item.count === "number" ? item.count : 1) : sum, 0);
  if (foodCount < BUILD.foodTripTarget)
    return { stage: "food-supply", goal: "Build cooked-food reserve", style: "fishing/cooking", gear: "keep current combat gear; resupply before risking it" };
  if (strength < BUILD.strengthCheck) {
    return { stage: "strength-foundation", goal: "Strength 40", style: "strength", gear: "best available one-handed weapon + shield" };
  }
  if (attack < BUILD.attackCap) {
    return { stage: "rune-gate", goal: "Attack 40", style: "attack", gear: "upgrade weapon whenever an exposed shop/drop permits it" };
  }
  return { stage: "combat-growth", goal: "Improve melee capability through useful levels, gear and sustainable encounter choices", style: "strength within the agreed build", gear: "best worthwhile supported upgrade; capped XP alone is not progress" };
}
function forumAnswerEvidence(state, request) {
  const observed = [
    ...(state.inventory ?? []).map((item) => String(item.name)),
    ...(state.equipment ?? []).map((item) => String(item.name)),
    ...(state.nearbyLocs ?? []).filter((loc) => loc.reachable === true).map((loc) => String(loc.name))
  ].filter(Boolean);
  const requestWords = text(request);
  const relevant = requestWords.includes("arrow") || requestWords.includes("bow") || requestWords.includes("staff") || requestWords.includes("rune") || requestWords.includes("ranged") || requestWords.includes("magic") ? observed.filter((name) => /arrow|bow|staff|rune/i.test(name)) : requestWords.includes("food") || requestWords.includes("fishing") || requestWords.includes("combat") || requestWords.includes("gear") || requestWords.includes("party") || requestWords.includes("meet") || requestWords.includes("fight") ? observed.filter((name) => /shrimp|fish|food|sword|scimitar|shield|bow|staff|goblin|rat|skeleton/i.test(name)) : observed.filter((name) => /tree|ore|mine|bank|range|stove|fire|fishing|shop/i.test(name));
  if (relevant.length === 0)
    return null;
  const player = state.player ?? {};
  return "I can confirm " + [...new Set(relevant)].slice(0, 4).join(", ") + " around " + String(player.worldX ?? "unknown") + ", " + String(player.worldZ ?? "unknown") + ".";
}
function socialVoice() {
  if (character === "clawscout")
    return { opener: "Good shout", plan: "I'm building a hard-hitting melee setup, but I won't throw a trip away without food." };
  if (character === "stinger")
    return { opener: "That sounds worth checking", plan: "I'm trying the bow first and keeping an eye out for a proper magic route." };
  return { opener: "Useful lead", plan: "I'm gathering supplies now, so I can bring food or materials once I have a decent batch." };
}
async function syncForum(state) {
  if (!forumEnabled)
    return;
  const saved = loadForumState();
  saved.sent ??= {};
  const listed = await cliCall(["forum", "list"]);
  const topics = Array.isArray(listed.topics) ? listed.topics : [];
  appendFileSync(forumInboxPath, JSON.stringify({ time: new Date().toISOString(), topics: topics.map((topic) => ({ id: topic.id, title: topic.title, character: topic.character, replies: topic.replies })) }) + `
`);
  for (const topic of topics) {
    const topicId = typeof topic.id === "string" ? topic.id : "";
    const author = text(topic.character);
    const replyCount = typeof topic.replies === "number" ? topic.replies : 0;
    if (!topicId || author === character || replyCount > 12 || saved.replies?.[topicId])
      continue;
    const read = await cliCall(["forum", "read", topicId]);
    const posts = Array.isArray(read.posts) ? read.posts : [];
    const conversation = posts.map((post) => String(post.body ?? "")).join(`
`);
    if (!/party|group|meet|trade|stuck|help|where|need|looking|bank|fish|food|gear|arrow|bow|staff|rune|combat/i.test(conversation))
      continue;
    const evidence = forumAnswerEvidence(state, conversation);
    if (!evidence)
      continue;
    const replyPath = resolve5(dataDir, "forum-reply.txt");
    const voice = socialVoice();
    writeFileSync5(replyPath, voice.opener + ", " + author + ". " + evidence + " " + voice.plan + `
`);
    await cliCall(["forum", "reply", topicId, "--body-file", replyPath]);
    saved.replies ??= {};
    saved.replies[topicId] = new Date().toISOString();
    saveForumState(saved);
    console.log(JSON.stringify({ forum: "joined-conversation", topicId, to: author }));
    break;
  }
}
async function discussForumProblem(message) {
  if (!forumEnabled || !/another action is in progress|can't reach|failed to/i.test(message))
    return;
  const saved = loadForumState();
  saved.sent ??= {};
  const key = "problem:" + message.toLowerCase().replace(/\d+/g, "#").slice(0, 120);
  if (saved.sent[key])
    return;
  const plain = message.replace(/[\r\n]+/g, " ").slice(0, 180);
  const bodyPath = resolve5(dataDir, "forum-problem.txt");
  writeFileSync5(bodyPath, "I've hit a snag while working on my current plan: " + plain + `. Has anyone found a reliable way around this?
`);
  try {
    await cliCall(["forum", "post", "--title", character + ": looking for advice on a stuck action", "--body-file", bodyPath]);
    saved.sent[key] = new Date().toISOString();
    saveForumState(saved);
    console.log(JSON.stringify({ forum: "asked-for-help", problem: plain }));
  } catch (error) {
    console.log(JSON.stringify({ forum: "problem-post-deferred", error: error instanceof Error ? error.message : String(error) }));
  }
}
function githubLearning(state) {
  const inventory = state.inventory ?? [];
  if (build === "ranged-magic") {
    const arrows = [...inventory, ...state.equipment ?? []].filter((item) => /arrow/i.test(text(item.name))).reduce((sum, item) => sum + (typeof item.count === "number" ? item.count : 1), 0);
    if (arrows === 0)
      return "Ranged ammo is an inventory/equipment edge case: arrows must be explicitly Wielded into the quiver after the bow. Otherwise combat reports no ammo even when arrows are in inventory. A SKILL example should show bow + arrow equipping and an ammo-reserve check.";
  }
  if (role === "economy" && inventory.length >= 28 && state.bank?.isOpen !== true) {
    return "Banking is hard to automate from state alone: bankDeposit/bankWithdraw work only after a bank UI is open, while closed state.bank provides no nearest bank, banker, or route. A service-locator or nearest-bank field would avoid blind world exploration when an inventory fills.";
  }
  return null;
}
async function maybePublishGitHubLearning(state) {
  if (!githubLearnings)
    return;
  const learning = githubLearning(state);
  if (!learning)
    return;
  const key = learning.toLowerCase();
  const saved = loadGitHubLearningState();
  saved.queued ??= {};
  saved.published ??= {};
  const last = saved.lastPublishedAt ? Date.parse(saved.lastPublishedAt) : 0;
  if (saved.published[key] || Date.now() - last < 45 * 60 * 1000)
    return;
  const token = Bun.env.GITHUB_TOKEN;
  if (!token) {
    if (!saved.queued[key])
      appendFileSync(githubLearningPath, JSON.stringify({ time: new Date().toISOString(), character, learning }) + `
`);
    saved.queued[key] = new Date().toISOString();
    writeFileSync5(githubLearningStatePath, JSON.stringify(saved, null, 2) + `
`);
    console.log(JSON.stringify({ github: "learning-queued", reason: "GITHUB_TOKEN is not configured" }));
    return;
  }
  const response = await fetch("https://api.github.com/repos/Joostrothweiler/clawscape/issues/69/comments", {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ body: "### " + character + ` \u2014 verified field note

` + learning })
  });
  if (!response.ok)
    throw new Error("GitHub issue comment failed: " + response.status);
  saved.published[key] = new Date().toISOString();
  saved.lastPublishedAt = new Date().toISOString();
  writeFileSync5(githubLearningStatePath, JSON.stringify(saved, null, 2) + `
`);
  console.log(JSON.stringify({ github: "learning-published", character }));
}
function economyCandidates(state) {
  if (role !== "economy")
    return [];
  if ((state.inventory?.length ?? 0) >= 28)
    return [];
  const result = [];
  for (const loc of state.nearbyLocs ?? []) {
    const name = text(loc.name);
    if (harvestLevel(name) > level(state, "woodcutting"))
      continue;
    if (!(state.inventory ?? []).concat(state.equipment ?? []).some((i) => /axe/i.test(text(i.name)) && !/pickaxe/i.test(text(i.name))))
      continue;
    const options = Array.isArray(loc.optionsWithIndex) ? loc.optionsWithIndex : [];
    const action = options.find((option) => /chop|mine|fish|thieve|steal/i.test(text(option.text)));
    if (loc.reachable === true && action && typeof loc.x === "number" && typeof loc.z === "number" && typeof loc.id === "number" && typeof action.opIndex === "number") {
      result.push({ id: "economy-" + name + "-" + loc.id + "-" + loc.x + "-" + loc.z, type: "interactLoc", fields: { x: loc.x, z: loc.z, locId: loc.id, optionIndex: action.opIndex }, waitTicks: 5 });
    }
  }
  return result.sort((a, b) => Number((state.nearbyLocs ?? []).find((l) => l.id === a.fields?.locId && l.x === a.fields?.x)?.distance ?? 99) - Number((state.nearbyLocs ?? []).find((l) => l.id === b.fields?.locId && l.x === b.fields?.x)?.distance ?? 99));
}
var arrowRank = (name) => {
  if (/rune arrow/i.test(name))
    return 6;
  if (/adamant arrow/i.test(name))
    return 5;
  if (/mithril arrow/i.test(name))
    return 4;
  if (/steel arrow/i.test(name))
    return 3;
  if (/iron arrow/i.test(name))
    return 2;
  if (/bronze arrow/i.test(name))
    return 1;
  return 0;
};
function permittedArrowRank(ranged) {
  if (ranged >= 40)
    return 6;
  if (ranged >= 30)
    return 5;
  if (ranged >= 20)
    return 4;
  if (ranged >= 5)
    return 3;
  return 2;
}
function safeAmmoSupplyCandidates(state) {
  if (build !== "ranged-magic")
    return [];
  const inventory = state.inventory ?? [];
  const hasAxe = inventory.concat(state.equipment ?? []).some((i) => /axe/i.test(String(i.name)) && !/pickaxe/i.test(String(i.name)));
  if (!hasAxe) {
    const nearTown = Math.hypot(Number(state.player?.worldX) - WORLD_ROUTES.lumbridge.x, Number(state.player?.worldZ) - WORLD_ROUTES.lumbridge.z) < 10;
    return nearTown ? [{ id: "look-for-income-opportunity", type: "wait", waitTicks: 5 }] : [{ id: "travel-for-income-opportunity", type: "walkTo", fields: { ...WORLD_ROUTES.lumbridge, reason: "find income opportunities; cannot chop without an axe" }, waitTicks: 2 }];
  }
  const shop = state.shop ?? {};
  if (shop.isOpen === true) {
    const sale = inventory.find((item) => /logs?|shortbow|longbow|arrow shafts/i.test(text(item.name)) && typeof item.slot === "number");
    if (sale)
      return [{ id: "sell-safe-ammo-material-" + sale.slot, type: "shopSell", fields: { slot: sale.slot, amount: 10, reason: "safe ammunition fund" }, waitTicks: 2 }];
  }
  const log = inventory.find((item) => /logs?/i.test(text(item.name)) && typeof item.slot === "number");
  const fletch = log?.optionsWithIndex?.find((option) => /fletch/i.test(text(option.text)));
  if (log && typeof fletch?.opIndex === "number") {
    return [{ id: "fletch-ammo-material-" + log.slot, type: "useInventoryItem", fields: { slot: log.slot, optionIndex: fletch.opIndex, reason: "learn self-supplied ammunition inputs" }, waitTicks: 3 }];
  }
  const knife = inventory.find((item) => /^knife$/i.test(text(item.name)) && typeof item.slot === "number");
  if (log && knife) {
    return [{ id: "knife-on-ammo-log-" + log.slot, type: "useItemOnItem", fields: { sourceSlot: knife.slot, targetSlot: log.slot, reason: "make arrow-shaft inputs from observed logs" }, waitTicks: 3 }];
  }
  if (log) {
    const groundKnife = (state.groundItems ?? []).find((item) => /^knife$/i.test(text(item.name)) && item.reachable === true && typeof item.x === "number" && typeof item.z === "number" && typeof item.id === "number");
    if (groundKnife)
      return [{ id: "pickup-ammo-knife", type: "pickupItem", fields: { x: groundKnife.x, z: groundKnife.z, itemId: groundKnife.id, reason: "recover the tool required to turn logs into arrow inputs" }, waitTicks: 2 }];
    const distanceToKnife = Math.hypot(Number(state.player?.worldX) - WORLD_ROUTES.lumbridgeKnife.x, Number(state.player?.worldZ) - WORLD_ROUTES.lumbridgeKnife.z);
    if (distanceToKnife > 6)
      return [{ id: "travel-for-ammo-knife", type: "walkTo", fields: { ...WORLD_ROUTES.lumbridgeKnife, reason: "recover a verified knife before processing gathered ammunition materials" }, waitTicks: 2 }];
    return [{ id: "scan-for-ammo-knife", type: "scanNearbyLocs", fields: { radius: 12, reason: "find the verified ground knife at the observed source" }, waitTicks: 2 }];
  }
  const tree = (state.nearbyLocs ?? []).find((loc) => loc.reachable === true && /tree/i.test(text(loc.name)) && typeof loc.x === "number" && typeof loc.z === "number" && typeof loc.id === "number");
  const chop = tree?.optionsWithIndex?.find((option) => /chop/i.test(text(option.text)));
  if (tree && typeof chop?.opIndex === "number") {
    return [{ id: "gather-safe-ammo-material-" + tree.id + "-" + tree.x + "-" + tree.z, type: "interactLoc", fields: { x: tree.x, z: tree.z, locId: tree.id, optionIndex: chop.opIndex, reason: "safe ammunition supply" }, waitTicks: 5 }];
  }
  const distance = Math.hypot(Number(state.player?.worldX) - WORLD_ROUTES.lumbridgeTrees.x, Number(state.player?.worldZ) - WORLD_ROUTES.lumbridgeTrees.z);
  if (distance > 8)
    return [{ id: "travel-to-safe-ammo-trees", type: "walkTo", fields: { ...WORLD_ROUTES.lumbridgeTrees, reason: "reach an observed safe tree approach before gathering arrow materials" }, waitTicks: 2 }];
  return [{ id: "scan-safe-ammo-supply", type: "scanNearbyLocs", fields: { radius: 12, reason: "refresh the local tree observation at the verified approach" }, waitTicks: 2 }];
}
function cautiousPickpocketCandidates(state) {
  if (build !== "ranged-magic")
    return [];
  const player = state.player ?? {};
  const hp = typeof player.hp === "number" ? player.hp : 0;
  const maxHp = typeof player.maxHp === "number" ? player.maxHp : 1;
  const food = (state.inventory ?? []).some((item) => item.optionsWithIndex?.some((option) => text(option.text) === "eat"));
  if (!food || hp * 100 / Math.max(1, maxHp) < 70)
    return [];
  const mark = (state.nearbyNpcs ?? []).find((npc) => npc.reachable === true && typeof npc.index === "number" && npc.optionsWithIndex?.some((option) => /pickpocket/i.test(text(option.text))));
  const option = mark?.optionsWithIndex?.find((item) => /pickpocket/i.test(text(item.text)));
  if (mark && typeof option?.opIndex === "number")
    return [{ id: "cautious-pickpocket-" + mark.index, type: "interactNpc", fields: { npcIndex: mark.index, optionIndex: option.opIndex, reason: "earn arrow funds only while health is protected" }, waitTicks: 4 }];
  return [];
}
function ammoCandidates(state) {
  if (build !== "ranged-magic")
    return [];
  const inventory = state.inventory ?? [];
  const maxArrowRank = Math.min(permittedArrowRank(level(state, "ranged")), bowArrowCap(String(state.combatStyle?.weaponName ?? "")));
  const arrows = [...inventory, ...state.equipment ?? []].filter((item) => arrowRank(String(item.name)) > 0 && arrowRank(String(item.name)) <= maxArrowRank).reduce((total, item) => total + (typeof item.count === "number" ? item.count : 1), 0);
  if (arrows >= 15)
    return [];
  const ranged = level(state, "ranged");
  const coins = (state.inventory ?? []).filter((item) => /coins/i.test(text(item.name))).reduce((total, item) => total + (typeof item.count === "number" ? item.count : 1), 0);
  const minimumPurchaseBudget = Math.max(0, (15 - arrows) * 10);
  const shop = state.shop ?? {};
  const stock = Array.isArray(shop.shopItems) ? shop.shopItems : [];
  if (shop.isOpen === true) {
    const choice = stock.filter((item) => arrowRank(String(item.name)) > 0 && arrowRank(String(item.name)) <= maxArrowRank && typeof item.slot === "number" && Number(item.count) > 0).filter((item) => typeof item.buyPrice !== "number" || Number(item.buyPrice) <= coins).sort((a, b) => arrowRank(String(b.name)) - arrowRank(String(a.name)))[0];
    const unitPrice = typeof choice?.buyPrice === "number" ? Math.max(1, choice.buyPrice) : 1;
    const affordable = Math.min(50 - arrows, Math.floor(coins / unitPrice));
    if (choice && affordable > 0 && typeof choice.slot === "number")
      return [{ id: "buy-arrows-" + choice.slot, type: "shopBuy", fields: { slot: choice.slot, amount: affordable, reason: "maintain ranged ammunition reserve" }, waitTicks: 2 }];
    return [];
  }
  if (coins < minimumPurchaseBudget) {
    const player = state.player ?? {};
    const hp = typeof player.hp === "number" ? player.hp : 0;
    const maxHp = typeof player.maxHp === "number" ? player.maxHp : 1;
    if (coins > 0 && hp * 100 / Math.max(1, maxHp) <= 55)
      return [];
    const safeSupply = safeAmmoSupplyCandidates(state);
    const pickpocket = cautiousPickpocketCandidates(state);
    if (mayPickpocketForAmmo(inventory.length, work.pickpocketStreak ?? 0) && pickpocket.length > 0)
      return pickpocket;
    return safeSupply;
  }
  const lowe = (state.nearbyNpcs ?? []).find((npc) => npc.reachable === true && /lowe/i.test(text(npc.name)) && typeof npc.index === "number");
  if (lowe)
    return [{ id: "talk-to-lowe-" + lowe.index, type: "talkToNpc", fields: { npcIndex: lowe.index, reason: "buy ranged ammunition" }, waitTicks: 3 }];
  const player = state.player ?? {};
  const distance = Math.hypot((Number(player.worldX) || 0) - WORLD_ROUTES.lowesArchery.x, (Number(player.worldZ) || 0) - WORLD_ROUTES.lowesArchery.z);
  if (distance > 8)
    return [{ id: "walk-to-lowes-archery", type: "walkTo", fields: { ...WORLD_ROUTES.lowesArchery, running: true, reason: "restock ranged ammunition" }, waitTicks: 5 }];
  return [{ id: "scan-for-lowes-archery", type: "scanNearbyLocs", fields: { radius: 30, reason: "locate Lowe's Archery Emporium" }, waitTicks: 2 }];
}
function isBankableResource(name) {
  return /raw |shrimp|anchov|sardine|herring|trout|salmon|tuna|lobster|swordfish|logs?|ore|bar|rune essence|flax|wool|leather|hide|feather|herb|seed|gem|clay|bone/i.test(name) && !/axe|pickaxe|sword|scimitar|dagger|mace|shield|bow|staff|arrow|coin/i.test(name);
}
function coinsIn(inventory) {
  return inventory.filter((item) => /coins/i.test(text(item.name))).reduce((total, item) => total + (typeof item.count === "number" ? item.count : 1), 0);
}
function workingCashReserve(state) {
  const player = state.player ?? {};
  const hp = typeof player.hp === "number" ? player.hp : 0;
  const maxHp = typeof player.maxHp === "number" ? player.maxHp : 1;
  if (hp * 100 / Math.max(1, maxHp) <= 55)
    return 50;
  if (role === "economy")
    return 0;
  return build === "ranged-magic" ? 500 : 250;
}
function bankingCandidates(state) {
  const inventory = state.inventory ?? [];
  const bankableItems = inventory.filter((item) => isBankableResource(String(item.name)) && shouldDepositAtBank(String(item.name), inventory.length >= 28, isFood(item)));
  const coins = coinsIn(inventory);
  const surplusCoins = Math.max(0, coins - workingCashReserve(state));
  const inventoryFull = inventory.length >= 28;
  const recoveryCash = role !== "economy" && !inventory.some(isFood) && !inventory.some((i) => /small fishing net/i.test(String(i.name))) && coins < 5;
  const bank = state.bank ?? {};
  if (bank.isOpen === true) {
    work.bankItems = Array.isArray(bank.items) ? bank.items : [];
    saveWork();
    if (shouldCloseAfterFoodWithdrawal(work.foodWithdrawalPending === true, inventory.some(isFood))) {
      return [{ id: "close-bank-with-food-trip", type: "closeModal", fields: { reason: "keep deliberately withdrawn food for the next trip" }, waitTicks: 1 }];
    }
    const resource = bankableItems.find((item) => typeof item.slot === "number");
    if (resource)
      return [{ id: "bank-deposit-" + resource.slot, type: "bankDeposit", fields: { slot: resource.slot, amount: -1, reason: "store gathered materials for batch processing" }, waitTicks: 2 }];
    const coinStack = inventory.find((item) => /coins/i.test(text(item.name)) && typeof item.slot === "number");
    if (coinStack && surplusCoins > 0)
      return [{ id: "bank-surplus-coins-" + coinStack.slot, type: "bankDeposit", fields: { slot: coinStack.slot, amount: surplusCoins, reason: "protect surplus coins while retaining operating funds" }, waitTicks: 2 }];
    const food = work.bankItems.find((i) => /^(shrimps|anchovies|trout|salmon|bread|lobster|swordfish)$/i.test(String(i.name)));
    if (!inventory.some(isFood) && food && inventory.length < 28) {
      work.foodWithdrawalPending = true;
      saveWork();
      return [{ id: "withdraw-recovery-food", type: "bankWithdraw", fields: { slot: food.slot, amount: Math.min(BUILD.foodTripTarget, 28 - inventory.length, Number(food.count)) }, waitTicks: 2 }];
    }
    const net = work.bankItems.find((i) => /small fishing net/i.test(String(i.name)));
    if (role !== "economy" && !inventory.some(isFood) && !inventory.some((i) => /small fishing net/i.test(String(i.name))) && net)
      return [{ id: "withdraw-food-tool", type: "bankWithdraw", fields: { slot: net.slot, amount: 1 }, waitTicks: 2 }];
    const bankCoins = work.bankItems.find((i) => /^coins$/i.test(String(i.name)));
    if (role !== "economy" && !inventory.some(isFood) && coins < 5 && bankCoins)
      return [{ id: "withdraw-recovery-cash", type: "bankWithdraw", fields: { slot: bankCoins.slot, amount: Math.min(50, Number(bankCoins.count)) }, waitTicks: 2 }];
    return [{ id: "close-bank-after-deposit", type: "closeModal", fields: { reason: "resume work after banking" }, waitTicks: 1 }];
  }
  if ((!inventoryFull || bankableItems.length === 0) && surplusCoins === 0 && !recoveryCash)
    return [];
  const banker = (state.nearbyNpcs ?? []).find((npc) => npc.reachable === true && /banker/i.test(text(npc.name)) && typeof npc.index === "number");
  if (banker) {
    const option = banker.optionsWithIndex?.find((item) => /bank|use/i.test(text(item.text)));
    if (typeof option?.opIndex === "number")
      return [{ id: "open-bank-npc-" + banker.index, type: "interactNpc", fields: { npcIndex: banker.index, optionIndex: option.opIndex, reason: "bank gathered materials" }, waitTicks: 3 }];
  }
  const booth = (state.nearbyLocs ?? []).find((loc) => loc.reachable === true && /bank booth|bank chest|bank table/i.test(text(loc.name)) && typeof loc.x === "number" && typeof loc.z === "number" && typeof loc.id === "number");
  if (booth) {
    const option = bankOption(booth.optionsWithIndex ?? []);
    if (typeof option?.opIndex === "number")
      return [{ id: "open-bank-loc-" + booth.id + "-" + booth.x + "-" + booth.z, type: "interactLoc", fields: { x: booth.x, z: booth.z, locId: booth.id, optionIndex: option.opIndex, reason: "bank gathered materials" }, waitTicks: 3 }];
  }
  const bankVisible = (state.nearbyNpcs ?? []).some((npc) => /banker/i.test(text(npc.name)));
  const entryDoor = bankVisible ? (state.nearbyLocs ?? []).find((loc) => {
    const open = loc.optionsWithIndex?.find((option) => /^open$/i.test(text(option.text)));
    return loc.reachable === true && /door|gate/i.test(text(loc.name)) && typeof loc.x === "number" && typeof loc.z === "number" && typeof loc.id === "number" && typeof open?.opIndex === "number";
  }) : undefined;
  if (entryDoor) {
    const open = entryDoor.optionsWithIndex.find((option) => /^open$/i.test(text(option.text)));
    return [{ id: `open-bank-entry-${entryDoor.id}-${entryDoor.x}-${entryDoor.z}`, type: "interactLoc", fields: { x: entryDoor.x, z: entryDoor.z, locId: entryDoor.id, optionIndex: open.opIndex, reason: "reach a visible local bank service" }, waitTicks: 2 }];
  }
  const player = state.player ?? {};
  const distance = Math.hypot((Number(player.worldX) || 0) - WORLD_ROUTES.varrockWestBank.x, (Number(player.worldZ) || 0) - WORLD_ROUTES.varrockWestBank.z);
  if (distance > 8)
    return [{ id: "walk-to-varrock-west-bank", type: "walkTo", fields: { ...WORLD_ROUTES.varrockWestBank, running: true, reason: "bank materials or surplus coins" }, waitTicks: 5 }];
  return [{ id: "scan-for-bank", type: "scanNearbyLocs", fields: { radius: 40, reason: "find bank before depositing" }, waitTicks: 2 }];
}
function localEconomyDiscovery(state) {
  if (role !== "economy" || (state.inventory?.length ?? 0) >= 28)
    return [];
  const tree = (state.nearbyLocs ?? []).filter((loc) => loc.reachable === true && /^(tree|oak|willow|maple|yew|magic)$/i.test(String(loc.name)) && level(state, "woodcutting") >= harvestLevel(String(loc.name))).map((loc) => ({ loc, chop: loc.optionsWithIndex?.find((option) => /^chop/i.test(text(option.text))) })).filter((entry) => typeof entry.loc.x === "number" && typeof entry.loc.z === "number" && typeof entry.loc.id === "number" && typeof entry.chop.opIndex === "number").sort((a, b) => Number(a.loc.distance ?? 999) - Number(b.loc.distance ?? 999))[0];
  if (!tree)
    return [];
  return [{
    id: `autonomy-harvest-${tree.loc.id}-${tree.loc.x}-${tree.loc.z}`,
    type: "interactLoc",
    fields: { x: tree.loc.x, z: tree.loc.z, locId: tree.loc.id, optionIndex: tree.chop.opIndex, reason: "Fresh reachable resource evidence; measure a local production alternative" },
    waitTicks: 5
  }];
}
function stateKey(state) {
  const player = state.player ?? {};
  const inv = state.inventory ?? [];
  const npcs = state.nearbyNpcs ?? [];
  const locs = state.nearbyLocs ?? [];
  const dialog = state.dialog ?? {};
  const phase = state.inGame === false ? "login" : player === null ? "no-player" : player.isDead === true ? "dead" : "alive";
  const names = [...npcs, ...locs].map((item) => text(item.name)).filter((name) => name.includes("tree") || name.includes("guide")).sort().join(",");
  const enemyTypes = npcs.map((item) => text(item.name)).filter(Boolean).sort().join(",");
  const hasAxe = inv.some((item) => text(item.name).includes("axe"));
  const dialogOpen = dialog.isOpen === true ? "dialog" : "quiet";
  const hp = typeof player.hp === "number" ? player.hp : 0;
  const maxHp = typeof player.maxHp === "number" ? player.maxHp : 1;
  const hpBand = hp * 100 / Math.max(1, maxHp) <= 40 ? "low-hp" : "safe-hp";
  const combat = player.combat;
  const fighting = combat?.inCombat === true ? "fighting" : "free";
  const safeTargets = npcs.filter((npc) => {
    const options = Array.isArray(npc.optionsWithIndex) ? npc.optionsWithIndex : [];
    return npc.reachable === true && npc.inCombat !== true && options.some((option) => text(option.text).includes("attack"));
  }).length;
  const worldX = typeof player.worldX === "number" ? Math.floor(player.worldX / 10) : -1;
  const worldZ = typeof player.worldZ === "number" ? Math.floor(player.worldZ / 10) : -1;
  return [phase, dialogOpen, hpBand, fighting, `targets${safeTargets}`, inv.length >= 28 ? "full" : `inv${inv.length}`, hasAxe ? "axe" : "no-axe", names, `enemies:${enemyTypes}`, `${worldX},${worldZ}`].join("|");
}
function dialogCandidates(state) {
  const dialog = state.dialog ?? {};
  if (dialog.isOpen !== true)
    return [];
  const options = Array.isArray(dialog.options) ? dialog.options : [];
  if (dialog.isWaiting === true)
    return [{ id: "wait-dialog-ready", type: "wait", waitTicks: 2 }];
  const option = role === "economy" && work.economy?.product ? productionDialog(options, work.economy.product) ?? dialogueOption(options) : dialogueOption(options);
  if (!option)
    return [{ id: "close-unrecognized-dialog", type: "closeModal", waitTicks: 2 }];
  return [{
    id: `dialog-${option.index}-${String(option.text).slice(0, 35)}`,
    type: "clickDialogOption",
    fields: { optionIndex: option.index },
    waitTicks: role === "economy" && work.economy?.product ? 4 : 2
  }];
}
async function goalCandidates(state) {
  return training ? training.next(state, (from, to) => navigator.assess(from, to)) : [{ id: "training-unavailable", type: "wait", waitTicks: 5 }];
}
async function autonomousRecovery(state, blockedGoal) {
  const routes = /full-inventory|bank-route/i.test(blockedGoal) ? [["bank", WORLD_ROUTES.varrockWestBank]] : role === "economy" ? [["trees", WORLD_ROUTES.lumbridgeTrees], ["mine", WORLD_ROUTES.varrockSouthEastMine], ["bank", WORLD_ROUTES.varrockWestBank]] : build === "ranged-magic" ? [["knife", WORLD_ROUTES.lumbridgeKnife], ["trees", WORLD_ROUTES.lumbridgeTrees], ["archery", WORLD_ROUTES.lowesArchery], ["runes", WORLD_ROUTES.wizardsTower]] : [["food", WORLD_ROUTES.draynorFishing], ["barbarians", WORLD_ROUTES.barbarianVillage], ["bank", WORLD_ROUTES.varrockWestBank]];
  const from = position(state);
  let loadingMap = false;
  for (const [name, target] of routes) {
    if (from.level !== target.level || Math.max(Math.abs(from.x - target.x), Math.abs(from.z - target.z)) > 2) {
      const route = await navigator.assess(from, target);
      if (route.status === "loading-map") {
        loadingMap = true;
        continue;
      }
      if (route.status === "ready")
        return [{
          id: `autonomy-explore-${name}`,
          type: "walkTo",
          fields: { ...target, running: true, reason: `No executable ${blockedGoal}; survey a verified ${name} area for the next safe action` },
          waitTicks: 2
        }];
    }
  }
  if (loadingMap)
    return [{ id: "autonomy-map-loading", type: "wait", waitTicks: 3 }];
  return [{ id: "autonomy-scan-current-area", type: "scanNearbyLocs", fields: { radius: 32, reason: `No executable ${blockedGoal}; refresh local world evidence` }, waitTicks: 2 }];
}
function gearCandidates(state) {
  const inventory = state.inventory ?? [];
  const equipment = state.equipment ?? [];
  const combatStyle = state.combatStyle;
  const weaponName = text(combatStyle?.weaponName);
  const hasShield = equipment.some((item) => text(item.name).includes("shield"));
  const weaponRank = (name) => {
    const tier = ["bronze", "iron", "steel", "mithril", "adamant", "rune"].findIndex((metal) => name.includes(metal));
    const type = name.includes("scimitar") ? 5 : name.includes("longsword") ? 4 : name.includes("sword") ? 3 : name.includes("mace") ? 2 : name.includes("dagger") ? 1 : 0;
    return Math.max(0, tier) * 10 + type;
  };
  if (build === "ranged-magic") {
    const bowQuality = (id) => gearCatalog.items.find((i) => i.id === id && i.family === "bow" && usable(i, state))?.quality ?? 0;
    const currentBowQuality = Math.max(0, ...equipment.map((i) => bowQuality(i.id)));
    const bow = inventory.filter((i) => bowQuality(i.id) > currentBowQuality).sort((a, b) => bowQuality(b.id) - bowQuality(a.id))[0];
    if (bow && weaponName !== text(bow.name)) {
      const wield = bow.optionsWithIndex?.find((option) => /wield|equip/i.test(text(option.text)));
      if (typeof bow.slot === "number" && typeof wield?.opIndex === "number")
        return [{ id: "wield-ranged-" + bow.slot, type: "useInventoryItem", fields: { slot: bow.slot, optionIndex: wield.opIndex }, waitTicks: 2 }];
    }
    const compatible = (item) => arrowRank(String(item.name)) > 0 && arrowRank(String(item.name)) <= bowArrowCap(weaponName);
    const arrowsEquipped = equipment.some(compatible);
    const arrows = inventory.find(compatible);
    if (!arrowsEquipped && arrows) {
      const wield = arrows.optionsWithIndex?.find((option) => /wield|equip/i.test(text(option.text)));
      if (typeof arrows.slot === "number" && typeof wield?.opIndex === "number")
        return [{ id: "wield-ammo-" + arrows.slot, type: "useInventoryItem", fields: { slot: arrows.slot, optionIndex: wield.opIndex }, waitTicks: 2 }];
    }
  }
  const weapon = build === "ranged-magic" ? undefined : inventory.filter((item) => !text(item.name).includes("axe") && !text(item.name).includes("pickaxe") && !text(item.name).includes("shield") && (text(item.name).includes("sword") || text(item.name).includes("scimitar") || text(item.name).includes("mace") || text(item.name).includes("dagger"))).sort((a, b) => weaponRank(text(b.name)) - weaponRank(text(a.name)))[0];
  const groundUpgrade = state.groundItems?.filter((item) => item.reachable === true && /sword|scimitar|mace|dagger|shield/i.test(text(item.name))).sort((a, b) => weaponRank(text(b.name)) - weaponRank(text(a.name)))[0];
  if (groundUpgrade && typeof groundUpgrade.x === "number" && typeof groundUpgrade.z === "number" && typeof groundUpgrade.id === "number" && weaponRank(text(groundUpgrade.name)) > weaponRank(weaponName)) {
    return [{ id: `pickup-upgrade-${groundUpgrade.id}-${groundUpgrade.x}-${groundUpgrade.z}`, type: "pickupItem", fields: { x: groundUpgrade.x, z: groundUpgrade.z, itemId: groundUpgrade.id, reason: "equipment upgrade" }, waitTicks: 3 }];
  }
  if (weaponName === "unarmed" || weapon !== undefined && weaponRank(text(weapon.name)) > weaponRank(weaponName)) {
    const wield = weapon?.optionsWithIndex?.find((option) => text(option.text).includes("wield"));
    if (weapon && typeof weapon.slot === "number" && typeof wield?.opIndex === "number") {
      return [{ id: `wield-${weapon.slot}`, type: "useInventoryItem", fields: { slot: weapon.slot, optionIndex: wield.opIndex }, waitTicks: 2 }];
    }
  }
  if (build !== "ranged-magic" && weaponName !== "unarmed" && !hasShield) {
    const shield = inventory.find((item) => text(item.name).includes("shield"));
    const wield = shield?.optionsWithIndex?.find((option) => text(option.text).includes("wield"));
    if (shield && typeof shield.slot === "number" && typeof wield?.opIndex === "number") {
      return [{ id: `wield-shield-${shield.slot}`, type: "useInventoryItem", fields: { slot: shield.slot, optionIndex: wield.opIndex }, waitTicks: 2 }];
    }
  }
  const styles = Array.isArray(combatStyle?.styles) ? combatStyle.styles : [];
  const attack = (state.skills ?? []).find((skill) => text(skill.name) === "attack");
  const strength = (state.skills ?? []).find((skill) => text(skill.name) === "strength");
  const attackLevel = typeof attack?.level === "number" ? attack.level : 1;
  const strengthLevel = typeof strength?.level === "number" ? strength.level : 1;
  const desiredSkill = build === "ranged-magic" ? "ranged" : meleeTrainingSkill(attackLevel, strengthLevel);
  const strengthStyle = styles.find((style) => {
    const trains = Array.isArray(style.trainsSkills) ? style.trainsSkills : [];
    return trains.some((skill) => text(skill) === desiredSkill);
  });
  if (typeof strengthStyle?.index === "number" && combatStyle?.currentStyle !== strengthStyle.index) {
    return [{ id: `style-${desiredSkill}-${strengthStyle.index}`, type: "setCombatStyle", fields: { style: strengthStyle.index }, waitTicks: 1 }];
  }
  return [];
}
function combatLoadoutCandidates(state) {
  if (build === "ranged-magic")
    return [];
  const target = (state.nearbyNpcs ?? []).find((npc) => npc.reachable === true && npc.inCombat !== true && Array.isArray(npc.optionsWithIndex) && npc.optionsWithIndex.some((o) => /attack/i.test(text(o.text))));
  if (!target)
    return [];
  const targetName = text(target.name);
  const inventory = state.inventory ?? [];
  const equipment = state.equipment ?? [];
  const weaponName = text(state.combatStyle?.weaponName);
  const shieldEquipped = equipment.some((item) => /shield/i.test(text(item.name)));
  const twoHanded = inventory.find((item) => /two-handed|2h|battleaxe|warhammer|halberd|godsword/i.test(text(item.name)));
  const options = [];
  if (twoHanded && weaponName !== text(twoHanded.name) && typeof twoHanded.slot === "number") {
    const wield = twoHanded.optionsWithIndex?.find((o) => /wield|equip/i.test(text(o.text)));
    if (typeof wield?.opIndex === "number")
      options.push({ id: "experiment-2h-" + twoHanded.slot, type: "useInventoryItem", fields: { slot: twoHanded.slot, optionIndex: wield.opIndex }, waitTicks: 2 });
  }
  if (!shieldEquipped) {
    const shield = inventory.find((item) => /shield|defender/i.test(text(item.name)));
    const wield = shield?.optionsWithIndex?.find((o) => /wield|equip/i.test(text(o.text)));
    if (shield && typeof shield.slot === "number" && typeof wield?.opIndex === "number")
      options.push({ id: "experiment-shield-" + shield.slot, type: "useInventoryItem", fields: { slot: shield.slot, optionIndex: wield.opIndex }, waitTicks: 2 });
  }
  return options;
}
function foodCandidates(state) {
  if (!shouldHeal(state, build === "ranged-magic"))
    return [];
  return (state.inventory ?? []).flatMap((item) => {
    const eat = item.optionsWithIndex?.find((option) => text(option.text) === "eat");
    return typeof item.slot === "number" && typeof eat?.opIndex === "number" ? [{ id: `eat-${item.slot}`, type: "useInventoryItem", fields: { slot: item.slot, optionIndex: eat.opIndex }, waitTicks: 1 }] : [];
  }).slice(0, 1);
}
function productionCandidates(state) {
  if (role === "economy")
    return [];
  const inv = state.inventory ?? [];
  const locs = state.nearbyLocs ?? [];
  const raw = inv.find((item) => /^raw shrimps$/i.test(String(item.name)) || level(state, "cooking") >= 15 && /^raw anchovies$/i.test(String(item.name)));
  const fire = locs.find((loc) => /^(fireplace|fire|range|stove|cooking pot)$/i.test(String(loc.name)) && (loc.reachable === true || Number(loc.distance) <= 2));
  if (raw && fire && typeof raw.slot === "number" && typeof fire.x === "number" && typeof fire.z === "number") {
    return [{ id: `cook-${raw.slot}-${fire.x}-${fire.z}`, type: "useItemOnLoc", fields: { itemSlot: raw.slot, x: fire.x, z: fire.z, locId: fire.id }, waitTicks: 4 }];
  }
  const rawCount = inv.filter((i) => /^raw shrimps$/i.test(String(i.name))).reduce((n, i) => n + Number(i.count), 0);
  if (raw && (rawCount >= 8 || inv.length >= 28 || Number(state.player?.hp) < Number(state.player?.maxHp) * 0.6))
    return [{ id: "travel-to-cooking-source", type: "walkTo", fields: { ...WORLD_ROUTES.draynorCooking, reason: "cook carried shrimp before gathering more" }, waitTicks: 2 }];
  const hasNet = inv.some((i) => /small fishing net/i.test(String(i.name)));
  if (!hasNet && !inv.some(isFood)) {
    const shop = state.shop ?? {};
    const stock = shop.shopItems ?? [];
    if (shop.isOpen === true) {
      const net = stock.find((i) => /small fishing net/i.test(String(i.name)) && Number(i.count) > 0 && Number(i.buyPrice) <= coinsIn(inv));
      if (net)
        return [{ id: "buy-recovery-net", type: "shopBuy", fields: { slot: net.slot, amount: 1 }, waitTicks: 2 }];
      return [];
    }
    const gerrant = (state.nearbyNpcs ?? []).find((n) => /gerrant/i.test(String(n.name)) && n.reachable === true);
    const trade = gerrant?.optionsWithIndex?.find((o) => /trade/i.test(String(o.text)));
    if (gerrant && trade)
      return [{ id: "trade-for-fishing-tool", type: "interactNpc", fields: { npcIndex: gerrant.index, optionIndex: trade.opIndex }, waitTicks: 3 }];
    return [{ id: "travel-for-fishing-tool", type: "walkTo", fields: WORLD_ROUTES.gerrantsFishingShop, waitTicks: 2 }];
  }
  const fish = (state.nearbyNpcs ?? []).find((npc) => /fishing\s*spot/i.test(String(npc.name)) && npc.reachable === true && typeof npc.index === "number" && !(Number(npc.x) >= 3076 && Number(npc.x) <= 3094 && Number(npc.z) >= 3229 && Number(npc.z) <= 3247));
  const fishing = level(state, "fishing");
  const foodCount = inv.reduce((sum, item) => /^(shrimp|anchovies|trout|salmon|sardines|herring|tuna|lobster|swordfish|bread|pizza)/i.test(String(item.name)) ? sum + (typeof item.count === "number" ? item.count : 1) : sum, 0);
  if (fish && hasNet && inv.length < 28 && foodCount < BUILD.foodTripTarget) {
    const option = fish.optionsWithIndex?.find((candidate) => /^net$/i.test(text(candidate.text)));
    if (typeof option?.opIndex === "number")
      return [{ id: `fish-${fish.index}`, type: "interactNpc", fields: { npcIndex: fish.index, optionIndex: option.opIndex, reason: "fish safe starter food" }, waitTicks: 5 }];
  }
  const playerCombatLevel = typeof state.player?.combatLevel === "number" ? state.player.combatLevel : 1;
  const emergencyFoodMinimum = playerCombatLevel <= 5 ? 1 : BUILD.foodTripMinimum;
  if (foodCount < emergencyFoodMinimum) {
    const player = state.player ?? {};
    const distanceToDraynor = Math.hypot((Number(player.worldX) || 0) - WORLD_ROUTES.draynorFishing.x, (Number(player.worldZ) || 0) - WORLD_ROUTES.draynorFishing.z);
    if (distanceToDraynor > 8)
      return [{ id: "walk-to-draynor-fishing", type: "walkTo", fields: { ...WORLD_ROUTES.draynorFishing, running: true, reason: "safe level-1 food recovery" }, waitTicks: 5 }];
    return [{ id: "scan-for-draynor-fishing", type: "scanNearbyLocs", fields: { radius: 40, reason: "find fishing-spot NPC" }, waitTicks: 2 }];
  }
  return [];
}
async function candidates(state) {
  if (role === "economy") {
    work.economy ??= { bankItems: work.bankItems ?? [] };
    const previous = work.economy.objectives?.intent?.id, intent = selectWork(state, work.economy);
    if (previous !== intent?.id)
      travelAction = null;
    const memory = objectives(work.economy), reserve = bowReserve(work.economy);
    for (const need of memory.needs)
      if (need.verified && need.downstreamReady && need.expires > Date.now())
        reserve[need.outputId] = Math.max(reserve[need.outputId] ?? 0, need.quantity);
    const inv = state.inventory ?? [], processing = inv.some((i) => String(i.name).toLowerCase() === work.economy.processing);
    const unfinished = intent?.mode === "finish" || processing || intent?.mode !== "logs" && inv.some((i) => /^(.*logs|logs|.*ore|.*bar)$/i.test(String(i.name)));
    equipmentGoals.setWorkIntent(intent ? { track: intent.track, outputId: intent.outputId, reserve, prices: memory.prices, allowLiquidation: !unfinished && Number(state.player?.animId ?? -1) < 0 } : undefined);
    saveWork();
  }
  if (Date.now() >= marketRetryAt)
    try {
      peerMarket?.observe(state, equipmentGoals.memory.bank, equipmentGoals.memory.bankCheckedAt, work.economy?.objectives?.decision);
    } catch (error) {
      marketRetryAt = Date.now() + 60000;
      console.error(JSON.stringify({ marketError: String(error), policy: "Keep normal goals running; retry market later" }));
    }
  if (state.trade?.isOpen)
    return [{ id: "decline-unverified-trade", type: "closeModal", waitTicks: 2 }];
  if (state.player?.isDead === true)
    return [{ id: "wait-respawn", type: "wait", waitTicks: 5 }];
  if (state.modalOpen === true && state.inventory?.length === 0) {
    return [{ id: "accept-design", type: "acceptCharacterDesign", waitTicks: 2 }];
  }
  if (equipmentGoals.crafting() && state.dialog?.isOpen === true && state.dialog?.isWaiting !== true) {
    const recipe = await equipmentGoals.next(state, (from, to) => navigator.assess(from, to));
    if (recipe)
      return [recipe];
  }
  if (role === "economy" && work.economy) {
    const recipe = metalDialog(state, work.economy);
    if (recipe) {
      saveWork();
      return [recipe];
    }
  }
  const dialogs = dialogCandidates(state);
  if (dialogs.length > 0)
    return dialogs;
  if ((state.inventory?.length ?? 0) === 0) {
    const guide = (state.nearbyNpcs ?? []).find((npc) => /runescape guide|tutorial guide|guide/i.test(text(npc.name)) && typeof npc.index === "number");
    if (guide)
      return [{ id: "tutorial-guide-" + guide.index, type: "talkToNpc", fields: { npcIndex: guide.index }, waitTicks: 3 }];
  }
  const food = foodCandidates(state);
  if (food.length > 0) {
    equipmentGoals.interrupt("heal");
    return state.bank?.isOpen === true || state.shop?.isOpen === true ? [{ id: "close-modal-to-heal", type: "closeModal", waitTicks: 1 }] : food;
  }
  if (build === "ranged-magic") {
    const reload = available(quiverRefill(state));
    if (reload.length)
      return state.bank?.isOpen || state.shop?.isOpen ? [{ id: "close-modal-to-reload", type: "closeModal", waitTicks: 1 }] : reload;
  }
  const disposition = combatDisposition(state, role === "economy", build === "ranged-magic");
  if (training?.timedOut(state)) {
    travelAction = null;
    return [{ id: "escape-encounter-timeout", type: "retreat", waitTicks: 2 }];
  }
  if (disposition !== "quiet") {
    equipmentGoals.interrupt(disposition === "engaged" ? "finish current combat" : "escape danger");
    travelAction = null;
    if (disposition === "engaged")
      return [{ id: "continue-combat", type: "wait", waitTicks: 2 }];
    return [{ id: "escape-combat", type: "retreat", waitTicks: 2 }];
  }
  if (role !== "economy" && !(state.inventory ?? []).some(isFood) && !state.bank?.isOpen && !state.shop?.isOpen) {
    const supplies = available(productionCandidates(state));
    if (supplies.length) {
      equipmentGoals.interrupt("replenish food");
      travelAction = null;
      return supplies;
    }
  }
  const rangedSupply = preferRangedSupply(build === "ranged-magic", available([...nearbyAmmoRecovery(state), ...ammoCandidates(state)]), []);
  if (rangedSupply.length) {
    equipmentGoals.interrupt("restore ranged supplies");
    travelAction = null;
    return rangedSupply;
  }
  const social = Date.now() >= marketRetryAt ? peerMarket?.next(state) : undefined;
  if (social)
    return [social];
  if (role === "economy" && work.economy?.objectives?.intent?.mode === "finish") {
    equipmentGoals.interrupt("Complete bounded bowmaking batch");
    if (!state.bank?.isOpen && !state.shop?.isOpen && travelAction && available([travelAction]).length)
      return [travelAction];
    travelAction = null;
    const plan = available(bowNext(state, work.economy, (id) => (work.failures[id]?.until ?? 0) > Date.now()));
    saveWork();
    return plan.length ? plan : [{ id: "economy-bow-recovery", type: "wait", waitTicks: 5 }];
  }
  const acquisition = await equipmentGoals.next(state, (from, to) => navigator.assess(from, to));
  if (acquisition) {
    if (role === "economy" && acquisition.id === "goal-capital-withdraw") {
      work.economy ??= { bankItems: work.bankItems ?? [] };
      work.economy.selling = true;
      saveWork();
    }
    travelAction = null;
    return [acquisition];
  }
  if (role === "economy") {
    work.economy ??= { bankItems: work.bankItems ?? [] };
    if (!state.bank?.isOpen && !state.shop?.isOpen && travelAction && available([travelAction]).length)
      return [travelAction];
    travelAction = null;
    const plan = available(economyNext(state, work.economy, (id) => (work.failures[id]?.until ?? 0) > Date.now()));
    saveWork();
    if (plan.length)
      return plan;
    const freshResource = available(localEconomyDiscovery(state));
    return freshResource.length ? freshResource : available(await autonomousRecovery(state, "economy-recovery-cooldown"));
  }
  if (state.bank?.isOpen === true)
    return available(bankingCandidates(state)).length ? available(bankingCandidates(state)) : [{ id: "close-stalled-bank", type: "closeModal", waitTicks: 2 }];
  if (state.shop?.isOpen === true) {
    const recoveryBuy = (state.inventory ?? []).some(isFood) ? [] : productionCandidates(state).filter((a) => a.type === "shopBuy");
    const purchases = available([...recoveryBuy, ...ammoCandidates(state)]);
    return purchases.length ? purchases : [{ id: "close-finished-shop", type: "closeModal", waitTicks: 2 }];
  }
  if (travelAction && !travelAction.fields?.trainingSite && available([travelAction]).length)
    return [travelAction];
  travelAction = null;
  if (work.bankReturn && work.bankReturnReady) {
    const home = work.bankReturn;
    if (position(state).level === home.level && Math.max(Math.abs(Number(state.player?.worldX) - home.x), Math.abs(Number(state.player?.worldZ) - home.z)) <= 1) {
      delete work.bankReturn;
      delete work.bankReturnReady;
      saveWork();
    } else if (available([{ id: "return-to-work", type: "walkTo", waitTicks: 2 }]).length)
      return [{ id: "return-to-work", type: "walkTo", fields: home, waitTicks: 2 }];
  }
  const gear = available(gearCandidates(state));
  if (gear.length > 0)
    return gear;
  if (role !== "economy" && (state.inventory ?? []).some((i) => /^raw shrimps$/i.test(String(i.name)))) {
    const cooking = available(productionCandidates(state)).filter((a) => a.id.startsWith("cook-") || a.id === "travel-to-cooking-source");
    if (cooking.length)
      return cooking;
  }
  const banking = available(bankingCandidates(state));
  if (banking.length > 0)
    return banking;
  if (role !== "economy" && !(state.inventory ?? []).some(isFood)) {
    const recovery = available(productionCandidates(state));
    if (recovery.length)
      return recovery;
  }
  const ammo = available(ammoCandidates(state));
  if (ammo.length > 0)
    return ammo;
  const combatLoadout = combatLoadoutCandidates(state);
  if (combatLoadout.length > 0)
    return combatLoadout;
  const production = available(productionCandidates(state));
  if (production.length > 0)
    return production;
  const economy = available(economyCandidates(state));
  if (economy.length > 0)
    return economy;
  if ((state.inventory?.length ?? 0) >= 28)
    return available(await autonomousRecovery(state, "full-inventory-await-bank-route"));
  const goal = available(await goalCandidates(state));
  if (goal.length > 0) {
    if (goal.every(passive)) {
      const recovery = available(await autonomousRecovery(state, goal[0].id));
      if (recovery.length)
        return recovery;
    }
    return goal;
  }
  const result = [];
  for (const npc of state.nearbyNpcs ?? []) {
    if (text(npc.name).includes("runescape guide") && typeof npc.index === "number") {
      result.push({ id: `talk-guide-${npc.index}`, type: "talkToNpc", fields: { npcIndex: npc.index }, waitTicks: 2 });
    }
  }
  for (const loc of state.nearbyLocs ?? []) {
    if (!text(loc.name).includes("tree"))
      continue;
    const options = Array.isArray(loc.optionsWithIndex) ? loc.optionsWithIndex : [];
    const chop = options.find((option) => text(option.text).includes("chop"));
    if (loc.reachable === true && chop !== undefined && typeof loc.x === "number" && typeof loc.z === "number" && typeof loc.id === "number") {
      result.push({
        id: `chop-${loc.id}-${loc.x}-${loc.z}`,
        type: "interactLoc",
        fields: { x: loc.x, z: loc.z, locId: loc.id, optionIndex: typeof chop?.opIndex === "number" ? chop.opIndex : 1 },
        waitTicks: 5
      });
    }
  }
  result.push({ id: "scan-locs", type: "scanNearbyLocs", fields: { radius: 12 }, waitTicks: 2 });
  result.push({ id: "wait", type: "wait", waitTicks: 3 });
  return available(result);
}
function reward(before, after, action) {
  return outcomeReward(before, after, action, role, build === "ranged-magic", gearCatalog);
}
function choose(key, options) {
  options = preferActive(options);
  const values = q[key] ?? {};
  if (Math.random() < epsilon)
    return options[Math.floor(Math.random() * options.length)];
  return options.reduce((best, option) => (values[option.id] ?? 0) > (values[best.id] ?? 0) ? option : best, options[0]);
}
function learn(key, action, value, nextKey, nextOptions) {
  q[key] ??= {};
  const nextValues = q[nextKey] ?? {};
  const nextBest = nextOptions.length === 0 ? 0 : Math.max(...nextOptions.map((candidate) => nextValues[candidate.id] ?? 0));
  const old = q[key][action.id] ?? 0;
  q[key][action.id] = Number((old + alpha * (value + gamma * nextBest - old)).toFixed(6));
}
async function runEpisode() {
  console.log(JSON.stringify({ agent: "hybrid-q-learning", profile, character, steps, epsilon, forever }));
  await cliCall(["connect"]);
  let state = stateFrom(await cliCall(["state"]));
  training?.observe(state);
  let preparedOptions;
  await syncForum(state);
  await maybePublishGitHubLearning(state);
  console.log(JSON.stringify({ plan: progression(state), attack: level(state, "attack"), strength: level(state, "strength") }));
  for (let step = 1;step <= steps; step++) {
    let key = stateKey(state);
    appendFileSync(observationsPath, JSON.stringify({ time: new Date().toISOString(), tick: state.tick, position: { x: state.player?.worldX, z: state.player?.worldZ }, skills: Object.fromEntries((state.skills ?? []).map((s) => [String(s.name), s.level])), equipment: state.equipment ?? [], npcs: (state.nearbyNpcs ?? []).map((n) => ({ name: n.name, combatLevel: n.combatLevel, x: n.x, z: n.z, reachable: n.reachable })), locs: (state.nearbyLocs ?? []).map((l) => ({ name: l.name, x: l.x, z: l.z, reachable: l.reachable })) }) + `
`);
    const refreshPrepared = preparedOptions?.some((action) => action.id.startsWith("training-observe-") || action.id === "economy-bow-wait-interface") ?? false;
    const options = refreshPrepared ? await candidates(state) : preparedOptions ?? await candidates(state);
    if (options.length === 0)
      break;
    const action = choose(key, options);
    if (action.id.startsWith("goal-") || action.id.startsWith("economy-metal-") || action.id.startsWith("economy-bow-")) {
      const fresh = stateFrom(await cliCall(["state"]));
      if (!equipmentGoals.validate(fresh, action) || !validateMetal(fresh, action, state) || !validateBow(fresh, action, state) || shouldHeal(fresh, build === "ranged-magic") || combatDisposition(fresh, role === "economy", build === "ranged-magic") !== "quiet") {
        state = fresh;
        preparedOptions = undefined;
        continue;
      }
      state = fresh;
      key = stateKey(state);
    }
    if (action.fields?.trainingSite) {
      const fresh = stateFrom(await cliCall(["state"]));
      training?.observe(fresh);
      if (!training?.validateAction(fresh, action)) {
        state = fresh;
        preparedOptions = undefined;
        continue;
      }
      state = fresh;
      key = stateKey(state);
    }
    training?.beforeAction(state, action);
    peerMarket?.before(action);
    const started = Date.now();
    let result;
    try {
      const dispatchedFields = { ...action.fields ?? {}, reason: action.fields?.reason ?? action.id };
      delete dispatchedFields.trainingSite;
      delete dispatchedFields.goalMethod;
      delete dispatchedFields.expectedItemId;
      if (action.type === "shopBuy" || action.type === "shopSell") {
        delete dispatchedFields.itemId;
        delete dispatchedFields.expectedPrice;
      }
      let waited;
      if (action.type === "retreat") {
        const trip = await navigator.escape(state);
        waited = { state: trip.state };
        result = { navigation: trip.navigation };
        travelAction = null;
        if (trip.state.tick === state.tick)
          waited = await cliCall(["wait", "2"]);
      } else if (action.type === "walkTo") {
        if (role === "economy" && action.id === "walk-to-varrock-west-bank" && !work.bankReturn) {
          work.bankReturn = position(state);
          work.bankReturnReady = false;
          saveWork();
        }
        const trip = await navigator.step({ x: Number(dispatchedFields.x), z: Number(dispatchedFields.z), level: Number(dispatchedFields.level ?? 0) }, state);
        waited = { state: trip.state };
        if (trip.state.tick === state.tick && trip.navigation.status !== "arrived")
          waited = await cliCall(["wait", "2"]);
        result = { navigation: trip.navigation };
        travelAction = ["progress", "loading-map", "replanning"].includes(trip.navigation.status) ? action : null;
        if (trip.navigation.status === "blocked")
          noteFailure(action);
        console.log(JSON.stringify({ action: action.id, navigation: trip.navigation }));
      } else {
        result = await cliCall(action.type === "wait" ? ["wait", String(action.waitTicks)] : ["act", action.type, "--json", JSON.stringify(dispatchedFields)]);
        waited = action.type === "wait" ? result : await cliCall(["wait", String(action.waitTicks)]);
        if (/^(economy-|gather-safe|chop-)/.test(action.id) && action.type === "interactLoc") {
          for (let poll = 0;poll < 6; poll++) {
            const observed = stateFrom(waited);
            if (Number(observed.player?.hp) < Number(state.player?.hp) || isThreatened(observed) || observed.inventory?.length !== state.inventory?.length || observed.player?.animId === -1 || observed.dialog?.isOpen)
              break;
            waited = await cliCall(["wait", "2"]);
          }
        }
      }
      const next = stateFrom(waited);
      peerMarket?.after(next, action);
      equipmentGoals.after(state, next, action);
      training?.afterAction(state, next, action);
      if (next.player?.lifeId !== state.player?.lifeId) {
        travelAction = null;
        delete work.bankReturn;
        delete work.bankReturnReady;
        saveWork();
      }
      if (/^bank(Deposit|Withdraw)$/.test(action.type)) {
        if (!verifyBankTransfer(state, next, action))
          throw new Error("Bank transfer did not change inventory and bank counts");
        work.bankItems = next.bank?.items;
        saveWork();
        console.log(JSON.stringify({ bankTransfer: action.type, slot: action.fields?.slot, verified: true }));
      }
      if (action.type === "closeModal" && next.bank?.isOpen === true)
        throw new Error("Bank did not close");
      if (action.type === "closeModal" && state.bank?.isOpen === true && next.bank?.isOpen === false) {
        if (work.bankReturn)
          work.bankReturnReady = true;
        if (work.foodWithdrawalPending)
          delete work.foodWithdrawalPending;
        saveWork();
      }
      const freshMessages = (next.gameMessages ?? []).filter((m) => m.tick > Number(state.tick ?? 0));
      if (action.id.startsWith("cautious-pickpocket-")) {
        work.pickpocketStreak = (work.pickpocketStreak ?? 0) + 1;
        saveWork();
      }
      if (action.id.startsWith("buy-arrows-") || /^bank-(surplus-coins|deposit)/.test(action.id)) {
        delete work.pickpocketStreak;
        saveWork();
      }
      if (role === "economy" && work.economy) {
        observeWork(state, next, action, work.economy);
        observeBow(state, next, action, work.economy);
        saveWork();
      }
      if (freshMessages.some((m) => /you need|can't reach|cannot reach|inventory.*full|don't have|do not have|not enough/i.test(m.text)))
        noteFailure(action);
      const value = reward(state, next, action);
      work.autonomy ??= {};
      const transientNavigation = action.id === "continue-combat" || action.id === "autonomy-map-loading" || result.navigation?.status === "loading-map" || result.navigation?.status === "replanning";
      const autonomy = recordAutonomy(work.autonomy, state, next, action, Date.now(), transientNavigation);
      if (autonomy.stalled) {
        noteFailure(action);
        console.log(JSON.stringify({ autonomy: "blocked-no-progress", intent: autonomy.intent, action: action.id }));
      } else
        saveWork();
      preparedOptions = await candidates(next);
      learn(key, action, value, stateKey(next), preparedOptions);
      appendFileSync(experiencePath, `${JSON.stringify({ time: new Date().toISOString(), step, key, action, result, reward: value, nextKey: stateKey(next), elapsedMs: Date.now() - started })}
`);
      console.log(JSON.stringify({ step, action: action.id, reward: value, tick: next.tick, inventory: next.inventory?.length ?? 0, plan: progression(next) }));
      state = next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      equipmentGoals.failed(action, message);
      noteFailure(action);
      travelAction = null;
      training?.actionFailed();
      preparedOptions = undefined;
      q[key] ??= {};
      q[key][action.id] = (q[key][action.id] ?? 0) - 1;
      console.error(JSON.stringify({ step, action: action.id, error: message }));
      await discussForumProblem(message);
      if (/another action is in progress/i.test(message)) {
        await Bun.sleep(5000);
      }
      state = stateFrom(await cliCall(["state"]));
    }
  }
  writeFileSync5(qPath, `${JSON.stringify(q, null, 2)}
`);
  console.log(JSON.stringify({ complete: true, qTable: qPath, experience: experiencePath, observations: observationsPath }));
}
async function main() {
  const releaseController = acquireController(resolve5(dataDir, "controller.lock"));
  peerMarket = new PeerMarket(resolve5(root, "data/shared/market.sqlite"), character, gearCatalog, () => Date.now(), process.env.CLAWSCAPE_SERVER ?? "https://clawscape.xyz");
  if (["clawscout", "stinger", "coincrafter"].includes(character)) {
    training = new TrainingDiscovery(resolve5(dataDir, "training-knowledge.json"), character, loadCatalog(), build === "ranged-magic", role === "economy");
  }
  navigator = new Navigator({
    state: async () => stateFrom(await cliCall(["state"])),
    act: async (type, fields) => cliCall(["act", type, "--json", JSON.stringify({ ...fields, reason: "collision-route navigation" })]),
    wait: async (ticks) => stateFrom(await cliCall(["wait", String(ticks)]))
  }, resolve5(dataDir, "navigation.json"));
  try {
    do {
      try {
        await runEpisode();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryInMs = Math.max(30000, intervalMs);
        console.error(JSON.stringify({ episodeError: message, retryInMs }));
        if (!forever)
          throw error;
        await Bun.sleep(retryInMs);
      }
      if (forever)
        await Bun.sleep(Math.max(1000, intervalMs));
    } while (forever);
  } finally {
    navigator.close();
    peerMarket?.close();
    releaseController();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
