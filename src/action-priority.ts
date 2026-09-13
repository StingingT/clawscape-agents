export function preferRangedSupply<T>(ranged: boolean, supplies: T[], fallback: T[]): T[] {
  return ranged && supplies.length > 0 ? supplies : fallback;
}
