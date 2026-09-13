import { expect, test } from 'bun:test';
import { isAgentClutter, isUrgentClutter, isBankableResource, isFinishedArrow, surplusArrowAmount } from './inventory-policy';

test('melee build banks runes, bows and unusable burnt food', () => {
  expect(isAgentClutter({ name: 'Air rune' }, 'melee')).toBe(true);
  expect(isAgentClutter({ name: 'Shortbow' }, 'melee')).toBe(true);
  expect(isAgentClutter({ name: 'Burnt fish' }, 'melee')).toBe(true);
  expect(isAgentClutter({ name: 'Bronze axe' }, 'melee')).toBe(false);
});

test('ranged build keeps its only bow but banks obsolete melee kit', () => {
  expect(isAgentClutter({ name: 'Shortbow' }, 'ranged-magic', [])).toBe(false);
  expect(isAgentClutter({ name: 'Shortbow' }, 'ranged-magic', ['Oak shortbow'])).toBe(true);
  expect(isAgentClutter({ name: 'Bronze sword' }, 'ranged-magic', ['Oak shortbow'])).toBe(true);
  expect(isAgentClutter({ name: 'Air talisman' }, 'ranged-magic', ['Oak shortbow'])).toBe(true);
});

test('finished arrows are banked only above the travel reserve', () => {
  expect(isFinishedArrow('Steel arrow')).toBe(true);
  expect(isFinishedArrow('Arrow shaft')).toBe(false);
  expect(surplusArrowAmount(45)).toBe(0);
  expect(surplusArrowAmount(125)).toBe(75);
});

test('fishing tools are not fish and survive a materials bank visit',()=>{
  for(const tool of ['Lobster pot','Small fishing net','Fly fishing rod','Harpoon','Tinderbox'])expect(isBankableResource(tool)).toBe(false);
  for(const material of ['Raw lobster','Lobster','Copper ore','Logs','Arrow shaft'])expect(isBankableResource(material)).toBe(true);
});

test('small rune drops wait for an ordinary bank visit while rune equipment is retained',()=>{
  expect(isAgentClutter({name:'Body rune'},'ranged-magic')).toBe(true);
  expect(isUrgentClutter({name:'Body rune',count:2},'ranged-magic',[],7)).toBe(false);
  expect(isUrgentClutter({name:'Body rune',count:2},'ranged-magic',[],24)).toBe(true);
  for(const build of ['melee','ranged-magic'])for(const name of ['Rune scimitar','Rune axe','Rune platebody'])expect(isAgentClutter({name},build)).toBe(false);
});
