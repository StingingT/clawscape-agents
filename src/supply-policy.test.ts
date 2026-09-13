import { expect, test } from 'bun:test';
import { mayPickpocketForAmmo } from './supply-policy';

test('allows a short, low-risk pickpocket experiment for ammunition funds', () => {
  expect(mayPickpocketForAmmo(8, 0)).toBe(true);
  expect(mayPickpocketForAmmo(8, 1)).toBe(true);
});

test('forces a supply route after two attempts or a nearly full inventory', () => {
  expect(mayPickpocketForAmmo(8, 2)).toBe(false);
  expect(mayPickpocketForAmmo(26, 0)).toBe(false);
});
