import { describe, expect, test } from 'bun:test';
import { proposalsFromGoals } from './learning-pipeline';

describe('reviewed learning pipeline', () => {
  test('does not turn an unverified field note into knowledge', () => {
    expect(proposalsFromGoals([{ id: 'x', title: 'Mining', role: 'economy', learnings: [{ lesson: 'rocks are profitable', behavior: 'use mine', confidence: 'confirmed' }], outcomes: [{ at: 1, status: 'success', evidence: ['started action'] }] }])).toHaveLength(0);
  });
  test('creates a proposal only from a verified productive result', () => {
    const result = proposalsFromGoals([{ id: 'x', title: 'Mining', role: 'economy', learnings: [{ lesson: 'ore route produced XP', behavior: 'retain route', confidence: 'confirmed' }], outcomes: [{ at: 1, status: 'success', evidence: ['verified XP increase and inventory ore'] }] }]);
    expect(result[0]?.status).toBe('proposed');
    expect(result[0]?.evidence[0]).toContain('verified');
  });
});
