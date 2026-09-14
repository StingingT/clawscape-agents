/** Pin item identity before the final refresh. A slot alone is not an item identity. */
export type ItemBinding = Array<{ slot: number; itemId: number }>;
type Candidate = { type: string; fields?: Record<string, any> };
export function bindItemAction(action: Candidate, state: Record<string, any>): ItemBinding {
  if (action.type !== 'useItemOnItem') return [];
  const fields = action.fields ?? {}, slots = [fields.sourceSlot ?? fields.itemSlot, fields.targetSlot];
  if (fields.sourceSlot !== undefined && fields.itemSlot !== undefined && fields.sourceSlot !== fields.itemSlot)
    throw new Error('AMBIGUOUS_ITEM_SOURCE_SLOT');
  const capacity = state.capacity ?? 28;
  if (!Number.isInteger(capacity) || !Array.isArray(state.inventory) || slots.some(s => !Number.isInteger(s) || s < 0 || s >= capacity) || slots[0] === slots[1])
    throw new Error('FRESH_DISTINCT_ITEM_SLOTS_REQUIRED');
  return slots.map(slot => {
    const rows = state.inventory.filter((i: any) => i.slot === slot);
    const item = rows[0];
    if (rows.length !== 1 || !Number.isSafeInteger(item.id) || item.id < 0
      || !Number.isSafeInteger(item.count) || item.count <= 0) throw new Error('FRESH_ITEM_TARGET_MISSING_OR_INVALID');
    return { slot, itemId: item.id };
  });
}
export function validateItemBinding(action: Candidate, state: Record<string, any>, expected: ItemBinding): void {
  const current = bindItemAction(action, state);
  if (current.length !== expected.length || current.some((i, n) => i.slot !== expected[n]?.slot || i.itemId !== expected[n]?.itemId))
    throw new Error('ITEM_IDENTITY_CHANGED_BEFORE_DISPATCH');
}
