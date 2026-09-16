#!/usr/bin/env bun
/** Read-only diagnostics. Never reads CLI authentication, full inventory, or historical lessons. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressHealth as semanticHealth } from '../src/agency/progress.ts';

const safe = (v: unknown) => typeof v === 'string'
  ? (/token|password|secret|authorization|api[_-]?key/i.test(v) ? '[redacted]' : v.slice(0, 400)) : v;
function read(file: string): any {
  if (!existsSync(file)) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_000_000) throw new Error('Unsupported diagnostic file: ' + file);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Invalid JSON in diagnostic file: ' + file); }
}
export function inspectProgress(file:string,now=Date.now()):unknown {
  const doc=read(file);
  return doc?.version===2?semanticHealth(doc.memory??{},now):undefined;
}
export function inspectAgency(root: string, now = Date.now()): unknown[] {
  const supervisor = read(join(root, 'data/supervisor/status.json'));
  return [['clawscout','online'],['stinger','stinger'],['coincrafter','coincrafter'],['featherer','featherer']].map(([agent,profile]) => {
    const directory = join(root,'data',profile!);
    const file = join(directory,'agency-v2.json'), current = read(file), recovery = read(join(directory,'legacy-recovery.json'));
    const known = current?.version === 2;
    const goal = known ? current.memory?.active : undefined;
    const observation=known?current.lastObservation:undefined;
    const health=known?semanticHealth(current.memory??{},now):undefined;
    const verifiedAt=health?.lastVerifiedActionAt??(known&&current.lastOutcome?.status==='verified'?current.lastOutcome.at:null);
    const objectiveAt=health?.lastObjectiveProgressAt??goal?.lastObjectiveProgressAt??null,supportAt=health?.lastSupportProgressAt??goal?.lastSupportProgressAt??null;
    const measurableAt=Math.max(objectiveAt??0,supportAt??0)||null;
    const ageMs=observation?.at===undefined?null:Math.max(0,now-observation.at);
    const progressHealth=known?{...health,stage:health?.stalled?'stalled':measurableAt!==null&&(!verifiedAt||measurableAt>=verifiedAt)?'measurable-progress'
        :verifiedAt!==null?'verified':current.receipt||current.safetyReceipt?'executing'
        :observation?.connected===true&&ageMs!==null&&ageMs<=120_000?'observing':'alive',
      connected:observation?.connected===true,ageMs,lastObservationAt:observation?.at??null,
      lastVerifiedOutcomeAt:verifiedAt,lastObjectiveProgressAt:objectiveAt,lastSupportProgressAt:supportAt,
      noProgressAttempts:goal?.noProgress??0,preparationOnlyStreak:goal?.preparationOnlyStreak??0}:undefined;
    return { agent, profile, source: file, process: supervisor?.agents?.[agent!]?.status ?? 'unknown',
      currentState: !current ? 'not-written' : known ? 'version-2' : 'unexpected-version',
      observationAgeSeconds: known && current.lastObservation?.at ? Math.max(0,Math.floor((now-current.lastObservation.at)/1000)) : null,
      progressHealth,
      lastObservation: known ? current.lastObservation : undefined,
      strategy: known && current.development ? {id:current.development.id,name:current.development.name,reason:safe(current.development.reason),sourceUrls:current.development.sourceUrls,levelCaps:current.development.levelCaps,protectedXp:current.development.protectedXp,trainingLeadIds:current.development.trainingLeadIds,alternatives:current.development.alternatives,review:current.development.review} : undefined,
      preparation: known ? current.preparation : undefined,
      buildReadiness: known ? current.buildReadiness : undefined,
      goal: goal ? {id:goal.id,target:goal.target,reason:safe(goal.reason),support:(goal.supportGoals??[]).slice(-8).map((s:any)=>({target:s.target,purpose:s.purpose,status:s.status,reason:safe(s.reason)})),
        supportCount:goal.supportGoals?.length??0,
        method:goal.plan?.steps?.[0]?.methodId,budget:goal.budget,
        lastObjectiveProgressAt:goal.lastObjectiveProgressAt,lastSupportProgressAt:goal.lastSupportProgressAt} : null,
      blocked: known ? safe(current.blocked) : undefined,
      pending: known && current.receipt ? {commandId:current.receipt.commandId,type:current.receipt.action?.type,startedAt:current.receipt.startedAt,investigation:current.receipt.investigation} : null,
      safetyPending: known && current.safetyReceipt ? {commandId:current.safetyReceipt.commandId,type:current.safetyReceipt.action?.type,startedAt:current.safetyReceipt.startedAt}:null,
      lastOutcome: known && current.lastOutcome ? {...current.lastOutcome,reason:safe(current.lastOutcome.reason),evidence:current.lastOutcome.evidence?.map(safe)} : undefined,
      legacy: {historicalOnly:true,ready:recovery?.ready??null,
        unresolved:recovery?.entries?.filter((e:any)=>e.disposition==='unresolved').map((e:any)=>({commandId:e.commandId,reason:safe(e.reason)}))},
    };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.length && (args.length!==2||args[0]!=='--root'||!args[1]?.trim()))throw new Error('Usage: bun scripts/agency-status.ts [--root DIRECTORY]');
    const root=args.length?resolve(args[1]!):resolve(dirname(fileURLToPath(import.meta.url)),'..');
    console.log(JSON.stringify({at:new Date().toISOString(),agents:inspectAgency(root)},null,2));
  } catch(error) { console.error(error instanceof Error?error.message:'Unable to inspect state');process.exitCode=1; }
}
