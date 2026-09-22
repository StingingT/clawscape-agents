import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePlan, type Director } from '../agency/director.ts';
import type { Catalogue } from '../agency/world-model.ts';
import { progressHealth } from '../agency/progress.ts';
import { AGENTS, agentName, HEARTBEAT_MS, digest, text, validObjective, type TeamSession, type WorkerSnapshot, type Agent } from './protocol.ts';
import { controlDir, readJson, writeJson, teamEnabled } from './storage.ts';
const workerRun = randomUUID();
const checkout = fileURLToPath(new URL('../../', import.meta.url));
export function workerMode(agent: string, env = process.env, now = Date.now()): 'unmanaged' | 'running' | 'paused' | 'stopped' {
  const root = env.CLAWSCAPE_TEAM_ROOT ?? checkout;
  if (!teamEnabled(root)) return env.CLAWSCAPE_TEAM_SESSION ? 'stopped' : 'unmanaged';
  if (!AGENTS.includes(agent as Agent)) return 'stopped';
  try {
    const s = readJson<TeamSession>(join(controlDir(root), 'session.json'));
    if (!s || s.version !== 1 || !s.active || s.id !== env.CLAWSCAPE_TEAM_SESSION || env.CLAWSCAPE_TEAM_AGENT !== agent
      || !Number.isFinite(s.at) || s.at > now || now - s.at > HEARTBEAT_MS) return 'stopped';
    return ['running', 'paused', 'stopped'].includes(s.modes[agent as Agent]) ? s.modes[agent as Agent] : 'stopped';
  } catch { return 'stopped'; }
}
export function checkWorkerStart(agent: string): void {
  if (['stopped', 'paused'].includes(workerMode(agent))) throw new Error('TEAM_CONTROLLER_OWNS_PROFILE: start it in the Clawscape panel');
}
export function checkWorkerDispatch(agent: string): void {
  if (['paused', 'stopped'].includes(workerMode(agent))) throw new Error('TEAM_DISPATCH_PAUSED_OR_STOPPED');
}
const saved = new Map<string, { at: number; receipt?: WorkerSnapshot['objectiveReceipt']; lastObjective?: string }>();
/** Preference handoff only. This cannot add actions, facts, prices, XP rules, or clear an unknown receipt. */
export function teamPlanning(c: Catalogue, d: Director, connected: boolean, pending: boolean, blocked?: string,
  env = process.env, now = Date.now(), apply = true, executorEpisode?:{failures:string[];recheckAt:number}): string | undefined {
  if (!env.CLAWSCAPE_TEAM_SESSION || !env.CLAWSCAPE_TEAM_ROOT) return;
  const agent = agentName(d.memory.agent), cacheKey = env.CLAWSCAPE_TEAM_ROOT+'|'+env.CLAWSCAPE_TEAM_SESSION+'|'+agent;
  const previous = saved.get(cacheKey) ?? { at: -Infinity };
  if(!apply&&now-previous.at<2000)return;
  const health = progressHealth(d.memory, now);
  // Plannable is not proof of successful gameplay. Include the registered first
  // step and costs; the executor still re-observes and authorizes every action.
  const family = (domain:string, fact:string, capability:string) =>
    domain + ':' + capability + ':' + (/^(visited:|discovered:)/.test(fact) ? fact.split(':')[0] : fact.replace(/:\d+(?=:|$)/g, ':#'));
  const candidatesAll = c.opportunities.flatMap(g => {
    const key=JSON.stringify([c.view.context,g.id,g.target.fact,String(g.target.minimum)]);
    if(!g.evidence.length||!g.reason.trim()||(d.memory.goalCooldowns[key]??0)>now)return [];
    const plan=makePlan(d.memory,c.view,g,c.methods),first=plan?.steps[0];
    if(!plan||!first)return [];
    return [{id:g.id,domain:g.domain,reason:text(g.reason),target:{...g.target},source:g.source,
      plan:{family:family(g.domain,g.target.fact,first.capability),firstMethodId:first.methodId,
        capability:first.capability,registered:c.tasks.has(first.methodId),steps:plan.steps.length,
        durationMs:plan.durationMs,costGp:plan.costGp,lossBoundGp:plan.lossBoundGp}}];
  });
  // Keep different approaches visible rather than filling the budget with nearby
  // coordinate variants. This changes presentation only, not the worker's rules.
  const seen=new Set<string>(),diverse=candidatesAll.filter(g=>{if(seen.has(g.plan.family))return false;seen.add(g.plan.family);return true;});
  const candidates=[...diverse,...candidatesAll.filter(g=>!diverse.includes(g))].slice(0,24);
  const integrity=/INTEGRITY|PROTECTED|THREAT|STALE|UNKNOWN|DEATH|RECONCIL|QUARANTIN|SAFETY|LIFE.*CHANG/i;
  const clearance=pending||d.memory.pending?'recovery':integrity.test(blocked??d.memory.active?.blocker?.reason??'')?'safety':'ready';
  const active=d.memory.active,capability=active?.plan?.steps[0]?.capability;
  const planning={version:1 as const,clearance:clearance as 'ready'|'recovery'|'safety',
    currentFamily:active&&capability?family(active.domain,active.target.fact,capability):undefined,
    unavailable:[...new Set(c.methods.filter(m=>!c.view.capabilities.includes(m.capability)).map(m=>m.capability))].slice(0,12)};
  const episode=executorEpisode&&{failures:[...new Set(executorEpisode.failures)].slice(0,3).map(x=>text(x,400)),recheckAt:executorEpisode.recheckAt};
  const s: WorkerSnapshot = { version: 1, agent, session: env.CLAWSCAPE_TEAM_SESSION, at: now, connected, pending,
    context: c.view.context, workerRun, planning, fingerprint: digest([c.view.context, workerRun, pending, d.memory.active?.id, candidates, planning, blocked, episode, health.stalled, health.lastProductiveAt]),
    // A planner may reach a terminal, evidence-backed decision before the
    // five-minute productivity timeout.  Exporting that as "not stalled"
    // makes the Overseer call an actually blocked worker "progressing" and
    // prevents bounded recovery/replanning.  Pending receipts remain a
    // recovery clearance, not a stall: their exact outcome must be reconciled
    // before any supervisor intervention.
    currentGoal: d.memory.active?.id, blocked: blocked ? text(blocked) : undefined,
    stalled: health.stalled || (blocked !== undefined && !pending),
    progressAt: health.lastProductiveAt ?? null, candidates, objectiveReceipt: previous.receipt,...(episode?{executorEpisode:episode}:{}) };
  let preferred: string | undefined;
  if (apply && workerMode(agent, env, now) === 'running') {
    const session = readJson<TeamSession>(join(controlDir(env.CLAWSCAPE_TEAM_ROOT), 'session.json'));
    const o = session?.objectives[agent];
    if (o) {
      if (!validObjective(o, s, now)) s.objectiveReceipt = { id: o.id, status: 'rejected', reason: 'Expired, changed context, or not currently plannable.' };
      else if (pending) s.objectiveReceipt = { id: o.id, status: 'waiting', reason: 'Reconcile the exact existing command first.' };
      else {
        preferred = o.goalId;
        // Never release an integrity blocker merely because a supervisor wants another goal.
        if (o.id !== previous.lastObjective && o.replace && health.stalled && d.memory.active && d.memory.active.id !== o.goalId
          && !/INTEGRITY|PROTECTED|THREAT|STALE|UNKNOWN|DEATH/i.test(d.memory.active.blocker?.reason ?? ''))
          d.deferCurrent(now, 'Temporary overseer preference: reconsider a stalled method.', [`team-objective:${o.id}`]);
        s.objectiveReceipt = { id: o.id, status: 'accepted', reason: 'Preference accepted; all existing execution guards still apply.' };
        previous.lastObjective = o.id;
      }
    }
  }
  if (now - previous.at >= 2000 || JSON.stringify(previous.receipt) !== JSON.stringify(s.objectiveReceipt)) {
    writeJson(join(controlDir(env.CLAWSCAPE_TEAM_ROOT), 'workers', agent + '.json'), s);
    previous.at = now; previous.receipt = s.objectiveReceipt; saved.set(cacheKey, previous);
  }
  return preferred;
}
