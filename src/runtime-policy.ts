export function dialogueOption(options: any[]): any | undefined {
  const valid = options.filter(o => Number.isInteger(o.index));
  return valid.find(o => /access my bank|bank account|cook all/i.test(o.text))
    ?? valid.find(o => /continue|^yes|cook/i.test(o.text)) ?? valid[0];
}
export function bankOption(options: any[]): any | undefined {
  return options.find(o => /^use-quickly$/i.test(o.text)) ?? options.find(o => /^bank$/i.test(o.text));
}
export const isFood = (item: any) => item.optionsWithIndex?.some((o: any) => /^eat$/i.test(o.text)) === true;
export function isThreatened(state: any): boolean {
  const combat = state.player?.combat;
  if (!combat) return false;
  const recentDamage = Number(combat.lastDamageTick) >= 0 && Number(state.tick) - Number(combat.lastDamageTick) <= 10;
  if (recentDamage) return true;
  if (!combat.inCombat) return false;
  if (combat.targetType === 'player') return true;
  const target = state.nearbyNpcs?.find((n: any) => n.index === combat.targetIndex);
  // The server also flags bank/fishing interactions as inCombat. Require an
  // attackable target or recent damage before interrupting a peaceful task.
  return target?.optionsWithIndex?.some((o: any) => /^attack$/i.test(o.text)) === true;
}
export function harvestLevel(name: string): number {
  return ({ tree: 1, oak: 15, willow: 30, maple: 45, yew: 60, 'magic tree': 75 } as Record<string, number>)[name.toLowerCase()] ?? Infinity;
}
// The server compares the arrow's levelrequire with the BOW's levelrequire,
// not just the character's Ranged level (player_ranged_check_ammo).
export function bowArrowCap(name: string): number {
  if (/^(shortbow|longbow)$/i.test(name)) return 2;
  if (/^oak (shortbow|longbow)$/i.test(name)) return 3;
  if (/^willow (shortbow|longbow)$/i.test(name)) return 4;
  if (/^maple (shortbow|longbow)$/i.test(name)) return 5;
  if (/^(yew|magic) (shortbow|longbow)/i.test(name)) return 6;
  return 0;
}
export function hasUsableArrows(bow: string, equipment: any[]): boolean {
  return equipment.some(i => {
    const metal = /^(bronze|iron|steel|mithril|adamant|rune) arrow/i.exec(i.name)?.[1]?.toLowerCase();
    const rank = ['bronze', 'iron', 'steel', 'mithril', 'adamant', 'rune'].indexOf(metal ?? '') + 1;
    return rank > 0 && rank <= bowArrowCap(bow) && Number(i.count) > 0;
  });
}
export function itemTotal(items: any[], id: number) { return items.filter(i => i.id === id).reduce((sum, i) => sum + i.count, 0); }
export function verifyBankTransfer(before: any, after: any, action: any) {
  const depositing = action.type === 'bankDeposit';
  const source = depositing ? before.inventory : before.bank?.items;
  const item = source?.find((i: any) => i.slot === action.fields.slot);
  if (!item || !before.bank?.isOpen || !after.bank?.isOpen) return false;
  const invDelta = itemTotal(after.inventory, item.id) - itemTotal(before.inventory, item.id);
  const bankDelta = itemTotal(after.bank.items, item.id) - itemTotal(before.bank.items, item.id);
  return invDelta + bankDelta === 0 && (depositing ? bankDelta > 0 : invDelta > 0);
}
