import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Candidate } from '../agent-types.ts';
import { Director, createMemory } from './director.ts';
import type { Decision, Facts, Memory, Method, Observation, Opportunity } from './types.ts';

// The live controller remains responsible for collision-safe execution. This
// adapter gives the Director ownership of commitment, method preference and
// outcome learning without inventing commands that are absent from the live
// candidate set.
export type LiveCandidate = { id: string; type: string; fields?: Record<string, unknown>; waitTicks?: number };

function load(file: string, agent: string, world: string, revision: string): Memory {
  if (!existsSync(file)) return createMemory({ agent, world, revision });
  try { return JSON.parse(readFileSync(file, 'utf8')) as Memory; } catch { return createMemory({ agent, world, revision }); }
}

export class LiveAgency {
  readonly director: Director;
  private sequence = 0;
  constructor(private readonly file: string, agent: string, world: string, revision = 'live') {
    this.director = new Director(load(file, agent, world, revision));
    this.sequence = this.director.memory.sequence;
  }
  private save() { writeFileSync(this.file, JSON.stringify(this.director.memory, null, 2) + '\n'); }
  private method(candidate: LiveCandidate): Method {
    const domain = /attack|combat|retreat/i.test(candidate.type) ? 'combat' : /walk|scan/i.test(candidate.type) ? 'exploration' : /shop|bank|mine|chop|fish|cook|smith|fletch/i.test(candidate.id) ? 'gathering' : 'social';
    return { id: candidate.id, capability: `live:${candidate.type}`, domain, prerequisites: [], effects: { [`action:${candidate.id}`]: 1 }, costGp: 0, lossBoundGp: domain === 'combat' ? 1 : 0, durationMs: Math.max(1000, (candidate.waitTicks ?? 1) * 600), risk: domain === 'combat' ? 'bounded' : 'safe' };
  }
  choose(candidates: LiveCandidate[], facts: Facts, context: string, budget = { spendableGp: 1_000_000, maxLossGp: 1, maxDeaths: 0, maxDurationMs: 300_000 }): LiveCandidate | undefined {
    if (!candidates.length) return;
    const methods = candidates.map(c => this.method(c));
    const view: Observation = { agent: this.director.memory.agent, world: this.director.memory.world, revision: this.director.memory.revision, at: Date.now(), context, facts, budget, capabilities: methods.map(m => m.capability) };
    const opportunities: Opportunity[] = methods.map(m => ({ id: `live:${m.id}`, domain: m.domain, target: { fact: `action:${m.id}`, minimum: 1 }, reason: `Continue the currently executable ${m.id} action and measure its result.`, evidence: ['fresh live candidate'], source: 'need' }));
    const decision = this.director.next(view, opportunities, methods);
    this.save();
    if (decision.type !== 'execute') return;
    return candidates.find(c => c.id === decision.step.methodId);
  }
  begin(candidate: LiveCandidate, facts: Facts, context: string, budget = { spendableGp: 1_000_000, maxLossGp: 1, maxDeaths: 0, maxDurationMs: 300_000 }, commandId = `${this.director.memory.agent}-${Date.now()}-${candidate.id}`): string {
    const method = this.method(candidate);
    const view: Observation = { agent: this.director.memory.agent, world: this.director.memory.world, revision: this.director.memory.revision, at: Date.now(), context, facts, budget, capabilities: [method.capability] };
    const decision = this.director.next(view, [{ id: `live:${candidate.id}`, domain: method.domain, target: { fact: `action:${candidate.id}`, minimum: 1 }, reason: `Execute ${candidate.id}`, evidence: ['fresh live candidate'], source: 'need' }], [method]);
    if (decision.type !== 'execute') throw new Error(`AGENCY_BLOCKED:${decision.type}`);
    this.director.begin(view, decision, method, commandId);
    this.save();
    return commandId;
  }
  record(commandId: string, candidate: LiveCandidate, before: Facts, verified: boolean, evidence: string[], elapsedMs: number, spentGp = 0, lostGp = 0, deaths = 0): void {
    this.sequence = Math.max(this.sequence + 1, this.director.memory.sequence + 1);
    this.director.record({ commandId, sequence: this.sequence, status: verified ? 'verified' : 'rejected', at: Date.now(), facts: { ...before, [`action:${candidate.id}`]: verified ? 1 : 0 }, spentGp, lostGp, deaths, elapsedMs, evidence });
    this.save();
  }
}
