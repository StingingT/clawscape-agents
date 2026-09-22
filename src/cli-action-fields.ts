/**
 * The planner keeps evidence and hypotheses alongside action fields.  The game
 * CLI deliberately accepts only its public packet shape, so the dispatcher
 * must remove controller metadata at this boundary.  This is an interface
 * capability, not a per-object workaround: every ordinary action receives the
 * same schema validation before it can leave the agent.
 */
const GAME_FIELDS: Readonly<Record<string, readonly string[]>> = {
  acceptCharacterDesign: [], bankDeposit: ['slot', 'amount'], bankWithdraw: ['slot', 'amount'],
  clickComponent: ['componentId'], clickComponentWithOption: ['componentId', 'optionIndex', 'slot'],
  clickDialogOption: ['optionIndex'], closeModal: [], closeShop: [], dropItem: ['slot'],
  interactGroundItem: ['x', 'z', 'itemId', 'optionIndex'], interactLoc: ['x', 'z', 'locId', 'optionIndex'],
  interactNpc: ['npcIndex', 'optionIndex'], interactPlayer: ['playerIndex', 'optionIndex'], none: [],
  pickupItem: ['x', 'z', 'itemId'], privateMessage: ['targetName', 'message'], randomizeCharacterDesign: [],
  say: ['message'], scanGroundItems: ['radius'], scanNearbyLocs: ['radius'],
  setCharacterDesign: ['gender', 'kits', 'colours'], setCombatStyle: ['style'], setTab: ['tabIndex'],
  shopBuy: ['slot', 'amount'], shopSell: ['slot', 'amount'],
  spellOnGroundItem: ['x', 'z', 'itemId', 'spellComponent'], spellOnItem: ['slot', 'spellComponent'],
  spellOnNpc: ['npcIndex', 'spellComponent'], spellOnPlayer: ['playerIndex', 'spellComponent'],
  submitCountDialog: ['value'], talkToNpc: ['npcIndex'], togglePrayer: ['prayerIndex'],
  useEquipmentItem: ['slot', 'optionIndex'], useInventoryItem: ['slot', 'optionIndex', 'interfaceId'],
  useItemOnItem: ['sourceSlot', 'targetSlot'], useItemOnLoc: ['itemSlot', 'x', 'z', 'locId'],
  useItemOnNpc: ['itemSlot', 'npcIndex'], wait: ['ticks'], walkTo: ['x', 'z', 'running'],
};

/** Return only the documented game fields. Unknown types fail closed. */
export function cliActionFields(type: string, fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const allowed = GAME_FIELDS[type];
  if (!allowed) throw new Error(`UNSUPPORTED_GAME_ACTION_TYPE:${type}`);
  const source = fields ?? {};
  return Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
