import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type AnyState = Record<string, any>;
type Event = Record<string, any>;

const file = resolve(process.cwd(), 'data', 'shared-world-events.jsonl');

function objectKey(o: any): string {
  const kind = o.kind ?? 'loc';
  const id = o.id ?? o.contentId ?? 'unknown';
  const x = o.x ?? o.tileX ?? 0;
  const z = o.z ?? o.tileZ ?? 0;
  const level = o.level ?? o.plane ?? 0;
  return `${kind}:${id}:${x}:${z}:${level}`;
}

function emit(event: Event): void {
  appendFileSync(file, JSON.stringify({ schema: 1, at: new Date().toISOString(), ...event }) + '\n');
}

/** Persist stable names for otherwise generic scenery and nearby services. */
export function observeWorld(state: AnyState, character: string): void {
  const objects = [...(state.nearbyLocs ?? []), ...(state.nearbyNpcs ?? [])];
  for (const object of objects) {
    if (typeof object.x !== 'number' || typeof object.z !== 'number') continue;
    const aliases = [String(object.name ?? 'unknown').trim()].filter(Boolean);
    if (!aliases.length) continue;
    emit({ type: 'object-observation', character, objectId: objectKey(object), aliases,
      coordinates: { x: object.x, z: object.z, plane: object.level ?? state.player?.level ?? 0 },
      actions: (object.optionsWithIndex ?? []).map((o: any) => String(o.text ?? '')).filter(Boolean),
      reachable: object.reachable === true, evidence: 'fresh observation' });
  }
}

/** A route becomes shareable only after movement or verified arrival. */
export function recordRouteResult(before: AnyState, after: AnyState, action: AnyState, result: AnyState, character: string): void {
  if (action?.type !== 'walkTo') return;
  const from = { x: Number(before.player?.worldX), z: Number(before.player?.worldZ), plane: Number(before.player?.level ?? 0) };
  const to = { x: Number(action.fields?.x), z: Number(action.fields?.z), plane: Number(action.fields?.level ?? from.plane) };
  if (![from.x, from.z, to.x, to.z].every(Number.isFinite)) return;
  const moved = from.x !== Number(after.player?.worldX) || from.z !== Number(after.player?.worldZ);
  const arrived = result?.navigation?.status === 'arrived';
  if (!moved && !arrived) return;
  emit({ type: 'route-observation', character, routeId: `${from.x},${from.z},${from.plane}->${to.x},${to.z},${to.plane}`,
    from, to, confidence: arrived ? 'verified' : 'observed', evidence: [moved ? 'position changed' : '', arrived ? 'verified arrival' : ''].filter(Boolean) });
}

export function sharedWorldStats(): { events: number; file: string } {
  if (!existsSync(file)) return { events: 0, file };
  return { events: readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length, file };
}
