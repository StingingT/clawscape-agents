export type Tile = { x: number; z: number; level: number };
export const distance = (a: Tile, b: Tile) => a.level === b.level ? Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) : Infinity;
export function validTile(t: Tile): boolean {
  return [t.x, t.z, t.level].every(Number.isInteger) && t.x >= 0 && t.z >= 0 && t.level >= 0 && t.level <= 3;
}
export function samples(a: Tile, b: Tile): Tile[] {
  if (!validTile(a) || !validTile(b) || a.level !== b.level) throw new Error('invalid-route-plane');
  const n = distance(a, b);
  return Array.from({ length: n + 1 }, (_, i) => ({ x: Math.round(a.x + (b.x - a.x) * i / Math.max(1, n)), z: Math.round(a.z + (b.z - a.z) * i / Math.max(1, n)), level: a.level }));
}
export function splitRoute(start: Tile, turns: Tile[], max = 12): Tile[] {
  if (max < 1) throw new Error('invalid-leg-size');
  const result: Tile[] = [];
  let from = start;
  for (const turn of turns) {
    const segment = samples(from, turn);
    for (let i = max; i < segment.length - 1; i += max) result.push(segment[i]!);
    if (distance(from, turn)) result.push(turn);
    from = turn;
  }
  return result;
}
export function interrupted(before: any, after: any): string | undefined {
  if (!after?.player) return 'missing-state';
  if (after.player.isDead || before.player.lifeId !== after.player.lifeId || before.player.respawnCount !== after.player.respawnCount) return 'respawned';
  if (before.player.level !== after.player.level) return 'plane-changed';
  if (after.player.hp < before.player.hp || isThreatened(after)) return 'danger';
  if (after.tick < before.tick) return 'session-reset';
}
import { isThreatened } from '../runtime-policy.ts';
