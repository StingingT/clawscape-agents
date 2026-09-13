import type { CandidateLike } from '../autonomy';

export type ActionGoalKind =
  | 'combat-training'
  | 'resource-gathering'
  | 'food-supply'
  | 'production'
  | 'equipment'
  | 'exploration'
  | 'rune-discovery'
  | 'service-preparation';

const id = (action: CandidateLike) => action.id.toLowerCase();

export function actionGoalKind(action: CandidateLike): ActionGoalKind {
  const value = id(action);
  if (/rune|essence|altar|mysteries/.test(value)) return 'rune-discovery';
  if (/resource-attack|feather|cowhide|gather|chop|mine-|fish-|cook-|economy-(wood|resource)/.test(value)) {
    return /fish|cook|food/.test(value) ? 'food-supply' : 'resource-gathering';
  }
  if (/training-|attack-|combat|black-knight|barbarian|goblin|monster|drop-target/.test(value)) return 'combat-training';
  if (/fletch|smelt|smith|bow|production|fire|craft/.test(value)) return 'production';
  if (/goal-|wield|equip|shield|weapon|armour|pickaxe|axe|tool/.test(value)) return 'equipment';
  if (/explore|survey|scan|waypoint|autonomy-(force|resume|map|world)/.test(value)) return 'exploration';
  if (/bank|shop|trade|close-|withdraw|deposit|open-|gate|door|walk|route|travel|heal|retreat|style|look|appearance|wait|talk/.test(value)) {
    return 'service-preparation';
  }
  return 'exploration';
}

export function isPreparationAction(action: CandidateLike): boolean {
  if (action.type === 'walkTo' && /autonomy-(explore|force|resume)/i.test(action.id)) return false;
  if (action.type === 'scanNearbyLocs' && /scan|survey|explore/i.test(action.id)) return false;
  return actionGoalKind(action) === 'service-preparation'
    || /^(walkTo|scanNearbyLocs|closeModal|closeShop|bankDeposit|bankWithdraw|useInventoryItem|setCombatStyle|wait|retreat|talkToNpc)$/.test(action.type);
}

export function isProductiveAction(action: CandidateLike): boolean {
  if (isPreparationAction(action)) return false;
  return /^(interactNpc|interactLoc|interactGroundItem|shopBuy|shopSell|pickupItem|equip|useInventoryItem)$/.test(action.type)
    || /^(training-|resource-|economy-|gather-|chop-|mine-|fish-|cook-|smelt-|smith-|fletch-|goal-|autonomy-attack)/.test(action.id);
}

export function goalTitle(kind: ActionGoalKind): string {
  return {
    'combat-training': 'Complete a verified combat trial',
    'resource-gathering': 'Complete a verified resource-gathering batch',
    'food-supply': 'Build or replenish a verified food supply',
    production: 'Complete a verified production batch',
    equipment: 'Complete one useful equipment progression step',
    exploration: 'Discover and verify a useful new route or activity',
    'rune-discovery': 'Discover and verify the next rune-production step',
    'service-preparation': 'Prepare the next productive activity',
  }[kind];
}

export function actionMatchesGoal(action: CandidateLike, kind: string | undefined): boolean {
  if (!kind) return true;
  return isPreparationAction(action) || actionGoalKind(action) === kind;
}

export function meaningfulGoalResult(before: any, after: any, action: CandidateLike, reward: number): boolean {
  if (!isProductiveAction(action)) return false;
  const xpChanged = JSON.stringify((before.skills ?? []).map((s: any) => [s.name, s.experience ?? 0]).sort())
    !== JSON.stringify((after.skills ?? []).map((s: any) => [s.name, s.experience ?? 0]).sort());
  const inventoryChanged = JSON.stringify([before.inventory ?? [], before.equipment ?? []])
    !== JSON.stringify([after.inventory ?? [], after.equipment ?? []]);
  const positionChanged = `${before.player?.worldX}:${before.player?.worldZ}:${before.player?.level}`
    !== `${after.player?.worldX}:${after.player?.worldZ}:${after.player?.level}`;
  if (action.type === 'interactNpc' && /attack|combat|training/i.test(action.id)) return xpChanged || inventoryChanged || reward > 0;
  if (/scan|explore|survey/.test(action.id)) return positionChanged || xpChanged || inventoryChanged;
  return xpChanged || inventoryChanged || reward > 0;
}
