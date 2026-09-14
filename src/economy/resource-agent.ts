export type ResourceGoal = 'feathers' | 'cow-hides' | 'resource-survey';

export type ResourceTargets = Partial<Record<Exclude<ResourceGoal,'resource-survey'>,number>>;

export function countNamed(items: ReadonlyArray<{ name?: unknown; count?: unknown }>, pattern: RegExp): number {
  return items.reduce((total, item) => pattern.test(String(item.name ?? '')) ? total + Number(item.count ?? 1) : total, 0);
}

export function chooseResourceGoal(
  bank: ReadonlyArray<{ name?: unknown; count?: unknown }>,
  inventory: ReadonlyArray<{ name?: unknown; count?: unknown }>,
  targets: ResourceTargets = {},
): ResourceGoal {
  const all = [...bank, ...inventory];
  if (countNamed(all, /^feather$/i) < (targets.feathers ?? 0)) return 'feathers';
  if (countNamed(all, /^cowhide$/i) < (targets['cow-hides'] ?? 0)) return 'cow-hides';
  return 'resource-survey';
}

export function shouldBankResource(goal: ResourceGoal, inventory: ReadonlyArray<{ name?: unknown; count?: unknown }>, batchLimit?:number): boolean {
  if (goal === 'feathers' && batchLimit!==undefined) return countNamed(inventory, /^feather$/i) >= batchLimit;
  if (goal === 'cow-hides' && batchLimit!==undefined) return countNamed(inventory, /^cowhide$/i) >= batchLimit;
  return inventory.length >= 27;
}
