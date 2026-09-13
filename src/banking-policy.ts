// Food belongs in the bank as a reserve, but a combat trip needs to retain
// its newly withdrawn food. Treating it like any other resource creates an
// immediate withdraw/deposit oscillation while the bank interface is open.
export function shouldDepositAtBank(name: string, inventoryFull: boolean, edible: boolean): boolean {
  if (!edible) return true;
  return inventoryFull;
}

export function shouldCloseAfterFoodWithdrawal(foodWithdrawalPending: boolean, hasFood: boolean): boolean {
  return foodWithdrawalPending && hasFood;
}
