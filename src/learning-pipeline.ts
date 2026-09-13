export type VerifiedOutcome = {
  at: number;
  status: 'success' | 'partial' | 'failure' | 'interrupted';
  evidence: string[];
  reason?: string;
};

export type GoalRecord = {
  id: string;
  title: string;
  role: string;
  outcomes?: VerifiedOutcome[];
  learnings?: Array<{ lesson: string; behavior: string; confidence: string; uses?: number }>;
};

export type KnowledgeProposal = {
  key: string;
  title: string;
  evidence: string[];
  lesson: string;
  proposedChange: string;
  status: 'proposed';
};

const verified = (g: GoalRecord) => (g.outcomes ?? []).filter(o =>
  (o.status === 'success' || o.status === 'partial') &&
  o.evidence.some(e => /verified|xp|gold|drop|inventory|bank|explor/i.test(e))
);

/** Extracts only reviewed, productive goal results. It never treats a chat
 * message or an unverified explanation as knowledge. */
export function proposalsFromGoals(goals: GoalRecord[], limit = 3): KnowledgeProposal[] {
  const result: KnowledgeProposal[] = [];
  for (const goal of goals) {
    const outcomes = verified(goal);
    const learning = (goal.learnings ?? []).find(l => l.confidence === 'confirmed');
    if (!outcomes.length || !learning) continue;
    const evidence = outcomes.slice(-3).flatMap(o => o.evidence).slice(-6);
    const key = `${goal.id}:${learning.behavior}`.toLowerCase();
    if (result.some(p => p.key === key)) continue;
    result.push({
      key,
      title: `Proposed knowledge update: ${goal.title}`,
      evidence,
      lesson: learning.lesson,
      proposedChange: `Add to the appropriate shared knowledge reference: ${learning.behavior}. Require the listed evidence before treating this route or strategy as verified.`,
      status: 'proposed',
    });
    if (result.length >= limit) break;
  }
  return result;
}
