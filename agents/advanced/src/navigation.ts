import { Tile } from "./contracts.ts";

const equal = (a: Tile, b: Tile) => a.x === b.x && a.z === b.z && a.plane === b.plane;
/** Consumes verified adjacent edges, not interpolated straight-line destinations.
 * A live collision planner + explicit doors/floor transitions remains release-gated. */
export class RouteFollower {
  private cursor = 0;
  private stalls = 0;
  private last: Tile | null = null;
  private history: string[] = [];
  constructor(readonly route: Tile[], readonly destination: Tile, readonly profile: string) {
    route.forEach(p => Tile.parse(p));
    Tile.parse(destination);
    if (!route.length || !equal(route.at(-1)!, destination)) throw new Error("PARTIAL_PATH");
    route.forEach((p,i) => {
      const prev = route[i-1];
      if (prev && (prev.plane !== p.plane || Math.max(Math.abs(p.x-prev.x), Math.abs(p.z-prev.z)) > 1)) {
        throw new Error("UNVERIFIED_EDGE_OR_TRANSITION");
      }
    });
  }
  step(position: Tile, profile: string, lifeChanged = false) {
    if (profile !== this.profile || lifeChanged) return { status: "BLOCKED", reason: "ROUTE_INVALIDATED" };
    if (position.plane !== this.destination.plane) return { status: "BLOCKED", reason: "TRANSITION_REQUIRED" };
    if (equal(position, this.destination)) return { status: "ARRIVED" };
    if (this.last && equal(position, this.last)) this.stalls++; else this.stalls = 0;
    const key = JSON.stringify(position);
    if (this.history.at(-1) !== key) this.history.push(key);
    this.history = this.history.slice(-6);
    const h = this.history;
    if (h.length >= 4 && h.at(-1) === h.at(-3) && h.at(-2) === h.at(-4)) return { status: "BLOCKED", reason: "OSCILLATION" };
    if (this.stalls >= 3) return { status: "BLOCKED", reason: "NO_PROGRESS" };
    this.last = position;
    if (this.route[this.cursor] && equal(position, this.route[this.cursor]!)) this.cursor++;
    const next = this.route[this.cursor];
    if (!next || Math.max(Math.abs(next.x-position.x), Math.abs(next.z-position.z)) > 1) return { status: "BLOCKED", reason: "OFF_ROUTE" };
    return { status: "PROGRESS", destination: next };
  }
}
