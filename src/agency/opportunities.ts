import type { Facts, Opportunity, Requirement } from './types.ts';

export type Discovery = {
  needs: Array<{ id: string; domain: Opportunity['domain']; target: Requirement; reason: string; evidence: string[] }>;
  recipes: Array<{ id: string; outputFact: string; evidence: string[] }>;
  loot: Array<{ itemFact: string; monster: string; evidence: string[] }>;
  frontiers: Array<{ id: string; visitedFact: string; evidence: string[] }>;
  unlocks: Array<{ id: string; domain: Opportunity['domain']; target: Requirement; purpose: string; evidence: string[] }>;
  /** Receiving a report creates a verification goal, not its claimed underlying facts. */
  leads: Array<{ id: string; author: string; checkedFact: string; evidence: string[] }>;
};

/** Derive goals from needs and personally known content; no owner-authored task queue. */
export function discoverGoals(facts: Facts, known: Discovery): Opportunity[] {
  const goals: Opportunity[] = [];
  const add = (goal: Opportunity) => {
    if (goal.evidence.length && goal.reason.trim() && Number.isFinite(goal.target.minimum)
      && goal.target.minimum > (facts[goal.target.fact] ?? 0)) goals.push(goal);
  };
  for (const need of known.needs) add({ ...need, source: 'need' });
  for (const recipe of known.recipes) add({
    id: `collection:${recipe.id}`, domain: 'crafting', source: 'collection',
    target: { fact: recipe.outputFact, minimum: 2 },
    reason: 'Complete two personally owned copies of a known craftable item.', evidence: recipe.evidence,
  });
  const craftable = new Set(known.recipes.map(recipe => recipe.outputFact));
  for (const drop of known.loot) {
    if (craftable.has(drop.itemFact)) continue;
    add({ id: `loot:${drop.itemFact}`, domain: 'combat', source: 'collection',
      target: { fact: drop.itemFact, minimum: 1 }, evidence: drop.evidence,
      reason: `Expand my collection with an item not in my known recipes by testing ${drop.monster}.` });
  }
  for (const frontier of known.frontiers) add({
    id: `explore:${frontier.id}`, domain: 'exploration', source: 'frontier',
    target: { fact: frontier.visitedFact, minimum: 1 }, evidence: frontier.evidence,
    reason: 'Investigate a discovered frontier and record what is actually there.',
  });
  for (const unlock of known.unlocks) add({
    id: `unlock:${unlock.id}`, domain: unlock.domain, source: 'unlock',
    target: unlock.target, evidence: unlock.evidence, reason: unlock.purpose,
  });
  for (const lead of known.leads) add({
    id: `investigate:${lead.id}`, domain: 'exploration', source: 'investigation',
    target: { fact: lead.checkedFact, minimum: 1 }, evidence: lead.evidence,
    reason: `Check ${lead.author}'s report personally; the claim is not yet verified by me.`,
  });
  return [...new Map(goals.map(goal => [goal.id, goal])).values()];
}
