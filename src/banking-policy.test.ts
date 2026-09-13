import { expect, test } from 'bun:test';
import { shouldCloseAfterFoodWithdrawal, shouldDepositAtBank } from './banking-policy';

test('newly withdrawn food is kept once the bag has room', () => {
  expect(shouldDepositAtBank('Shrimps', false, true)).toBe(false);
});

test('food can still be deposited to free a genuinely full inventory', () => {
  expect(shouldDepositAtBank('Shrimps', true, true)).toBe(true);
  expect(shouldDepositAtBank('Raw shrimps', true, false)).toBe(true);
});

test('a completed food withdrawal closes the bank instead of redepositing the trip food', () => {
  expect(shouldCloseAfterFoodWithdrawal(true, true)).toBe(true);
  expect(shouldCloseAfterFoodWithdrawal(true, false)).toBe(false);
});
