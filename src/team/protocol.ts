import { createHash } from 'node:crypto';
export const AGENTS = ['clawscout', 'stinger', 'coincrafter', 'featherer', 'astra'] as const;
export type Agent = typeof AGENTS[number];
export type Mode = 'running' | 'paused' | 'stopped';
export const HEARTBEAT_MS = 20_000;
export const SNAPSHOT_MS = 60_000;
export type PlanSummary = { family: string; firstMethodId: string; capability: string; registered: boolean; steps: number; durationMs: number; costGp: number; lossBoundGp: number };
export type Candidate = { plan?: PlanSummary; id: string; domain: string; reason: string; target: { fact: string; minimum: number }; source: string };
export type WorkerSnapshot = {
  version: 1; agent: Agent; session: string; at: number; context: string; fingerprint: string;
  connected: boolean; pending: boolean; currentGoal?: string; blocked?: string; stalled: boolean;
  candidates: Candidate[]; progressAt: number | null;
  /** Bounded controller evidence: these are failed abstract executor families,
   * not game commands and not a licence to synthesize one. */
  executorEpisode?: { failures: string[]; recheckAt: number };
  planning?: { version: 1; clearance: 'ready' | 'recovery' | 'safety'; currentFamily?: string; unavailable: string[] };
  workerRun?: string;
  objectiveReceipt?: { id: string; status: string; reason: string };
};
export type Objective = { id: string; agent: Agent; goalId: string; context: string; issuedAt: number; expiresAt: number; reason: string; replace: boolean };
export type TeamSession = { version: 1; id: string; pid: number; at: number; active: boolean; modes: Record<Agent, Mode>; objectives: Partial<Record<Agent, Objective>> };
export type TeamMessage = { version: 1; id: string; kind: 'objective' | 'status' | 'blocker' | 'discovery' | 'result' | 'help-request'; agent: Agent; at: number; summary: string; evidence?: string[] };
export function agentName(value: unknown): Agent {
  if (!AGENTS.includes(value as Agent)) throw new Error('UNKNOWN_TEAM_AGENT');
  return value as Agent;
}
export function text(value: unknown, max = 500): string {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max);
}
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function fresh(s: WorkerSnapshot | undefined, session: string, now = Date.now()): s is WorkerSnapshot {
  return !!s && s.version === 1 && AGENTS.includes(s.agent) && s.session === session && s.connected
    && Number.isFinite(s.at) && s.at <= now && now - s.at <= SNAPSHOT_MS
    && Array.isArray(s.candidates) && s.candidates.length <= 24 && typeof s.context === 'string'
    && s.candidates.every(c => typeof c.id === 'string' && c.id.length <= 400 && c.target && Number.isFinite(c.target.minimum))
    && (s.executorEpisode===undefined || Array.isArray(s.executorEpisode.failures) && s.executorEpisode.failures.length<=3
      && s.executorEpisode.failures.every(id=>typeof id==='string'&&id.length<=400) && Number.isFinite(s.executorEpisode.recheckAt));
}
export function validObjective(o: Objective, s: WorkerSnapshot, now = Date.now()): boolean {
  return o.agent === s.agent && o.context === s.context && Number.isFinite(o.issuedAt) && Number.isFinite(o.expiresAt)
    && o.issuedAt <= now && o.expiresAt > now && o.expiresAt - o.issuedAt <= 10 * 60_000
    && s.candidates.some(c => c.id === o.goalId) && typeof o.replace === 'boolean';
}
export function initialModes(): Record<Agent, Mode> {
  return Object.fromEntries(AGENTS.map(a => [a, 'stopped'])) as Record<Agent, Mode>;
}
