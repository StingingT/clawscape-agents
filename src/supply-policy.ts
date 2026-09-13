// A thief is a useful observed funding option, not a primary combat supply
// loop.  Preserve it as an experiment, but force an agent back to gathering
// or fletching before a failed streak can turn into a death spiral.
export function mayPickpocketForAmmo(inventorySlots: number, consecutiveAttempts: number): boolean {
  return inventorySlots < 26 && consecutiveAttempts < 2;
}
