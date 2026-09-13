import { describe, expect, test } from 'bun:test';
import { actionGoalKind, actionMatchesGoal, isPreparationAction, meaningfulGoalResult } from './action-goal';

const candidate = (id: string, type = 'interactLoc') => ({ id, type, waitTicks: 1 });

describe('action-driven goal selection', () => {
  test('classifies productive work separately from service preparation', () => {
    expect(actionGoalKind(candidate('resource-attack-chicken-12', 'interactNpc'))).toBe('resource-gathering');
    expect(actionGoalKind(candidate('economy-bank-varrock-west', 'walkTo'))).toBe('service-preparation');
    expect(isPreparationAction(candidate('economy-bank-varrock-west', 'walkTo'))).toBe(true);
    expect(isPreparationAction(candidate('autonomy-explore-barbarians', 'walkTo'))).toBe(false);
  });

  test('keeps service actions inside the current goal but rejects unrelated productive work', () => {
    expect(actionMatchesGoal(candidate('bank-deposit-logs', 'bankDeposit'), 'resource-gathering')).toBe(true);
    expect(actionMatchesGoal(candidate('training-attack-goblin', 'interactNpc'), 'resource-gathering')).toBe(false);
  });

  test('requires a real result instead of combat engagement alone', () => {
    const before = { skills: [{ name: 'strength', experience: 100 }], inventory: [], equipment: [], player: { worldX: 1, worldZ: 1 } };
    const engaged = { ...before, player: { ...before.player, combat: { inCombat: true } } };
    const progressed = { ...before, skills: [{ name: 'strength', experience: 130 }] };
    expect(meaningfulGoalResult(before, engaged, candidate('training-attack-goblin', 'interactNpc'), 0)).toBe(false);
    expect(meaningfulGoalResult(before, progressed, candidate('training-attack-goblin', 'interactNpc'), 0.2)).toBe(true);
  });
});
