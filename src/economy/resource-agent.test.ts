import {test,expect} from 'bun:test';
import {chooseResourceGoal,shouldBankResource} from './resource-agent';
test('no fixed feather or cowhide quota is selected without a supplied need',()=>{
  expect(chooseResourceGoal([],[])).toBe('resource-survey');
  expect(chooseResourceGoal([],[{name:'Feather',count:1}])).toBe('resource-survey');
});
test('a goal-derived resource need counts both personally known bank and inventory',()=>{
  expect(chooseResourceGoal([{name:'Feather',count:3}],[{name:'Feather',count:2}],{feathers:5,'cow-hides':2})).toBe('cow-hides');
  expect(chooseResourceGoal([],[],{feathers:12})).toBe('feathers');
});
test('banking batch size comes from the current plan rather than a fixed reserve',()=>{
  const stock=[{name:'Feather',count:10}];
  expect(shouldBankResource('feathers',stock)).toBe(false);
  expect(shouldBankResource('feathers',stock,10)).toBe(true);
  expect(shouldBankResource('feathers',stock,20)).toBe(false);
});
