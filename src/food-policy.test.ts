import { describe, expect, test } from 'bun:test';
import { foodBankReserve, learnedFoodReserve, recordFoodExperience } from './food-policy';

const food = (count: number) => [{ name: 'Cooked fish', count, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }];

describe('learned food policy', () => {
  test('starts with a small probe instead of a fixed large inventory requirement', () => {
    expect(learnedFoodReserve(undefined)).toBe(1);
    expect(foodBankReserve(undefined)).toBe(8);
  });

  test('increases reserve from observed consumption and uses a larger PvP reserve', () => {
    expect(learnedFoodReserve({ encounters: 3, foodConsumed: 6 })).toBe(6);
    expect(learnedFoodReserve({ encounters: 3, foodConsumed: 6 }, true)).toBe(12);
  });

  test('records food used during a live combat action', () => {
    const memory: Record<string, number> = {};
    recordFoodExperience(memory, { inventory: food(4), player: { lifeId: 1 } }, { inventory: food(2), player: { lifeId: 1 } }, 'training-attack-goblins');
    expect(memory.encounters).toBe(1);
    expect(memory.foodConsumed).toBe(2);
  });
});
