import { test, expect } from 'bun:test';
import { dialogueOption, bankOption, bowArrowCap, hasUsableArrows, harvestLevel, isThreatened, verifyBankTransfer } from './runtime-policy';
test('an empty or incompatible quiver cannot start a bow fight', () => {
  expect(hasUsableArrows('Shortbow', [])).toBe(false);
  expect(hasUsableArrows('Shortbow', [{ name: 'Steel arrow', count: 10 }])).toBe(false);
  expect(hasUsableArrows('Shortbow', [{ name: 'Bronze arrow', count: 0 }])).toBe(false);
  expect(hasUsableArrows('Shortbow', [{ name: 'Bronze arrow', count: 10 }])).toBe(true);
});
test('basic bow cannot use steel arrows even with higher Ranged level', () => {
  expect(bowArrowCap('Shortbow')).toBe(2);
  expect(bowArrowCap('Oak shortbow')).toBe(3);
  expect(bowArrowCap('Unknown bow')).toBe(0);
});
test('fishing and banker targeting are not combat without damage', () => {
  const s = { tick: 100, player: { combat: { inCombat: true, targetType: 'npc', targetIndex: 7, lastDamageTick: -1 } }, nearbyNpcs: [{ index: 7, optionsWithIndex: [{ text: 'Net' }] }] };
  expect(isThreatened(s)).toBe(false);
  expect(isThreatened({ ...s, player: { combat: { ...s.player.combat, lastDamageTick: 99 } } })).toBe(true);
  expect(isThreatened({ ...s, nearbyNpcs: [{ index: 7, optionsWithIndex: [{ text: 'Attack' }] }] })).toBe(true);
});
test('a close unknown opponent may be a bounded combat trial', async () => {
  const { combatDisposition } = await import('./progression-policy');
  const s = { tick: 100, player: { combatLevel: 30, hp: 30, maxHp: 40, combat: { inCombat: true, targetType: 'npc', targetIndex: 7, lastDamageTick: 99 } }, inventory: [{ name: 'Cooked fish', count: 3, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] }], equipment: [{ name: 'Rune arrows', count: 20 }], combatStyle: { weaponName: 'Yew shortbow' }, nearbyNpcs: [{ index: 7, name: 'Black unicorn', combatLevel: 27, hp: 10, optionsWithIndex: [{ text: 'Attack', opIndex: 1 }] }] };
  expect(combatDisposition(s, false, true)).toBe('engaged');
});
test('bank dialogue uses observed one-based index, not zero', () => {
  expect(dialogueOption([{ index: 1, text: "I'd like to access my bank account, please." }, { index: 2, text: 'What is this place?' }]).index).toBe(1);
  expect(dialogueOption([{ index: 7, text: 'Click here to continue' }]).index).toBe(7);
  expect(dialogueOption([])).toBeUndefined();
});
test('bank prefers direct Use-quickly over conversational Use', () => {
  expect(bankOption([{ text: 'Use', opIndex: 1 }, { text: 'Use-quickly', opIndex: 2 }]).opIndex).toBe(2);
  expect(bankOption([{ text: 'Use', opIndex: 1 }])).toBeUndefined();
});
test('trees honor skill gates and unknown resource types are not guessed', () => {
  expect(harvestLevel('Oak')).toBe(15); expect(harvestLevel('Willow')).toBe(30); expect(harvestLevel('Yew')).toBe(60);
  expect(harvestLevel('Tree stump')).toBe(Infinity);
});
test('bank deposit requires matching inventory loss and bank gain', () => {
  const before = { inventory: [{ id: 1511, slot: 9, count: 12 }], bank: { isOpen: true, items: [] } };
  const action = { type: 'bankDeposit', fields: { slot: 9 } };
  expect(verifyBankTransfer(before, { inventory: [], bank: { isOpen: true, items: [{ id: 1511, count: 12 }] } }, action)).toBe(true);
  expect(verifyBankTransfer(before, { inventory: [], bank: { isOpen: true, items: [] } }, action)).toBe(false);
  expect(verifyBankTransfer(before, before, action)).toBe(false);
});
