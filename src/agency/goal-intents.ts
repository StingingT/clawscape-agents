/** A remembered map lead is knowledge, not an enduring instruction. */
import type { Catalogue, Knowledge, Route, LiveState } from './world-model.ts';
import type { Memory } from './types.ts';
export type RoutePurpose={kind:'resource'|'access'|'curiosity'|'operator';reason:string;evidence:string[];expiresAt:number};
export function legacySeed(route:Route):boolean {
  return route.origin==='legacy-seed'||/^(?:bundled route lead|documented lead);/i.test(String(route.evidence));
}
export function currentPurpose(route:Route,now:number):boolean {
  const p=route.purpose;
  return !!p&&['resource','access','curiosity','operator'].includes(p.kind)&&typeof p.reason==='string'&&p.reason.trim().length>0
    &&Array.isArray(p.evidence)&&p.evidence.some(e=>typeof e==='string'&&e.trim().length>0)
    &&Number.isFinite(p.expiresAt)&&p.expiresAt>now;
}
/** This is an administrative boundary, not permission to issue an action. Receipts are checked by LiveAgency. */
export function intentionReviewSafe(state:LiveState):boolean {
  return state.inGame===true&&!!state.player&&state.player.isDead!==true&&Number.isFinite(state.player.hp)&&state.player.hp>0
    &&state.player.combat?.inCombat!==true&&state.danger?.active!==true;
}
export function applyIntentPolicy(c:Catalogue,k:Knowledge,memory:Memory,now:number):string[] {
  const retired=new Set<string>();
  for(const route of Object.values(k.routes))if(legacySeed(route)&&!currentPurpose(route,now))retired.add('survey:'+route.id);
  const operator=(e:string[])=>e.some(x=>/operator|user-issued/i.test(x));
  const explicit=(id:string)=>c.opportunities.find(g=>g.id===id)?.evidence.some(e=>/operator|user-issued/i.test(e))
    ||memory.active?.id===id&&operator(memory.active.evidence);
  // A current, evidence-backed investigation may deliberately revisit a known seed location.
  // Its parent must actually be active and the investigated fact must match that parent's current purpose.
  const requested=memory.active?.requestedSupport;
  if(requested?.target.fact.startsWith('visited:')&&operator(requested.evidence))retired.delete('survey:'+requested.target.fact.slice(8));
  if(memory.active?.investigation&&operator(memory.active.investigation.evidence))retired.delete(memory.active.investigation.id);
  const investigation=memory.active?.investigation;
  if(investigation&&memory.active&&investigation.source==='investigation'&&investigation.reason.trim()
    &&investigation.investigates?.some(f=>[memory.active!.target.fact,memory.active!.requestedSupport?.target.fact].includes(f))
    &&investigation.evidence.some(e=>e.trim()&&!/^(?:bundled route lead|documented lead);/i.test(e)))retired.delete(investigation.id);
  for(const id of [...retired])if(explicit(id))retired.delete(id);
  c.opportunities=c.opportunities.filter(g=>!retired.has(g.id));
  c.methods=c.methods.filter(m=>!retired.has(m.id));
  for(const id of retired)c.tasks.delete(id);
  // Preserve legitimate exploration, including a newly justified visit to exactly the same place.
  for(const g of c.opportunities){const route=k.routes[g.id.replace(/^survey:/,'')];if(route?.purpose&&currentPurpose(route,now)){
    g.reason=route.purpose.reason;g.evidence=[...g.evidence,...route.purpose.evidence];
  }}
  c.retiredIntentIds=[...retired];return [...retired];
}
