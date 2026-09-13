export type ToolTier = {
  tier: number;
  metal: string;
  axeId: number;
  axeName: string;
  pickaxeId: number;
  pickaxeName: string;
  barId: number;
  barName: string;
  smithing: number;
  mining: number;
  woodcutting: number;
  primaryOre: number;
  primaryOreName: string;
  secondaryOre?: number;
  secondaryOreName?: string;
  secondaryCount: number;
};

// Derived from the local 2004 content. Pickaxes have no smithing rows in this
// server, so their route remains buy/drop/observed-source only; axes do have
// complete smithing recipes and are the first self-sufficient tool target.
export const TOOL_TIERS: readonly ToolTier[] = [
  { tier: 1, metal: 'bronze', axeId: 1351, axeName: 'Bronze axe', pickaxeId: 1265, pickaxeName: 'Bronze pickaxe', barId: 2349, barName: 'Bronze bar', smithing: 1, mining: 1, woodcutting: 1, primaryOre: 436, primaryOreName: 'Copper ore', secondaryOre: 438, secondaryOreName: 'Tin ore', secondaryCount: 1 },
  { tier: 2, metal: 'iron', axeId: 1349, axeName: 'Iron axe', pickaxeId: 1267, pickaxeName: 'Iron pickaxe', barId: 2351, barName: 'Iron bar', smithing: 16, mining: 15, woodcutting: 1, primaryOre: 440, primaryOreName: 'Iron ore', secondaryCount: 0 },
  { tier: 3, metal: 'steel', axeId: 1353, axeName: 'Steel axe', pickaxeId: 1269, pickaxeName: 'Steel pickaxe', barId: 2353, barName: 'Steel bar', smithing: 31, mining: 30, woodcutting: 6, primaryOre: 440, primaryOreName: 'Iron ore', secondaryOre: 453, secondaryOreName: 'Coal', secondaryCount: 2 },
  { tier: 4, metal: 'mithril', axeId: 1355, axeName: 'Mithril axe', pickaxeId: 1273, pickaxeName: 'Mithril pickaxe', barId: 2359, barName: 'Mithril bar', smithing: 51, mining: 50, woodcutting: 21, primaryOre: 447, primaryOreName: 'Mithril ore', secondaryOre: 453, secondaryOreName: 'Coal', secondaryCount: 4 },
  { tier: 5, metal: 'adamant', axeId: 1357, axeName: 'Adamant axe', pickaxeId: 1271, pickaxeName: 'Adamant pickaxe', barId: 2361, barName: 'Adamantite bar', smithing: 71, mining: 70, woodcutting: 31, primaryOre: 449, primaryOreName: 'Adamantite ore', secondaryOre: 453, secondaryOreName: 'Coal', secondaryCount: 6 },
  { tier: 6, metal: 'rune', axeId: 1359, axeName: 'Rune axe', pickaxeId: 1275, pickaxeName: 'Rune pickaxe', barId: 2363, barName: 'Runite bar', smithing: 86, mining: 85, woodcutting: 41, primaryOre: 451, primaryOreName: 'Runite ore', secondaryOre: 453, secondaryOreName: 'Coal', secondaryCount: 8 },
] as const;

const total = (items: any[], id: number) => items.filter(i => i?.id === id).reduce((n, i) => n + Number(i.count ?? 1), 0);
const level = (s: any, name: string) => Number(s.skills?.find((x: any) => String(x.name).toLowerCase() === name)?.baseLevel ?? s.skills?.find((x: any) => String(x.name).toLowerCase() === name)?.level ?? 1);

export function bestToolTier(items: any[], family: 'axe' | 'pickaxe'): number {
  return Math.max(0, ...TOOL_TIERS.filter(t => total(items, family === 'axe' ? t.axeId : t.pickaxeId) > 0).map(t => t.tier));
}

export type ToolPlan = {
  finalAxe: ToolTier;
  desiredPickaxe: ToolTier;
  currentAxeTier: number;
  currentPickaxeTier: number;
  stage: ToolTier;
  stageIsAxe: boolean;
  needsMetalworking: boolean;
  reason: string;
};

export function toolPlan(s: any, bank: any[] = []): ToolPlan | undefined {
  const items = [...(s.inventory ?? []), ...(s.equipment ?? []), ...bank];
  const currentAxeTier = bestToolTier(items, 'axe');
  const currentPickaxeTier = bestToolTier(items, 'pickaxe');
  const woodcutting = level(s, 'woodcutting');
  const mining = level(s, 'mining');
  const finalAxe = [...TOOL_TIERS].reverse().find(t => woodcutting >= t.woodcutting) ?? TOOL_TIERS[0];
  const desiredPickaxe = [...TOOL_TIERS].reverse().find(t => mining >= t.mining) ?? TOOL_TIERS[0];
  const needsAxe = currentAxeTier < finalAxe.tier;
  const needsPickaxe = currentPickaxeTier < desiredPickaxe.tier;
  if (!needsAxe && !needsPickaxe) return undefined;

  // First produce the next axe that the current Smithing level can make.
  // If Smithing has not reached that recipe yet, mine/smelt the bar tier that
  // advances Smithing rather than repeating Yew interactions with a weak axe.
  const smithing = level(s, 'smithing');
  const nextAxe = TOOL_TIERS.find(t => t.tier > currentAxeTier && t.tier <= finalAxe.tier && smithing >= t.smithing);
  // Train with a bar that is already unlocked, not the first locked recipe.
  // Mining is a separate prerequisite for a self-supplied smelting chain.
  const smeltLevels = [1,15,30,50,70,85];
  const oreLevels = [1,15,30,55,70,85];
  const trainingBar = [...TOOL_TIERS].reverse().find(t => smithing >= smeltLevels[t.tier-1]! && mining >= oreLevels[t.tier-1]!) ?? TOOL_TIERS[0];
  const nextMilestone = TOOL_TIERS.find(t => t.tier > currentAxeTier && smithing < t.smithing);
  const stage = nextAxe ?? trainingBar;
  const stageIsAxe = !!nextAxe;
  const reason = stageIsAxe
    ? `Craft ${stage.axeName} from ${stage.barName}; long-term target is ${finalAxe.axeName}`
    : `Mine and smelt ${stage.barName} to reach Smithing ${nextMilestone?.smithing ?? stage.smithing}, then craft ${finalAxe.axeName}`;
  return { finalAxe, desiredPickaxe, currentAxeTier, currentPickaxeTier, stage, stageIsAxe, needsMetalworking: needsAxe || needsPickaxe, reason };
}
