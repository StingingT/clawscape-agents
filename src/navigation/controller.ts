import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { distance, interrupted, type Tile } from './geometry';
import { isThreatened } from '../runtime-policy';
export const position = (s: any): Tile => ({ x: s.player.worldX, z: s.player.worldZ, level: s.player.level });
type Leg = { target: Tile; doors: any[] };
type RouteMemory = { from: Tile; to: Tile; legs: Leg[]; hash?: string; savedAt: number };
type Port = { state(): Promise<any>; act(type: string, fields: any): Promise<any>; wait(ticks: number): Promise<any> };
export class Navigator {
  private worker?: Worker;
  private ready = false;
  private readonly startupAt=Date.now();
  private fatal?: string;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private legs: Leg[] = [];
  private destination = '';
  private expected?: Tile;
  private life?: number;
  private blocked: Record<string, { until: number; reason: string }> = {};
  private routes: Record<string, RouteMemory> = {};
  private doors: { door: any; until: number }[] = [];
  private lastTick = 0;
  private recoveries = 0;
  private safeTrail: Tile[] = [];
  private escapeTarget?: Tile;
  private escapeLife?: number;
  constructor(private port: Port, private file: string, private planner?: (from: Tile, to: Tile, blocked: any[]) => Promise<any>, private questTravel=false) {
    if (existsSync(file)) { try { const old = JSON.parse(readFileSync(file, 'utf8')); this.blocked = old.blocked ?? {}; this.routes = old.routes ?? {}; this.doors = old.doors ?? []; this.escapeTarget = old.escapeTarget; this.escapeLife = old.escapeLife; this.destination = old.destination ?? ''; this.recoveries = old.recoveries ?? 0; } catch {} }
    if (planner) { this.ready = true; return; }
    this.worker = new Worker(new URL('./map-worker.ts', import.meta.url).href,{env:{...process.env}} as any);
    this.worker.onmessage = ({ data }) => {
      if (data.ready) { this.ready = true; return; }
      const p = this.pending.get(data.id); if (!p) return;
      this.pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data);
    };
    this.worker.onerror = event => { this.fatal = event.message; for (const p of this.pending.values()) p.reject(new Error(event.message)); this.pending.clear(); };
  }
  close() { this.worker?.terminate(); }
  async prepare(timeoutMs=60_000) {
    const deadline=Date.now()+timeoutMs;
    while(!this.ready) {
      if(this.fatal)throw new Error(this.fatal);
      if(Date.now()>=deadline)throw new Error('map-initialization-timeout');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }
  private async dispatch(type: string, fields: any) {
    const result = await this.port.act(type, fields);
    if (result?.success === false || result?.error) throw new Error(`dispatch-rejected: ${result.reason ?? result.error}`);
    return result;
  }
  blockedUntil(to: Tile) { return this.blocked[JSON.stringify(to)]?.until ?? 0; }
  private routeKey(from: Tile, to: Tile) { return `${JSON.stringify(from)}=>${JSON.stringify(to)}`; }
  private remembered(from: Tile, to: Tile): RouteMemory | undefined {
    const route = this.routes[this.routeKey(from, to)];
    if (!route || Date.now() - route.savedAt > 24 * 60 * 60_000 || !route.legs.length) return;
    if (distance(route.legs.at(-1)!.target, to) !== 0) return;
    return structuredClone(route);
  }
  private remember(from: Tile, to: Tile, plan: any) {
    if (!Array.isArray(plan?.legs) || !plan.legs.length || distance(plan.legs.at(-1)!.target, to) !== 0) return;
    this.routes[this.routeKey(from, to)] = { from, to, legs: structuredClone(plan.legs), hash: plan.hash, savedAt: Date.now() };
  }
  private async plan(from: Tile, to: Tile) {
    const id = ++this.sequence;
    this.doors = this.doors.filter(d => d.until > Date.now());
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        this.planner ? this.planner(from, to, this.doors.map(d => d.door)) : new Promise<any>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ id, from, to, blocked: this.doors.map(d => d.door), questTravel:this.questTravel }); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('planner-timeout')), 15_000); timer.unref(); }),
      ]);
    } finally { clearTimeout(timer!); this.pending.delete(id); }
  }
  // Read-only feasibility for semantic goal selection. It never declares live
  // arrival, mutates the active trip, or sends a game command.
  async assess(from: Tile, to: Tile) {
    if (this.fatal) return { status: 'blocked', reason: this.fatal };
    if (!this.ready) return Date.now()-this.startupAt>60_000?{status:'blocked',reason:'map-initialization-timeout'}:{ status: 'loading-map' };
    if (this.blockedUntil(to) > Date.now()) return { status: 'blocked', reason: 'route-cooldown' };
    try {
      const plan = await this.plan(from, to);
      if (distance(plan.legs.at(-1)?.target ?? from, to) !== 0) return { status: 'blocked', reason: 'partial-path' };
      if (plan.unmappedTiles > 0) return { status: 'blocked', reason: 'unverified-collision-coverage' };
      let previous = from, cost = 0;
      for (const leg of plan.legs) { cost += distance(previous, leg.target); previous = leg.target; }
      return { status: 'ready', cost, conditionalDoors: plan.legs.reduce((n: number, l: Leg) => n + l.doors.length, 0), hash: plan.hash };
    } catch (error) { return { status: 'blocked', reason: String(error) }; }
  }
  private record(status: string, state: any, extra: any = {}) {
    const record = { time: new Date().toISOString(), status, position: position(state), tick: state.tick, destination: this.destination, nextWaypoint: this.legs[0]?.target, blocked: this.blocked, routes: this.routes, doors: this.doors, escapeTarget: this.escapeTarget, escapeLife: this.escapeLife, recoveries: this.recoveries, ...extra };
    writeFileSync(this.file, JSON.stringify(record, null, 2));
    return { state, navigation: record };
  }
  private block(state: any, to: Tile, reason: string, movementDispatched=false) {
    this.blocked[JSON.stringify(to)] = { until: Date.now() + 60_000, reason };
    this.legs = [];
    return this.record('blocked', state, { reason, retryAfter: this.blockedUntil(to), movementDispatched });
  }
  async escape(state: any) {
    const at = position(state);
    if (state.player.isDead || (this.escapeLife !== undefined && this.escapeLife !== state.player.lifeId)) {
      this.escapeTarget = undefined; this.escapeLife = undefined; this.safeTrail = []; this.legs = []; this.expected = undefined;
      return this.record('interrupted', state, { reason: 'respawned' });
    }
    // Commit to the exterior road, never alternate between the last two tiles
    // inside the pen. The same collision/gate executor owns every retreat leg.
    const inChickenPen = (t: Tile) => t.level === 0 && t.x >= 3224 && t.x <= 3236 && t.z >= 3290 && t.z <= 3301;
    // Migrate old saved safe-trail targets which were still inside the enclosure.
    if (inChickenPen(at) && this.escapeTarget && inChickenPen(this.escapeTarget)) {
      this.escapeTarget = undefined; this.legs = []; this.expected = undefined;
    }
    if (at.level === 0 && at.x >= 3236 && at.x <= 3242 && at.z >= 3288 && at.z <= 3301
      && isThreatened(state)) {
      this.escapeTarget = { x: 3238, z: 3275, level: 0 };
    }
    this.escapeTarget ??= at.level === 0 && at.x >= 3224 && at.x <= 3236 && at.z >= 3290 && at.z <= 3301
      ? { x: 3238, z: 3295, level: 0 }
      : at.level === 0 && at.x >= 3076 && at.x <= 3094 && at.z >= 3229 && at.z <= 3247
        ? { x: 3094, z: 3226, level: 0 }
        : this.safeTrail.find(t => distance(at, t) >= 8 && distance(at, t) <= 48 && !inChickenPen(t));
    this.escapeLife = state.player.lifeId;
    // Aubury's mugger pocket has a known exterior bank road. A freshly
    // restarted controller may have no safeTrail; that must not mean stand still.
    if (!this.escapeTarget && at.level === 0 && at.x >= 3247 && at.x <= 3260 && at.z >= 3388 && at.z <= 3410)
      this.escapeTarget = {x:3254,z:3420,level:0};
    if (!this.escapeTarget) return this.record('interrupted', state, { reason: 'danger-no-verified-exit' });
    const trip = await this.step(this.escapeTarget, state, true);
    return { state: trip.state, navigation: { ...trip.navigation, escape: true } };
  }
  private interrupt(state: any, reason: string) {
    return reason === 'danger' ? this.escape(state) : Promise.resolve(this.record('interrupted', state, { reason }));
  }
  async step(to: Tile, initial: any, escaping = false) {
    let state = initial;
    if (this.fatal) return this.block(state, to, this.fatal);
    if (initial.player?.isDead) return this.record('interrupted', state, { reason: 'respawned' });
    if (!escaping && isThreatened(initial)) return this.escape(state);
    if (!escaping) { this.escapeTarget = undefined; this.escapeLife = undefined; }
    const interruption = (next: any) => {
      const reason = interrupted(initial, next);
      return escaping && reason === 'danger' ? undefined : reason;
    };
    if (!this.safeTrail.length) this.safeTrail.push(position(state));
    if (this.lastTick > initial.tick || (this.life !== undefined && this.life !== initial.player.lifeId)) { this.legs = []; this.expected = undefined; this.safeTrail = []; }
    this.lastTick = initial.tick; this.life = initial.player.lifeId;
    if (position(state).level !== to.level) return this.block(state, to, 'transition-required');
    if (distance(position(state), to) === 0) { this.legs = []; this.destination = JSON.stringify(to); return this.record('arrived', state); }
    if (this.blockedUntil(to) > Date.now()) return this.record('blocked', state, { reason: this.blocked[JSON.stringify(to)]?.reason, movementDispatched:false });
    if (!this.ready) { state = await this.port.wait(2); return this.record('loading-map', state, {movementDispatched:false}); }
    const key = JSON.stringify(to);
    if (key !== this.destination || !this.legs.length || (this.expected && distance(position(state), this.expected))) {
      if (key !== this.destination) this.recoveries = 0;
      this.destination = key;
      this.doors = this.doors.filter(d => d.until > Date.now());
      try {
        const from = position(state);
        const plan = this.remembered(from, to) ?? await this.plan(from, to);
        if (distance(plan.legs.at(-1)?.target ?? position(state), to) !== 0) return this.block(state, to, 'partial-path');
        if (plan.unmappedTiles > 0) return this.block(state, to, 'unverified-collision-coverage');
        this.remember(from, to, plan);
        this.legs = plan.legs;
        state = await this.port.state();
        const reason = interruption(state);
        if (reason) return this.interrupt(state, reason);
      } catch (error) { return this.block(state, to, String(error)); }
    }
    const leg = this.legs[0];
    if (!leg) return this.block(state, to, 'empty-route');
    try {
      // Open only live ordinary doors on an edge required by this leg.
      for (const door of leg.doors) {
        const loc = state.nearbyLocs?.find((l: any) => l.level === door.level && l.x === door.x && l.z === door.z && l.reachable && /^(gate|door|large door)$/i.test(l.name) && l.optionsWithIndex?.some((o: any) => /^open$/i.test(o.text)));
        if (!loc) continue;
        const option = loc.optionsWithIndex.find((o: any) => /^open$/i.test(o.text));
        await this.dispatch('interactLoc', { x: loc.x, z: loc.z, locId: loc.id, optionIndex: option.opIndex });
        let opened = false;
        for (let poll = 0; poll < 12; poll += 2) {
          state = await this.port.wait(2);
          const reason = interruption(state); if (reason) return this.interrupt(state, reason);
          const current = state.nearbyLocs?.find((l: any) => l.id === loc.id && l.x === loc.x && l.z === loc.z);
          if (!current || !current.optionsWithIndex?.some((o: any) => /^open$/i.test(o.text))) { opened = true; break; }
        }
        if (!opened) {
          this.doors.push({ door, until: Date.now() + 60_000 }); this.legs = []; this.expected = position(state);
          if (++this.recoveries > 2) return this.block(state, to, 'door-retry-budget');
          return this.record('replanning', state, { reason: 'door-did-not-open', movementDispatched:false });
        }
      }
      await this.dispatch('walkTo', { x: leg.target.x, z: leg.target.z, running: true });
      let previous = position(state), stationary = 0;
      for (let ticks = 0; ticks < 18; ticks += 2) {
        state = await this.port.wait(2);
        const reason = interruption(state); if (reason) return this.interrupt(state, reason);
        const current = position(state);
        if (distance(current, leg.target) === 0) {
          this.legs.shift(); this.expected = current;
          if (!escaping) { this.safeTrail.push(current); this.safeTrail = this.safeTrail.slice(-12); }
          return this.record(distance(current, to) === 0 ? 'arrived' : 'progress', state, {movementDispatched:true, completedWaypoint:leg.target});
        }
        stationary = distance(previous, current) === 0 ? stationary + 2 : 0;
        if (stationary >= 6) return this.block(state, to, 'no-progress',true);
        previous = current;
      }
      return this.block(state, to, 'leg-timeout',true);
    } catch (error) { return this.block(state, to, `dispatch: ${String(error)}`,true); }
  }
}
