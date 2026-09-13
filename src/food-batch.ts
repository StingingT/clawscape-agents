export type FoodBatch = { phase: 'gather' | 'cook' | 'bank'; startedAt: number };
export const rawFish = (i: any) => /^raw (shrimps|anchovies|sardines|herring|trout|salmon|tuna|lobster|swordfish)$/i.test(String(i.name));
export const bankFood = (i: any) => /^(shrimps|anchovies|sardines|herring|trout|salmon|tuna|lobster|swordfish|bread|cooked fish)$/i.test(String(i.name));
export function advanceFoodBatch(batch: FoodBatch, inventory: any[]): FoodBatch {
  const raw = inventory.some(rawFish);
  if (batch.phase === 'gather' && inventory.length >= 28) batch.phase = raw ? 'cook' : 'bank';
  if (batch.phase === 'cook' && !raw) batch.phase = 'bank';
  return batch;
}

// Only the observed doorway separating this shop's approach from Lowe.
// Do not open arbitrary nearby doors or climb the adjacent ladder.
export function loweDoor(s: any) {
  const npc = s.nearbyNpcs?.find((n: any) => /^lowe$/i.test(n.name));
  if (!npc || npc.reachable !== false) return [];
  const door = s.nearbyLocs?.find((l: any) => l.x === 3234 && l.z === 3426 && l.level === 0
    && /^door$/i.test(l.name) && l.reachable === true);
  const op = door?.optionsWithIndex?.find((o: any) => /^open$/i.test(o.text));
  return op ? [{id: 'open-lowes-door', type: 'interactLoc', fields: {locId: door.id, x: door.x, z: door.z, optionIndex: op.opIndex}, waitTicks: 2}] : [];
}
