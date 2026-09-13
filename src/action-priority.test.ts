import { expect, test } from 'bun:test';
import { preferRangedSupply } from './action-priority';

test('an archer restores a verified supply route before risky funding work', () => {
  expect(preferRangedSupply(true, ['make-arrows'], ['pickpocket'])).toEqual(['make-arrows']);
  expect(preferRangedSupply(false, ['make-arrows'], ['train-melee'])).toEqual(['train-melee']);
});
