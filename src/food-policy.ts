export type FoodExperience = {
  maxObservedDamage?: number;
  encounters?: number;
  foodConsumed?: number;
  deaths?: number;
  escapes?: number;
};

export function foodCount(items: any[]): number {
  return items.filter((item) => item?.optionsWithIndex?.some((option: any) => /^eat$/i.test(option.text)))
    .reduce((total, item) => total + Number(item.count ?? 1), 0);
}

// Start with a one-item probe rather than a fixed stack. Increase the reserve
// only when live combat demonstrates that a longer trip actually needs it.
export function learnedFoodReserve(memory: FoodExperience | undefined, pvp = false): number {
  const encounters = Math.max(0, Number(memory?.encounters ?? 0));
  const consumed = Math.max(0, Number(memory?.foodConsumed ?? 0));
  const escapes = Math.max(0, Number(memory?.escapes ?? 0));
  const deaths = Math.max(0, Number(memory?.deaths ?? 0));
  const observedPerEncounter = encounters > 0 ? consumed / encounters : 0;
  const safetyMargin = deaths > 0 ? 2 : escapes > 0 ? 1 : 0;
  const learned = Math.max(1, Math.ceil(observedPerEncounter * 3 + safetyMargin));
  return pvp ? Math.max(learned * 2, 3) : learned;
}

export function foodBankReserve(memory: FoodExperience | undefined, pvp = false): number {
  const trip = learnedFoodReserve(memory, pvp);
  return Math.max(8, trip * 4);
}

export function recordFoodExperience(memory: FoodExperience, before: any, after: any, actionId: string): void {
  if (!/^training-attack-|^learn-drop-target-|^continue-combat|^escape-combat|^escape-encounter|^eat-/.test(actionId)) return;
  if (before.player?.lifeId === after.player?.lifeId) memory.maxObservedDamage = Math.max(memory.maxObservedDamage ?? 0,
    Math.max(0, Number(before.player?.hp ?? 0) - Number(after.player?.hp ?? 0)));
  memory.encounters = Number(memory.encounters ?? 0);
  memory.foodConsumed = Number(memory.foodConsumed ?? 0);
  memory.escapes = Number(memory.escapes ?? 0);
  memory.deaths = Number(memory.deaths ?? 0);
  if (/^training-attack-|^learn-drop-target-/.test(actionId)) memory.encounters++;
  // Count only a verified inventory decrease during an active food/combat
  // action; banking, dropping and unrelated item loss are not consumption.
  if (/^eat-|^training-attack-|^learn-drop-target-|^continue-combat|^escape-/.test(actionId)) {
    memory.foodConsumed += Math.max(0, foodCount(before.inventory ?? []) - foodCount(after.inventory ?? []));
  }
  if (/^escape-/.test(actionId)) memory.escapes++;
  if (after.player?.isDead === true || after.player?.lifeId !== before.player?.lifeId) memory.deaths++;
}
