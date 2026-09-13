export type InventoryPolicyItem = { name?: unknown; count?: unknown };

const nameOf = (item: InventoryPolicyItem | string): string =>
  typeof item === 'string' ? item : String(item.name ?? '');

export function isBankableResource(name: string): boolean {
  // Tools can contain material names: a lobster pot is not a lobster.
  if (/^(lobster pot|.*fishing (net|rod)|harpoon|tinderbox|hammer|knife|chisel|shears)$/i.test(name)) return false;
  return /raw |shrimp|anchov|sardine|herring|trout|salmon|tuna|lobster|swordfish|logs?|ore|bar|rune essence|flax|wool|leather|hide|feather|herb|seed|gem|clay|bone|arrow shaft|headless arrow|arrowtips?|arrowheads?/i.test(name) &&
    !/axe|pickaxe|sword|scimitar|dagger|mace|shield|bow|staff|coin/i.test(name);
}

/** Items that are currently clutter for the agent's selected build. */
export function isAgentClutter(item: InventoryPolicyItem, build: string, equippedNames: string[] = [], keepWeaponName?: string): boolean {
  const name = nameOf(item);
  if (/burnt fish|air talisman/i.test(name)) return true;
  // ClawScout is melee-only for now; runes and bows are not part of his kit.
  if (build !== 'ranged-magic' && (/\brunes?$/i.test(name) || /bow/i.test(name))) return true;
  if (build !== 'ranged-magic' && /^(bronze|iron|steel|mithril|adamant|rune) (sword|scimitar|longsword|battleaxe|mace|dagger|warhammer)$/i.test(name)) {
    const equippedWeapon = equippedNames.some(e => /sword|scimitar|longsword|battleaxe|mace|dagger|warhammer/i.test(e));
    if (equippedWeapon || (keepWeaponName && name.toLowerCase() !== String(keepWeaponName).toLowerCase())) return true;
  }
  if (build === 'ranged-magic') {
    if (/bronze sword|wooden shield/i.test(name)) return true;
    // Keep a bow if it is the only available ranged weapon. Bank duplicates
    // once a bow is already equipped.
    if (/^shortbow$/i.test(name) && equippedNames.some(equipped => /bow/i.test(equipped))) return true;
    if (/\brunes?$/i.test(name)) return true;
  }
  return false;
}

export function isUrgentClutter(item: InventoryPolicyItem, build:string,equippedNames:string[],inventorySlots:number):boolean {
  if(!isAgentClutter(item,build,equippedNames))return false;
  // Small rune drops are deposited during a normal bank visit. One rune must
  // not abort an expedition and trigger another world-spanning round trip.
  if(/\brunes?$/i.test(nameOf(item))&&inventorySlots<24&&Number(item.count??1)<100)return false;
  return true;
}

export function isArrowMaterial(name: string): boolean {
  return /arrow shaft|headless arrow|arrowtips?|arrowheads?/i.test(name);
}

export function isFinishedArrow(name: string): boolean {
  return /^(bronze|iron|steel|mithril|adamant|rune) arrow$/i.test(name.trim());
}

export function surplusArrowAmount(totalArrows: number, reserve = 50): number {
  return Math.max(0, totalArrows - reserve);
}
