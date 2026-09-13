import {test,expect} from 'bun:test';
import {actionReady} from './action-cooldown';
test('repeated failures expire across persisted controller state',()=>{
  const saved=JSON.parse(JSON.stringify({count:200,until:500}));
  expect(actionReady(saved,499)).toBe(false);
  expect(actionReady(saved,500)).toBe(true);
  expect(actionReady(undefined,500)).toBe(true);
});
