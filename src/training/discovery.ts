import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { distance, validTile, type Tile } from '../navigation/geometry';
import { foodCount, skillLevel, type Action } from '../progression-policy';
import { hasUsableArrows, isThreatened } from '../runtime-policy';
import type { Catalog, Monster } from './catalog';

type Route = { status: string; cost?: number; conditionalDoors?: number; reason?: string };
export type RouteProbe = (from: Tile, to: Tile) => Promise<Route>;
type Outcomes = { encounters: number; kills: number; productive: number; xp: number; ticks: number; damage: number; food: number; ammo: number; escapes: number; deaths: number };
type Site = { id: string; name: string; monsterId: number; combatLevel: number; points: Tile[]; source: 'guide' | 'observed'; evidence: string; guideIds: string[]; firstSeen?: string; lastSeen?: string; sightings: number; cooldownUntil: number; failures: number; stats: Record<string, Outcomes>; observationPasses: number; lastObservationTick?: number; emptySinceTick?: number };
type Encounter = { siteId: string; index: number; monsterId: number; life: number; tick: number; context: string; xp: number; ticks: number; damage: number; food: number; ammo: number; confirmedKill: boolean };
type Knowledge = { sites: Record<string, Site>; observations: Record<string, any>; commitment?: { siteId: string; since: number; encounters: number; approaches?: Tile[] }; exploration: { window: number; trips: number }; pending?: Encounter; status?: any; lastObserved?: string; retryAt?: number };
const fresh = (): Knowledge => ({ sites: {}, observations: {}, exploration: { window: 0, trips: 0 } });
const outcomes = (): Outcomes => ({ encounters: 0, kills: 0, productive: 0, xp: 0, ticks: 0, damage: 0, food: 0, ammo: 0, escapes: 0, deaths: 0 });
const at = (s: any): Tile => ({ x: s.player.worldX, z: s.player.worldZ, level: s.player.level });
const xp = (s: any) => (s.skills ?? []).filter((v: any) => /^(attack|strength|defence|ranged|magic|hitpoints)$/i.test(v.name)).reduce((n: number, v: any) => n + Number(v.experience ?? 0), 0);
const ammo = (s: any) => [...(s.inventory ?? []), ...(s.equipment ?? [])].filter(i => hasUsableArrows(s.combatStyle?.weaponName ?? '', [i])).reduce((n, i) => n + Number(i.count), 0);
const metal = (name: string) => ['bronze', 'iron', 'steel', 'black', 'mithril', 'adamant', 'rune'].findIndex(m => name.toLowerCase().includes(m)) + 1;
const context = (s: any, ranged: boolean) => `${ranged ? 'ranged' : 'melee'}:${s.combatStyle?.weaponName ?? 'unknown'}:def${Math.floor(skillLevel(s, 'defence') / 10)}:skill${Math.floor(skillLevel(s, ranged ? 'ranged' : 'strength') / 10)}`;
export function trainingReadiness(s: any, m: Monster, ranged: boolean): string | undefined {
  if (!s.player || s.player.isDead || isThreatened(s) || s.bank?.isOpen || s.shop?.isOpen || s.dialog?.isOpen) return 'safety-or-interface';
  if ((s.inventory?.length ?? 28) >= 28) return 'inventory-full';
  // Food is a learned trip requirement owned by the agent controller. Do not
  // impose a universal 3-item gate here: a safe low-level trial may begin with
  // one item, or none when the learned policy has proven the encounter safe.
  if (!(Number(s.player.hp) > Number(s.player.maxHp) * .6)) return 'health-or-food';
  // Higher-tier trials, including Black Knights, need a real retreat buffer;
  // do not start one merely because the weapon and level technically qualify.
  if (m.combatLevel >= 30 && (Number(s.player.hp) <= Number(s.player.maxHp) * .8 || foodCount(s) < 3)) return 'high-tier-food-or-health';
  if (skillLevel(s, ranged ? 'ranged' : 'strength') < m.minSkill) return 'skill-prerequisite';
  const weapon = String(s.combatStyle?.weaponName ?? '');
  if (ranged) {
    if (!hasUsableArrows(weapon, s.equipment ?? [])) return 'compatible-quiver-required';
    // Fifteen compatible arrows are enough for a bounded first trial. Once
    // the encounter has measurements, the learned ammo policy—not a fixed
    // starter quota—decides whether to extend or resupply the trip.
    if (ammo(s) < 15) return 'ammo-trip-reserve';
  } else if (!/sword|scimitar|dagger|mace|axe|spear|warhammer/i.test(weapon) || /pickaxe/i.test(weapon)) return 'melee-weapon-required';
  // Initial *trial* prerequisites, not a combat-level safety multiplier. Once
  // sampled, measured cost and outcome determine preference among viable sites.
  // A strong melee build can safely trial the next local tier with its
  // current weapon; do not strand high-Strength agents at cows merely because
  // an intermediate iron weapon has not been purchased yet.
  if (m.minSkill >= 20 && (Number(s.player.maxHp) < 20 || (!ranged && metal(weapon) < 2 && skillLevel(s, 'strength') < 60))) return 'trial-equipment-or-supplies';
}
export class TrainingDiscovery {
  readonly memory: Knowledge;
  private document: { version: number; character: string; worlds: Record<string, Knowledge> };
  private routeCache = new Map<string, { until: number; route: Route }>();
  constructor(private file: string, readonly character: string, readonly catalog: Catalog, private ranged = false, private economy = false, private now = Date.now) {
    this.document = { version: 1, character, worlds: {} };
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.character !== character || saved.version !== 1) throw new Error('Training memory identity/version mismatch');
      this.document = saved;
    }
    this.memory = this.document.worlds[catalog.namespace] ??= fresh();
    for (const h of catalog.sites) this.memory.sites[h.id] ??= {
      id: h.id, name: h.name, monsterId: h.monster.id, combatLevel: h.monster.combatLevel,
      points: h.points, source: 'guide', evidence: h.source, guideIds: h.guideIds,
      sightings: 0, failures: 0, cooldownUntil: 0, stats: {}, observationPasses: 0,
    };
  }
  save() { writeFileSync(this.file, JSON.stringify(this.document, null, 2) + '\n'); }
  timedOut(s: any) { return !!this.memory.pending && s.player?.lifeId === this.memory.pending.life && s.tick > this.memory.pending.tick + 180; }
  validateAction(s: any, action: Action) {
    const site = this.memory.sites[action.fields?.trainingSite];
    const monster = this.catalog.monsters.find(m => m.id === site?.monsterId);
    if (!site || !monster || site.cooldownUntil > this.now() || trainingReadiness(s, monster, this.ranged)) return false;
    if (action.type === 'walkTo') return site.points.some(p => p.x === action.fields?.x && p.z === action.fields?.z && p.level === action.fields?.level);
    const target = s.nearbyNpcs?.find((n: any) => n.index === action.fields?.npcIndex);
    return !!target && target.hp !== 0 && this.monster(target)?.id === monster.id && target.reachable === true && target.inCombat !== true && target.distance <= 8 && target.optionsWithIndex?.some((o: any) => o.opIndex === action.fields?.optionIndex && /^attack$/i.test(o.text));
  }
  actionFailed() { this.finish(false, false); this.save(); }
  private monster(n: any) { return this.catalog.monsters.find(m => m.id === n.id && m.name.toLowerCase() === String(n.name).toLowerCase() && m.combatLevel === n.combatLevel); }
  observe(s: any) {
    if (!s.player || !validTile(at(s))) return;
    const stamp = `${s.player.lifeId}:${s.tick}`;
    if (this.memory.lastObserved === stamp) return;
    this.memory.lastObserved = stamp;
    const time = new Date(this.now()).toISOString();
    for (const n of [...(s.nearbyNpcs ?? []).map((n: any) => ({ ...n, kind: 'npc' })), ...(s.nearbyLocs ?? []).map((n: any) => ({ ...n, kind: 'loc' }))]) {
      const p = { x: n.tileX ?? n.x, z: n.tileZ ?? n.z, level: n.level ?? s.player.level };
      if (!validTile(p) || !Number.isInteger(n.id)) continue;
      const key = `${n.kind}:${n.id}:${p.level}:${Math.floor(p.x / 16)}:${Math.floor(p.z / 16)}:${n.combatLevel ?? ''}`;
      const old = this.memory.observations[key];
      // Transient NPC indices and options are deliberately not persisted as locations.
      this.memory.observations[key] = { kind: n.kind, typeId: n.id, name: n.name, position: p, combatLevel: n.combatLevel, firstSeen: old?.firstSeen ?? time, lastSeen: time, sightings: (old?.sightings ?? 0) + 1, reachable: n.reachable === true };
      const monster = n.kind === 'npc' && this.monster(n);
      if (!monster || p.level !== s.player.level) continue;
      let site = Object.values(this.memory.sites).find(site => site.monsterId === monster.id && site.points.some(point => distance(point, p) <= 20));
      if (!site && n.reachable === true && Object.keys(this.memory.sites).length < 128) {
        const id = `observed-${key}`;
        // Stand on the observed player tile; never claim an arbitrary tile next
        // to an NPC is an interaction-valid approach.
        site = this.memory.sites[id] = { id, name: `${n.name} observed at ${p.x},${p.z}`, monsterId: monster.id, combatLevel: monster.combatLevel, points: [at(s)], source: 'observed', evidence: `state:${stamp}:${time}`, guideIds: [], sightings: 0, failures: 0, cooldownUntil: 0, stats: {}, observationPasses: 0 };
      }
      if (site) { site.firstSeen ??= time; site.lastSeen = time; site.sightings++; }
    }
    const entries = Object.entries(this.memory.observations).sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
    this.memory.observations = Object.fromEntries(entries.slice(0, 512));
    this.save();
  }
  private finish(escaped: boolean, dead: boolean) {
    const e = this.memory.pending;
    if (!e) return;
    const site = this.memory.sites[e.siteId];
    if (site) {
      const stats = site.stats[e.context] ??= outcomes();
      stats.encounters++; stats.kills += Number(e.confirmedKill); stats.productive += Number(e.xp > 0 && !escaped && !dead);
      stats.xp += e.xp; stats.ticks += e.ticks; stats.damage += e.damage; stats.food += e.food; stats.ammo += e.ammo; stats.escapes += Number(escaped); stats.deaths += Number(dead);
      if (escaped || dead) this.block(site.id, dead ? 'death-observed' : 'retreat-observed', dead ? 30 * 60_000 : 5 * 60_000);
      else if (e.xp > 0) { site.observationPasses = 0; if (this.memory.commitment?.siteId === site.id) this.memory.commitment.encounters++; }
    }
    delete this.memory.pending;
  }
  beforeAction(s: any, action: Action) {
    if (!action.id.startsWith('training-attack-')) return;
    if (this.memory.pending) this.finish(false, false);
    const n = s.nearbyNpcs?.find((n: any) => n.index === action.fields?.npcIndex), siteId = action.fields?.trainingSite;
    if (!n || !this.monster(n) || !this.memory.sites[siteId]) return;
    this.memory.pending = { siteId, index: n.index, monsterId: n.id, life: s.player.lifeId, tick: s.tick, context: context(s, this.ranged), xp: 0, ticks: 0, damage: 0, food: 0, ammo: 0, confirmedKill: false };
  }
  afterAction(before: any, after: any, action: Action) {
    const e = this.memory.pending;
    if (e) {
      const dead = after.player?.isDead || after.player?.lifeId !== e.life || Number(after.player?.respawnCount ?? 0) > Number(before.player?.respawnCount ?? 0);
      const reset = after.tick < before.tick;
      if (!dead && !reset) {
        e.xp += Math.max(0, xp(after) - xp(before)); e.ticks += Math.max(0, after.tick - before.tick);
        const eventDamage = (after.combatEvents ?? []).filter((v: any) => v.tick > before.tick && v.tick <= after.tick && v.type === 'damage_taken' && v.targetType === 'player').reduce((n: number, v: any) => n + Number(v.damage ?? 0), 0);
        e.damage += Math.max(eventDamage, Number(before.player.hp) - Number(after.player.hp), 0);
        e.food += Math.max(0, foodCount(before) - foodCount(after)); e.ammo += Math.max(0, ammo(before) - ammo(after));
      }
      const target = after.nearbyNpcs?.find((n: any) => n.index === e.index && n.id === e.monsterId);
      e.confirmedKill ||= target?.hp === 0;
      const fighting = after.player?.combat?.inCombat && after.player.combat.targetType === 'npc' && after.player.combat.targetIndex === e.index;
      if (dead || reset || action.type === 'retreat' || e.confirmedKill || (!fighting && after.tick > e.tick + 4)) this.finish(action.type === 'retreat', !!dead);
    }
    this.observe(after); this.save();
  }
  block(siteId: string, reason: string, duration = 5 * 60_000) {
    const site = this.memory.sites[siteId];
    if (!site) return;
    site.failures++; site.cooldownUntil = this.now() + duration; site.observationPasses = 0; delete site.emptySinceTick;
    if (this.memory.commitment?.siteId === siteId) delete this.memory.commitment;
    this.memory.status = { reason, siteId, retryAt: site.cooldownUntil };
    this.routeCache.clear(); this.save();
  }
  private async route(from: Tile, to: Tile, probe: RouteProbe) {
    const key = `${JSON.stringify(from)}>${JSON.stringify(to)}`;
    const cached = this.routeCache.get(key);
    if (cached && cached.until > this.now()) return cached.route;
    const route = await probe(from, to);
    if (route.status !== 'loading-map') this.routeCache.set(key, { until: this.now() + 30_000, route });
    if (this.routeCache.size > 128) this.routeCache.delete(this.routeCache.keys().next().value!);
    return route;
  }
  private score(site: Site, s: any, cost: number) {
    const m = this.catalog.monsters.find(m => m.id === site.monsterId)!;
    const stats = site.stats[context(s, this.ranged)];
    const prior = m.minSkill >= 20 ? 7 : m.hp >= 8 ? 4 : m.hp >= 5 ? 3 : 2;
    if (!stats?.ticks) return prior + (site.sightings ? .5 : 0) - cost / 80;
    // Shrink sparse observations towards a local prior. No guide XP/hour is
    // treated as a measurement, and a disappearing NPC is never called a kill.
    const weight = Math.min(1, stats.encounters / 3);
    const measured = stats.xp / stats.ticks * 4 - stats.damage / Math.max(1, stats.encounters) * .2 - stats.food / Math.max(1, stats.encounters) - stats.ammo / Math.max(1, stats.encounters) * .05 - stats.escapes * 4 - stats.deaths * 20;
    return prior * (1 - weight) + measured * weight - cost / 80;
  }
  async next(s: any, probe: RouteProbe): Promise<Action[]> {
    this.observe(s);
    if (this.economy) return [];
    if (!s.player || !validTile(at(s))) return [{ id: 'training-await-valid-state', type: 'wait', waitTicks: 5 }];
    // A short post-hit safety window is not evidence that every training site
    // is unavailable. Reobserve without imposing the global discovery cooldown.
    if (isThreatened(s)) return [{ id: 'training-await-combat-clear', type: 'wait', waitTicks: 2 }];
    if (this.memory.pending) {
      const e = this.memory.pending;
      if (e.life !== s.player.lifeId || s.tick < e.tick || s.tick > e.tick + 180) this.finish(false, e.life !== s.player.lifeId);
    }
    const now = this.now(), origin = at(s);
    const wait = (reason: string): Action[] => { this.memory.status = { reason, selectedSite: this.memory.commitment?.siteId, retryAt: this.memory.retryAt }; this.save(); return [{ id: 'training-observe-' + reason, type: 'wait', waitTicks: 5 }]; };
    if (this.memory.retryAt && now < this.memory.retryAt) return wait('discovery-cooldown');
    if (now - this.memory.exploration.window >= 10 * 60_000) this.memory.exploration = { window: now, trips: 0 };
    let candidates = Object.values(this.memory.sites).filter(site => {
      const m = this.catalog.monsters.find(m => m.id === site.monsterId);
      return m && site.cooldownUntil <= now && !trainingReadiness(s, m, this.ranged) && site.points.some(p => p.level === origin.level);
    });
    const requested=candidates.filter(site=>site.id==='black-knights-fortress');
    if(this.character==='clawscout' && requested.length)candidates=requested;
    const highestReadyTier = Math.max(0, ...candidates.map(site => site.combatLevel));
    const higherTierReady = highestReadyTier >= 5;
    const committedBefore = this.memory.commitment && this.memory.sites[this.memory.commitment.siteId];
    if (higherTierReady && committedBefore && committedBefore.combatLevel < highestReadyTier) delete this.memory.commitment;
    // Once a reviewed higher-tier source is viable, strongly prefer it over
    // measured chicken/cow efficiency. Keep lower-tier sites as fallbacks if
    // the stronger route is actually blocked or the source is empty.
    const tierBias = (site: Site) => higherTierReady && site.combatLevel === highestReadyTier ? 10_000 : 0;
    const viable = candidates.sort((a, b) => tierBias(b) + this.score(b, s, Math.min(...b.points.map(p => distance(origin, p)))) - tierBias(a) - this.score(a, s, Math.min(...a.points.map(p => distance(origin, p)))));
    const commitment = this.memory.commitment;
    const committed = viable.find(site => site.id === commitment?.siteId);
    const hold = committed && commitment && (now - commitment.since < 180_000 || commitment.encounters < 3) && now - commitment.since < 600_000;
    const ordered = hold ? [committed] : [...(committed ? [committed] : []), ...viable.filter(v => v !== committed)].slice(0, 8);
    const choices: { site: Site; point: Tile; cost: number; score: number }[] = [];
    let loading = false;
    for (const site of ordered) {
      // Two failed unknown trips still cap blind wandering, but reviewed
      // higher-tier guide sites remain eligible. Otherwise an agent can spend
      // its whole life on chickens/cows after exhausting the starter-area
      // discovery budget, even when its level and supplies justify Barbarian
      // Village as the next measured trial.
      if (!site.sightings && site.id !== commitment?.siteId && this.memory.exploration.trips >= 2 && site.combatLevel < 5) continue;
      // Freeze the small source-point itinerary for this visit. Re-sorting
      // by distance after each detour can switch sides of the same fence.
      const points = site.id === commitment?.siteId && commitment.approaches?.length ? commitment.approaches
        : [...site.points].sort((a, b) => distance(origin, a) - distance(origin, b)).slice(0, 3);
      const offset = site.observationPasses % points.length;
      for (const point of [...points.slice(offset), ...points.slice(0, offset)]) {
        const route = await this.route(origin, point, probe);
        if (route.status === 'loading-map') { loading = true; break; }
        if (route.status !== 'ready') continue;
        const cost = route.cost ?? 0;
      choices.push({ site, point, cost, score: tierBias(site) + this.score(site, s, cost) - (route.conditionalDoors ?? 0) * .15 }); break;
      }
      if (loading) break;
      if (!choices.some(c => c.site === site)) this.block(site.id, 'no-feasible-approach', 60_000);
    }
    if (loading) return wait('loading-map');
    if (!choices.length && hold && !this.memory.commitment) return this.next(s, probe);
    choices.sort((a, b) => b.score - a.score);
    let chosen = choices[0];
    const current = choices.find(c => c.site.id === commitment?.siteId);
    // After minimum residence, a small score fluctuation still cannot cause hopping.
    if (current && (hold || !chosen || chosen.score < current.score + 1.5)) chosen = current;
    if (!chosen) { this.memory.retryAt = now + 30_000; return wait('no-viable-reachable-site'); }
    const { site, point } = chosen;
    if (this.memory.commitment?.siteId !== site.id) {
      if (!site.sightings) this.memory.exploration.trips++;
      this.memory.commitment = { siteId: site.id, since: now, encounters: 0 };
    }
    this.memory.commitment!.approaches ??= [point, ...[...site.points].sort((a,b) => distance(origin,a) - distance(origin,b)).filter(p => distance(p,point) !== 0).slice(0,2)];
    this.memory.status = { selectedSite: site.id, source: site.source, guideIds: site.guideIds, routeCost: chosen.cost, score: chosen.score, predictedReachable: true, liveVerified: false };
    const target = (s.nearbyNpcs ?? []).filter((n: any) => this.monster(n)?.id === site.monsterId && n.hp !== 0 && n.reachable === true && n.inCombat !== true && Number(n.distance) <= 8 && n.optionsWithIndex?.some((o: any) => /^attack$/i.test(o.text)) && site.points.some(p => distance(p, { x: n.tileX ?? n.x, z: n.tileZ ?? n.z, level: s.player.level }) <= 20)).sort((a: any, b: any) => a.distance - b.distance)[0];
    if (target) {
      site.observationPasses = 0; delete site.emptySinceTick; this.save();
      return [{ id: `training-attack-${site.id}`, type: 'interactNpc', fields: { npcIndex: target.index, optionIndex: target.optionsWithIndex.find((o: any) => /^attack$/i.test(o.text)).opIndex, trainingSite: site.id }, waitTicks: 6 }];
    }
    const monster = this.catalog.monsters.find(m => m.id === site.monsterId)!;
    if (site.emptySinceTick !== undefined && s.tick < site.emptySinceTick) { site.emptySinceTick = s.tick; site.observationPasses = 0; }
    if (site.observationPasses >= 3) {
      if (s.tick - (site.emptySinceTick ?? s.tick) >= Math.min(90, monster.respawnTicks)) this.block(site.id, 'empty-or-unusable-site');
      return wait('bounded-respawn-window');
    }
    if (distance(origin, point) > 0) { this.save(); return [{ id: `training-travel-${site.id}`, type: 'walkTo', fields: { ...point, trainingSite: site.id, reason: 'Observe a source-compatible training site; arrival does not prove an encounter' }, waitTicks: 2 }]; }
    site.emptySinceTick ??= s.tick;
    if (site.lastObservationTick !== s.tick) { site.lastObservationTick = s.tick; site.observationPasses++; }
    if (site.observationPasses >= 3 && s.tick - site.emptySinceTick >= Math.min(90, monster.respawnTicks)) { this.block(site.id, 'empty-or-unusable-site'); return wait('site-observation-budget'); }
    this.save(); return wait('site-respawn-observation');
  }
}
