import { expect, test } from 'bun:test';
import { chooseResourceGoal, shouldBankResource } from './resource-agent';

const items = (name: string, count: number) => [{ name, count }];

test('resource agent fills the feather reserve before switching resources', () => {
  expect(chooseResourceGoal([], [])).toBe('feathers');
  expect(chooseResourceGoal(items('Feather', 499), [])).toBe('feathers');
  expect(chooseResourceGoal(items('Feather', 500), [])).toBe('cow-hides');
});

test('resource agent keeps cow-hide collection bounded and surveys afterward', () => {
  expect(chooseResourceGoal([...items('Feather', 500), ...items('Cowhide', 49)], [])).toBe('cow-hides');
  expect(chooseResourceGoal([...items('Feather', 500), ...items('Cowhide', 50)], [])).toBe('resource-survey');
  expect(shouldBankResource('feathers', items('Feather', 200))).toBe(true);
  expect(shouldBankResource('cow-hides', items('Cowhide', 20))).toBe(true);
});
