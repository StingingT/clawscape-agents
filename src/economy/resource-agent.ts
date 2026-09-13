export type ResourceGoal = 'feathers' | 'cow-hides' | 'resource-survey';

export const FEATHER_RESERVE = 500;
export const COWHIDE_RESERVE = 50;

export function countNamed(items: ReadonlyArray<{ name?: unknown; count?: unknown }>, pattern: RegExp): number {
  return items.reduce((total, item) => pattern.test(String(item.name ?? '')) ? total + Number(item.count ?? 1) : total, 0);
}

export function chooseResourceGoal(
  bank: ReadonlyArray<{ name?: unknown; count?: unknown }>,
  inventory: ReadonlyArray<{ name?: unknown; count?: unknown }>,
): ResourceGoal {
  const all = [...bank, ...inventory];
  if (countNamed(all, /^feather$/i) < FEATHER_RESERVE) return 'feathers';
  if (countNamed(all, /^cowhide$/i) < COWHIDE_RESERVE) return 'cow-hides';
  return 'resource-survey';
}

export function shouldBankResource(goal: ResourceGoal, inventory: ReadonlyArray<{ name?: unknown; count?: unknown }>): boolean {
  if (goal === 'feathers') return countNamed(inventory, /^feather$/i) >= 200;
  if (goal === 'cow-hides') return countNamed(inventory, /^cowhide$/i) >= 20;
  return inventory.length >= 27;
}
