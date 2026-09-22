import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cliActionFields } from './cli-action-fields.ts';

test('game action boundary strips planner evidence from location interactions', () => {
  assert.deepEqual(cliActionFields('interactLoc', {
    x: 3187, z: 9825, locId: 356, optionIndex: 1,
    expectedEffect: 'access-clue', reason: 'safe experiment', surveyRouteId: 'local-probe',
  }), { x: 3187, z: 9825, locId: 356, optionIndex: 1 });
});

test('game action boundary fails closed for an unrecognised packet action', () => {
  assert.throws(() => cliActionFields('inventAction', { x: 1 }), /UNSUPPORTED_GAME_ACTION_TYPE/);
});
