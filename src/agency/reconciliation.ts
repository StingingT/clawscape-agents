import type { LiveState, Route } from './world-model.ts';

const qty = (items: any[] | undefined, id: any) => (items ?? []).filter(i => String(i.id) === String(id))
  .reduce((n, i) => n + Number(i.count ?? 1), 0);
const carried = (state: LiveState) => [...(state.inventory ?? []), ...(state.equipment ?? [])];

/**
 * Nearby scenery is useful for collision/pathing, but not every tree or wall is a
 * destination worth turning into a support goal. Bundled/source routes remain valid;
 * observed routes are promoted only when their object name resembles a service,
 * transition, landmark, or deliberately interactive point of interest.
 */
export function meaningfulFrontierRoute(route: Route): boolean {
  if (!route.id.startsWith('observed:')) return true;
  const name = String(route.evidence.split(':').at(-1) ?? '').trim().toLowerCase();
  if (!name) return false;
  if (/^(tree|dead tree|oak|yew|willow|maple|bush|plant|fern|rock|wall|fence|hedge|henge|spear wall)$/i.test(name)) return false;
  return /bank|booth|chest|furnace|anvil|range|altar|shop|store|market|portal|entrance|exit|stairs|staircase|ladder|trapdoor|door|gate|bridge|tunnel|cave|dungeon|mine|guild|tower|castle|monastery|temple|dock|boat|ship|ferry|well|ruin|sign|lever|passage/i.test(name);
}

export type DeathReconciliation = {
  settled: boolean;
  evidence: string[];
  lostGp: number;
  itemLosses: Array<{ id: number | string; count: number; name?: string }>;
  reason: string;
};

/**
 * Reconcile a life change from directly observed carried state. Item losses are kept as
 * item deltas rather than invented GP values. Coin loss is the only monetary loss claimed.
 */
export function reconcileDeathLoss(before: LiveState, after: LiveState): DeathReconciliation {
  const fail = (reason: string): DeathReconciliation => ({ settled: false, evidence: [], lostGp: 0, itemLosses: [], reason });
  if (!before?.player || !after?.player || before.player.lifeId == null || after.player.lifeId == null || before.player.lifeId === after.player.lifeId) return fail('No life change to reconcile.');
  if (!Array.isArray(before.inventory) || !Array.isArray(before.equipment)
    || !Array.isArray(after.inventory) || !Array.isArray(after.equipment)) return fail('Complete pre/post inventory and equipment observations required.');
  if (after.inGame !== true || after.player.isDead === true || !(Number(after.player.hp) > 0)) return fail('Wait for a live post-respawn observation before reconciling losses.');
  for (const field of ['character', 'world', 'worldEpoch', 'profileId'])
    if (before[field] !== undefined && after[field] !== before[field]) return fail('Actor or world identity changed during death reconciliation.');

  const beforeItems = carried(before), afterItems = carried(after);
  if([...beforeItems,...afterItems].some(i=>i.id==null||!Number.isSafeInteger(Number(i.count??1))||Number(i.count??1)<0))return fail('Invalid accounting quantities.');
  if(!Number.isFinite(before.tick)||!Number.isFinite(after.tick)||after.tick<=before.tick)return fail('Fresh post-respawn state required.');
  const ids = new Set(beforeItems.map((i: any) => i.id));
  const itemLosses: DeathReconciliation['itemLosses'] = [];
  for (const id of ids) {
    const lost = qty(beforeItems, id) - qty(afterItems, id);
    if (lost <= 0) continue;
    const row = beforeItems.find((i: any) => String(i.id) === String(id));
    itemLosses.push({ id, count: lost, name: row?.name ? String(row.name) : undefined });
  }
  const coinRow = beforeItems.find((i: any) => Number(i.id) === 995 || /^coins$/i.test(String(i.name)));
  const coinId = coinRow?.id ?? 995;
  const lostGp = Math.max(0, qty(beforeItems, coinId) - qty(afterItems, coinId));
  const evidence = [
    `death-accounted:${before.player.lifeId}->${after.player.lifeId}`,
    ...itemLosses.slice(0, 6).map(i => `lost-item:${i.id}:${i.count}${i.name ? ':' + i.name : ''}`),
  ];
  if (itemLosses.length > 6) evidence.push(`additional-lost-item-kinds:${itemLosses.length - 6}`);
  if (itemLosses.some(i => String(i.id) !== String(coinId))) evidence.push('non-coin item losses recorded without inventing GP valuation');
  if (lostGp > 0) evidence.push(`observed-coin-loss:${lostGp}`);
  if (!itemLosses.length) evidence.push('no carried item loss observed after respawn');
  return { settled: true, evidence, lostGp, itemLosses,
    reason: 'Life change reconciled from observed pre-death and post-respawn carried state.' };
}
