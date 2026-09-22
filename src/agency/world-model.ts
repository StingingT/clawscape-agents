import type { RoutePurpose } from './goal-intents.ts';
import type { SourceTask } from './source-methods.ts';
import { itemFact, itemName } from './item-intents.ts';
import type { NeededItem, AcquisitionSource } from './acquisition.ts';
import { allowedTraining, guideTrainingTarget, strategyView, type Development } from './development.ts';
import type { BuildRules } from './build-rules.ts';
import { meaningfulFrontierRoute } from './reconciliation.ts';
import { preparation, emptyTrips, type TripLearning } from './trip-logistics.ts';
import { progressHealth, PROGRESS_TIMEOUT_MS } from './progress.ts';
import type { Domain, Facts, Identity, Memory, Method, Observation, Opportunity } from './types.ts';
import { plannerLearning, transitionInteractionUnavailable } from './planner-learning.ts';
import { observedGatheringAffordance } from './observed-gathering.ts';

export type LiveState = Record<string, any>;
export type TaskKind = 'food' | 'ammunition' | 'equipment' | 'bank' | 'combat' | 'production' | 'gathering' | 'exploration' | 'discovery' | 'funds' | 'prayer' | 'acquisition';
export type Route = { origin?:'legacy-seed'|'observed'|'source'; purpose?:RoutePurpose; id: string; x: number; z: number; level: number; evidence: string };
export type Task = { sourceResource?:SourceTask; acquisition?:{need:NeededItem;source:AcquisitionSource}; foodTarget?:number; id: string; kind: TaskKind; skill?: string; guideLeadIds?: string[]; route?: Route; target?: { fact: string; minimum: number } };
export type Policy = {
  reserveCoins: number; maxLossGp: number; maxDeaths: number; maxDurationMs: number;
  foodTarget: number; ammoTarget: number;
  /** Optional owner-audited replacement-loss ceiling for the carried kit. Missing is UNKNOWN, not zero. */
  combatLossBoundGp?: number;
};
export const defaultPolicy: Policy = {
  reserveCoins: 25, maxLossGp: 100, maxDeaths: 1, maxDurationMs: 30 * 60_000,
  foodTarget: 0, ammoTarget: 50,
};
// Local probing is deliberately limited, but the limit belongs to the area
// being investigated. A global timer made an agent that had safely examined two
// tiles in one enclosure wait ten minutes even after it reached new terrain.
// Sixteen tiles is a coarse exploration cell, not a world-specific route.
const LOCAL_PROBE_CELL_SIZE=16;
const LOCAL_PROBE_WINDOW_MS=10*60_000;
const localProbeCell=(x:number,z:number,level:number)=>`${Math.floor(x/LOCAL_PROBE_CELL_SIZE)}:${Math.floor(z/LOCAL_PROBE_CELL_SIZE)}:${level}`;
const localProbeReviewCell=(id:string)=>{
  const match=/^(?:survey:)?local-probe:(-?\d+):(-?\d+):(-?\d+)$/.exec(id);
  return match?localProbeCell(Number(match[1]),Number(match[2]),Number(match[3])):undefined;
};
/** A verified observed route is material map progress.  It can change the
 * reachable frontier in its coarse area, so old probe failures from before it
 * must not keep that entire area frozen.  A tiny local probe is deliberately
 * excluded: otherwise walking back and forth could continuously erase the
 * bounded-experiment budget. */
const observedSurveyReviewCell=(id:string)=>{
  const match=/^survey:observed:-?\d+:(-?\d+):(-?\d+):(-?\d+)$/.exec(id);
  return match?localProbeCell(Number(match[1]),Number(match[2]),Number(match[3])):undefined;
};
export type Catalogue = { intentPolicyEnabled?:boolean; retiredIntentIds?:string[]; discoveryRetryAt?:number; view: Observation; opportunities: Opportunity[]; methods: Method[]; tasks: Map<string, Task> };
export type RouteFailure = {at:number;retryAt:number;attempts:number;context:string;learningRevision:number;reason:string};
export type SurveyObservation = { at:number; tick:number; lifeId:number; context:string; learningRevision:number; failureAt?:number };
export type Knowledge = { routeFailures?:Record<string,RouteFailure>; surveyObservations?:Record<string,SurveyObservation>; bank: any[]; bankCheckedAt: number; routes: Record<string, Route>; visited: Record<string, string>;
  /** Local, verified environmental discoveries. These are learned facts, not seed routes. */
  discovered: Record<string,string>;
  interactions: Record<string,{name:string;id:number;x:number;z:number;level:number;option:string;at:number;evidence:string}>;
  /** Explicit game refusals learned from the agent's own post-action feedback.
   * They are temporary and context-scoped: a new tool, skill, quest state, or
   * learning revision makes the interaction eligible for reconsideration. */
  unavailableInteractions?:Record<string,{until:number;context:string;learningRevision:number;reason:string;at:number}>;
  /** A bounded family-level pause after an interaction's result cannot be
   * attributed from fresh observations.  This prevents nearby scenery from
   * consuming every replanning turn, without treating one unknown click as a
   * permanent map or capability failure. */
  discoveryHold?:{until:number;context:string;learningRevision:number;reason:string} };
export const emptyKnowledge = (): Knowledge => ({ bank: [], bankCheckedAt: 0, routes: {}, visited: {}, discovered: {}, interactions: {}, surveyObservations: {} });
const quantity = (i: any) => { const n = Number(i.count ?? 1); return Number.isSafeInteger(n) && n >= 0 ? n : NaN; };
const edible = (i: any) => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(String(o.text)));
/** Only advertise generic production when the fresh scene proves a safe first
 * step.  A broad "production batch" with no input, tool, facility, or live
 * production option is a planner fiction and can starve exploration/gathering.
 */
const observedProductionAffordance = (state:LiveState) => {
  const inv=state.inventory??[],locs=state.nearbyLocs??[];
  if(inv.some((i:any)=>(i.optionsWithIndex??[]).some((o:any)=>/^(?:cook|craft|fletch|smith|smelt|spin|string|make)$/i.test(String(o.text)))))return true;
  const adjacent=(pattern:RegExp)=>locs.some((l:any)=>pattern.test(String(l.name))&&localTransition(state,l)&&localDistance(state,l)<=1);
  if(inv.some((i:any)=>/^raw\b/i.test(String(i.name)))&&adjacent(/^(?:fire|fireplace|range|stove|cooking pot)$/i))return true;
  if(inv.some((i:any)=>/\blogs?$/i.test(String(i.name)))&&inv.some((i:any)=>/^knife$/i.test(String(i.name))))return true;
  return inv.some((i:any)=>/\b(?:ore|bar)\b/i.test(String(i.name)))&&adjacent(/^(?:furnace|anvil)$/i);
};
export const cash = (items: any[]) => items.filter(i => Number(i.id) === 995 || /^coins$/i.test(String(i.name)))
  .reduce((n, i) => n + quantity(i), 0);
export const food = (items: any[]) => items.filter(edible).reduce((n, i) => n + quantity(i), 0);
export const arrows = (items: any[]) => items.filter(i => /^(bronze|iron|steel|mithril|adamant|rune) arrows?$/i.test(String(i.name)))
  .reduce((n, i) => n + quantity(i), 0);
const XP = (state: LiveState, skill: string) => { const row=(state.skills??[]).find((s:any)=>String(s.name).toLowerCase()===skill); return Number(row?.experience??row?.xp??0); };
const base = (state: LiveState, skill: string) => Number((state.skills ?? []).find((s: any) => String(s.name).toLowerCase() === skill)?.baseLevel
  ?? (state.skills ?? []).find((s: any) => String(s.name).toLowerCase() === skill)?.level ?? 1);
const at = (state: LiveState, route: Route) => Number(state.player?.level) === route.level &&
  Math.max(Math.abs(Number(state.player?.worldX) - route.x), Math.abs(Number(state.player?.worldZ) - route.z)) <= 1;
export const discoveryFact = (loc:any, optionIndex:number) => `discovered:interaction:${Number(loc?.id)}:${Number(loc?.x)}:${Number(loc?.z)}:${Number(loc?.level??0)}:${optionIndex}`;
const localDistance=(state:LiveState,loc:any)=>Math.max(Math.abs(Number(state.player?.worldX)-Number(loc?.x)),Math.abs(Number(state.player?.worldZ)-Number(loc?.z)));
const localTransition=(state:LiveState,loc:any)=>Number(loc?.level??state.player?.level??0)===Number(state.player?.level??0)
  && (loc?.reachable===true || localDistance(state,loc)<=1);
const TRANSITION_OPTION=/^(open|climb(?:-up|-down)?|enter|cross)$/i;
// Navigation discovery may change access.  Resource/search actions belong to
// their owning gathering or quest executor and must not become fake routes.
// "Use" is not a reliable access verb in this client: it can open a bank or
// another service interface.  Keep navigation discovery to explicit movement
// verbs so a safe local experiment cannot accidentally become service UI work.
const DISCOVERY_OPTION=/^(open|climb(?:-up|-down)?|enter|cross)$/i;
const discoveryCandidates = (state:LiveState,k:Knowledge,now:number,learningRevision:number) => (state.nearbyLocs??[])
  .filter((loc:any)=>localTransition(state,loc)&&Number.isInteger(loc.id)&&Number.isInteger(loc.x)&&Number.isInteger(loc.z)
    // A discovery action is a local experiment, not authority to route across
    // unmodelled collision.  Longer travel belongs to a separately verified
    // survey route; this keeps a distant crate/door from becoming a fake
    // destination when an intervening obstruction is unknown.
    &&localDistance(state,loc)<=3
    &&(loc.optionsWithIndex??[]).some((o:any)=>DISCOVERY_OPTION.test(String(o.text)))
    &&!(k.discovered??{})[discoveryFact(loc,(loc.optionsWithIndex??[]).find((o:any)=>DISCOVERY_OPTION.test(String(o.text)))!.opIndex)]
    &&(()=>{const option=(loc.optionsWithIndex??[]).find((o:any)=>DISCOVERY_OPTION.test(String(o.text)))!;
      const unavailable=k.unavailableInteractions?.[discoveryFact(loc,option.opIndex)];
      return !unavailable||unavailable.until<=now||unavailable.context!==capabilityContext(state)||unavailable.learningRevision!==learningRevision;})())
  // Prefer observed transition actions.  Non-transition interactions are
  // not navigation evidence and cannot become a synthetic local route.
  .sort((a:any,b:any)=>Number(TRANSITION_OPTION.test(String((b.optionsWithIndex??[]).find((o:any)=>DISCOVERY_OPTION.test(String(o.text)))?.text)))
    -Number(TRANSITION_OPTION.test(String((a.optionsWithIndex??[]).find((o:any)=>DISCOVERY_OPTION.test(String(o.text)))?.text)))
    ||Number(a.distance??0)-Number(b.distance??0)||a.x-b.x||a.z-b.z).slice(0,8);

/** Actual personal state only. Duplicate unstackable inventory entries are summed. */
export function observeFacts(state: LiveState, knowledge: Knowledge): Facts {
  const inv = state.inventory ?? [], equipped = state.equipment ?? [];
  const bank = state.bank?.isOpen === true ? state.bank.items ?? [] : knowledge.bank;
  const facts: Facts = { hp: Number(state.player?.hp ?? 0), food: food(inv), arrows: arrows([...inv, ...equipped]),
    coins: cash(inv), 'free-slots': Math.max(0, Number(state.capacity??28) - inv.length),
    weapon: Number(equipped.some((i:any) => /sword|scimitar|bow|staff|mace|dagger|warhammer|battleaxe/i.test(String(i.name)))),
    axe: Number([...inv,...equipped].some((i:any) => / axe$/i.test(String(i.name)) && !/pickaxe|battleaxe/i.test(String(i.name)))),
    'xp:production': ['smithing','fletching','crafting'].reduce((n,k) => n + XP(state,k), 0),
    'xp:gathering': ['woodcutting','mining','fishing'].reduce((n,k) => n + XP(state,k), 0) };
  for(const i of inv){
    const n=quantity(i);facts[itemFact({id:i.id,name:i.name,minimum:1})]=(facts[itemFact({id:i.id,name:i.name,minimum:1})]??0)+n;
    const key='carried:name:'+itemName(i.name);facts[key]=(facts[key]??0)+n;
  }
  for (const s of state.skills ?? []) {
    const key = String(s.name).toLowerCase();
    facts['xp:' + key] = Number(s.experience ?? s.xp ?? 0);
    facts['level:' + key] = Number(s.baseLevel ?? s.level ?? 1);
  }
  for (const i of [...inv,...equipped,...bank]) facts['owned:' + i.id] = (facts['owned:' + i.id] ?? 0) + quantity(i);
  for (const [id] of Object.entries(knowledge.visited)) facts['visited:' + id] = 1;
  for (const id of Object.keys(knowledge.discovered??{})) facts[id] = 1;
  return facts;
}

/** Moving by a tile or consuming food must not reset learned method performance. */
export function capabilityContext(state: LiveState): string {
  return JSON.stringify([
    (state.skills ?? []).map((s:any) => [String(s.name).toLowerCase(), Math.floor(Number(s.baseLevel ?? s.level ?? 1) / 10)]).sort(),
    (state.equipment ?? []).map((i:any) => [Number(i.slot ?? -1), Number(i.id)]).sort((a:number[], b:number[]) => a[0]! - b[0]!),
    [...new Set([...(state.inventory??[]),...(state.equipment??[])].filter((i:any)=>/axe$|pickaxe$|fishing net|knife|tinderbox|hammer/i.test(String(i.name))).map((i:any)=>Number(i.id)))].sort(),
    Number(state.player?.level ?? 0),
    // A stale executor episode must not suppress a newly available safe UI
    // action. Bank/shop visibility materially changes what the executor can do.
    state.bank?.isOpen===true?'bank-open':state.shop?.isOpen===true?'shop-open':'interface-clear',
  ]);
}

export function observeKnowledge(state: LiveState, k: Knowledge, now: number, seedRoutes: Route[] = []): void {
  if (state.bank?.isOpen === true && Array.isArray(state.bank.items)) { k.bank = structuredClone(state.bank.items); k.bankCheckedAt = now; }
  for (const r of seedRoutes) if (Number.isInteger(r.x) && Number.isInteger(r.z) && Number.isInteger(r.level)) k.routes[r.id] ??= r;
  for (const r of Object.values(k.routes)) if (at(state, r)) k.visited[r.id] = `own-position:${state.player?.lifeId}:${state.tick}`;
  // A local route is evidence of a world transition, not a guess based on an
  // object's name.  Other usable objects remain available to the local discovery
  // system but do not become strategic survey destinations.
  for (const loc of state.nearbyLocs ?? []) {
    if (!Number.isInteger(loc.x) || !Number.isInteger(loc.z) || loc.reachable !== true) continue;
    const option=(loc.optionsWithIndex??[]).find((o:any)=>TRANSITION_OPTION.test(String(o.text)));
    if(!option)continue;
    const plane = Number(loc.level ?? state.player?.level ?? 0), id = `observed:${loc.id}:${loc.x}:${loc.z}:${plane}`;
    if (Object.keys(k.routes).length >= 1024 && !k.routes[id]) continue;
    const route={ id, x:loc.x, z:loc.z, level:plane, evidence:`own-transition:${state.player?.lifeId}:${state.tick}:${String(option.text).toLowerCase()}` };
    if(meaningfulFrontierRoute(route))k.routes[id]??=route;
  }
}

/** Goals are built from needs and observations BEFORE a low-level candidate is requested. */
export function buildCatalogue(identity: Identity, state: LiveState, k: Knowledge, policy: Policy,
  supported: TaskKind[], memory: Memory, now = Date.now(), development?: Development, buildRules?: BuildRules, trips?:TripLearning): Catalogue {
  const facts = observeFacts(state, k), tasks = new Map<string, Task>(), methods: Method[] = [], opportunities: Opportunity[] = [];
  const learned=plannerLearning(process.cwd(),identity.agent,now,capabilityContext(state));
  const evidence = [`own-state:${state.player?.lifeId}:${state.tick}`];
  const add = (task: Task, domain: Domain, fact: string, target: number, delta: number,
    reason: string, source: Opportunity['source'], prerequisites: Method['prerequisites'] = [], risk: Method['risk'] = 'safe') => {
    if (!supported.includes(task.kind)) return;
    tasks.set(task.id, task);
    const samples=memory.reviews.filter(r=>r.result==='success'&&r.goal.id===task.id&&r.goal.context===capabilityContext(state)).slice(-5);
    const measuredSpend=samples.length?samples.reduce((n,r)=>n+r.goal.spentGp,0)/samples.length:0;
    // Before a completed trip exists, zero means no PRE-AUTHORIZED purchase;
    // each actual purchase must still be quoted and charged at dispatch.
    methods.push({ id:task.id, capability:task.kind, domain, effects:{[fact]:delta}, prerequisites,
      progressFacts:task.kind==='gathering'?['xp:gathering']:undefined,
      costGp:measuredSpend, lossBoundGp:risk === 'bounded' ? policy.combatLossBoundGp ?? 0 : 0,
      durationMs:task.kind === 'exploration' && task.route ? Math.max(2_000,(Math.abs(Number(state.player?.worldX)-task.route.x)+Math.abs(Number(state.player?.worldZ)-task.route.z))*600) : 30_000, risk });
    if (task.kind!=='funds' && (facts[fact] ?? 0) < target) opportunities.push({ id:task.id, domain, target:{fact,minimum:target}, reason,
      evidence:task.route ? [task.route.evidence] : evidence, source,
      priority: ['food','ammunition','equipment','bank','funds'].includes(task.kind) ? 'maintenance' : 'strategic' });
  };
  add({id:'supply-food',kind:'food'}, 'gathering', 'food', policy.foodTarget, Math.max(1,policy.foodTarget),
    'Prepare the currently estimated trip food; revise this estimate from comparable trips, not a universal meal minimum.', 'need');
  if (/bow/i.test(String(state.combatStyle?.weaponName)) || arrows(state.inventory ?? []) > 0)
    add({id:'supply-ammunition',kind:'ammunition'},'crafting','arrows',policy.ammoTarget,policy.ammoTarget,
      'Maintain a compatible ammunition reserve before another ranged trial.', 'need');
  add({id:'equip-usable-weapon',kind:'equipment'},'combat','weapon',1,1,
    'Equip a personally owned usable weapon before attempting combat.', 'need');
  add({id:'free-inventory-space',kind:'bank'},'gathering','free-slots',1,Math.max(1,Number(state.capacity??28)-1),
    'Store surplus while retaining tools and essential supplies.', 'need');
  // Different skills are intentional opportunities with reasons. No permanent role-based level cap.
  const observedStyles=(state.combatStyle?.styles??[]).flatMap((s:any)=>s.trainsSkills??[]).map((n:any)=>String(n).toLowerCase());
  const skills = [...new Set<string>(observedStyles.filter((n:string)=>['attack','strength','defence','ranged','magic'].includes(n)))];
  for (const skill of skills) if (base(state,skill) < 99 && allowedTraining(development, [skill], state)) {
    const current = facts['xp:'+skill] ?? 0;
    const target = guideTrainingTarget(development,state,skill,buildRules);
    if(target===undefined || target<=current)continue;
    const reason = skill === 'defence'
      ? 'Develop Defence to support longer, safer encounters rather than remain permanently locked to the initial role.'
      : `Improve ${skill} through a bounded encounter trial and compare its observed costs.`;
    add({id:'train-'+skill,kind:'combat',skill,guideLeadIds:development?.trainingLeadIds},'combat','xp:'+skill,target,target-current,reason+ (development?.sourceUrls?.length?' Guide hypothesis: '+development.sourceUrls.join(', '):'')+(development?.history.length&&development.focus.includes(skill)?' '+development.reason:''),
      development?.history.length&&development.focus.includes(skill)?'unlock':'collection',
      [{fact:'food',minimum:trips?preparation(state,'combat',trips).foodTarget:policy.foodTarget},{fact:'weapon',minimum:1},
       ...(/bow/i.test(String(state.combatStyle?.weaponName)) ? [{fact:'arrows',minimum:15}] : [])],
      policy.combatLossBoundGp === undefined ? 'unknown' : 'bounded');
  }
  const prayerTarget=guideTrainingTarget(development,state,'prayer',buildRules);
  if (allowedTraining(development,['prayer'],state) && (state.inventory ?? []).some((i: any) => (i.optionsWithIndex ?? []).some((o: any) => /^bury$/i.test(String(o.text))))) {
    const current=Math.floor(facts['xp:prayer'] ?? 0),target=prayerTarget===undefined?current+1:Math.min(prayerTarget,current+1);
    if(target>current)add({id:'train-prayer',kind:'prayer',skill:'prayer'},'combat','xp:prayer',target,1,
      'Use a personally held incidental resource when its freshly observed action provides low-cost skill progress.', 'collection');
  }
  const bankCoins = state.bank?.isOpen === true && Array.isArray(state.bank.items) ? cash(state.bank.items) : 0;
  const knownBankCoins = state.bank?.isOpen === true ? bankCoins : cash(k.bank);
  if (knownBankCoins > 0) {
    const needed = Math.max(1, (memory.active?.requestedSupport?.target.minimum ?? policy.reserveCoins + 1) - facts.coins!);
    if (knownBankCoins >= needed) add({id:'access-verified-funds',kind:'funds'},'gathering','coins',facts.coins!+needed,needed,
      'Withdraw verified own bank coins for the selected preparation step, rather than spending imaginary funds.', 'need');
  }
  if(observedProductionAffordance(state)&&!learned.exhausted.has('production-batch'))add({id:'production-batch',kind:'production'},'crafting','xp:production',Math.floor(facts['xp:production']!/100)*100+100,100,
    'Complete a bounded production batch, obtaining the inputs through the supported production routine.', 'collection');
  const incidentalRaw=(state.inventory??[]).some((i:any)=>/^raw\b/i.test(String(i.name??'')));
  const adjacentHeat=(state.nearbyLocs??[]).some((l:any)=>Number.isInteger(l.x)&&Number.isInteger(l.z)&&/^(fire|fireplace|range|stove|cooking pot)$/i.test(String(l.name??''))&&Math.max(Math.abs(Number(state.player?.worldX)-Number(l.x)),Math.abs(Number(state.player?.worldZ)-Number(l.z)))<=1);
  if(incidentalRaw&&adjacentHeat)add({id:'incidental-process',kind:'production'},'crafting','xp:cooking',Math.floor(facts['xp:cooking']??0)+1,1,
    'Process an incidental carried resource when an observed nearby facility makes the secondary skill gain cheap.', 'collection');
  // Like production, a generic gathering batch must begin from a freshly
  // observed action or a resource that exposes a missing generic tool.  A
  // role preference alone is not evidence that an executable gathering step
  // exists in the current area.
  const gatheringAffordance=observedGatheringAffordance(state,base(state,'woodcutting'),Number(state.capacity??28));
  if(trips&&gatheringAffordance) {
    const cargo=preparation(state,'gathering',trips);
    facts['gathering:banked']=trips.bankedCargo??0;
    if(!learned.exhausted.has('gathering-batch'))add({id:'gathering-batch',kind:'gathering'},'gathering','gathering:banked',facts['gathering:banked']+Math.max(1,cargo.cargoSlots),Math.max(1,cargo.cargoSlots),
      'Gather a cargo-sized batch and bank the verified outputs; reserve tools and learned food, not arbitrary empty slots.', 'collection');
  } else if(gatheringAffordance&&!learned.exhausted.has('gathering-batch'))add({id:'gathering-batch',kind:'gathering'},'gathering','xp:gathering',Math.floor(facts['xp:gathering']!/100)*100+100,100,
    'Measure a complete gathering batch as an alternative to my previous activities.', 'collection', [{fact:'free-slots',minimum:1}]);
  // Count actual survey goal IDs (and legacy IDs), including unsuccessful probes.
  const probeCell=localProbeCell(Number(state.player?.worldX),Number(state.player?.worldZ),Number(state.player?.level));
  // Legacy IDs without coordinates remain conservatively global until expiry.
  // Coordinate-bearing probes consume only the current area's bounded budget.
  // Verified survey movement is reusable map progress, not a failed experiment.
  // Limit only unsuccessful probes, otherwise an explorer pauses after two
  // safe legs and never grows its personally verified route knowledge.
  // A probe that reached no executable step says nothing about whether this
  // area has been safely mapped.  Counting it as a failed spatial experiment
  // turns an executor-capability gap into a ten-minute exploration freeze.
  // Only a probe that actually attempted/reviewed an approach consumes the
  // local-navigation budget.
  const materialMapAdvanceAt=Math.max(0,...memory.reviews
    .filter(r=>r.result==='success'&&observedSurveyReviewCell(r.goal.id)===probeCell)
    .map(r=>r.at));
  const recentLocalProbeReviews=memory.reviews.filter(r=>/^(?:survey:)?local-probe:/.test(r.goal.id)&&r.result!=='success'
    &&!/no feasible (?:current )?executor step|fresh-no-executor|no concrete executor step/i.test(String(r.reason??''))&&now-r.at<LOCAL_PROBE_WINDOW_MS
    &&r.at>materialMapAdvanceAt
    &&(localProbeReviewCell(r.goal.id)===undefined||localProbeReviewCell(r.goal.id)===probeCell));
  const recentLocalProbes=recentLocalProbeReviews.length;
  const health=progressHealth(memory,now);
  const discoveryBootstrap=health.lastProductiveAt===null||health.stalled||!!memory.active?.blocker;
  const p=state.player;
  const safeProbeState=state.inGame===true&&!!p&&!p.isDead&&Number(p.hp)>0
    &&p.combat?.inCombat!==true&&state.danger?.active!==true;
  const localProbeBudget=learned.noveltyPressure?4:2;
  const probeEligible=(route:Route)=>safeProbeState&&(memory.active?.id==='survey:'+route.id
    ||discoveryBootstrap&&recentLocalProbes<localProbeBudget);
  if(discoveryBootstrap&&safeProbeState&&supported.includes('exploration')&&recentLocalProbes<localProbeBudget
    &&[p.worldX,p.worldZ,p.level].every(Number.isFinite)&&Object.keys(k.routes).filter(id=>id.startsWith('local-probe:')).length<128) {
    for(const [dx,dz] of [[3,0],[-3,0],[0,3],[0,-3]] as const) {
      const x=Number(p.worldX)+dx,z=Number(p.worldZ)+dz,level=Number(p.level),id=`local-probe:${x}:${z}:${level}`;
      if(k.routes[id]||k.visited[id])continue;
      k.routes[id]={id,x,z,level,evidence:`fresh-local-probe:${p.lifeId}:${state.tick}; collision verification required before movement`};
    }
  }
  for (const route of Object.values(k.routes).filter(r => meaningfulFrontierRoute(r) && r.level === Number(state.player?.level ?? 0) && !k.visited[r.id]
    // Previously generated routes must pass the same gate; generation-only gating leaks stale probes.
    && (!r.id.startsWith('local-probe:')||probeEligible(r))
    && (!k.routeFailures?.[r.id] || k.routeFailures[r.id]!.retryAt<=now || k.routeFailures[r.id]!.context!==capabilityContext(state) || k.routeFailures[r.id]!.learningRevision<(memory.learningRevision??0))).slice(0,64)) {
    const surveyId='survey:'+route.id;
    if(learned.exhausted.has(surveyId)||learned.exhausted.has(route.id))continue;
    const before=opportunities.length;
    add({id:surveyId,kind:'exploration',route},'exploration','visited:'+route.id,1,1,
       learned.noveltyPressure?'Known production/gathering routes are exhausted at this progress boundary; verify a different sourced frontier lead.':'Visit a sourced lead and verify it personally; path assessment and arrival are required.', learned.noveltyPressure?'unlock':'frontier');
    if(route.id.startsWith('local-probe:')&&opportunities.length>before)opportunities.at(-1)!.priority='maintenance';
  }
  if (supported.includes('discovery') && !k.discoveryHold) {
    for(const loc of discoveryCandidates(state,k,now,memory.learningRevision??0)) {
      const opt=(loc.optionsWithIndex??[]).find((o:any)=>DISCOVERY_OPTION.test(String(o.text)))!;
      const fact=discoveryFact(loc,opt.opIndex),discoveryId='discover:'+fact;
      // A confirmed missing transition-interaction executor applies to the
      // capability family, not just the first observed object coordinate. Keep
      // route/survey exploration available: it uses a different executor.
      if(learned.exhausted.has(discoveryId)||transitionInteractionUnavailable(learned))continue;
      add({id:discoveryId,kind:'discovery'},'exploration',fact,1,1,
        learned.noveltyPressure?'Core production/gathering routes are exhausted; test a different freshly observed transition or access clue with the existing safe executor.':'Test a nearby observed transition, obstruction, or safe access clue with a bounded interaction, then retain only the verified result.', learned.noveltyPressure?'unlock':'frontier');
    }
  }
  const completed=memory.reviews.filter(r=>r.result==='success').slice(-5);
  if(completed.length===5 && !completed.some(r=>r.goal.domain==='exploration') && facts.food!>=policy.foodTarget) {
    // A bounded survey periodically competes with training. It still needs a
    // sourced destination, a safe route and a complete affordable plan.
    for(const g of opportunities)if(g.source==='frontier')g.source='unlock';
  }
  const view: Observation = { ...identity, at:now, facts, context:capabilityContext(state),
    budget:{spendableGp:Math.max(0,cash(state.inventory??[])+bankCoins-policy.reserveCoins),maxLossGp:policy.maxLossGp,
      maxDeaths:policy.maxDeaths,maxDurationMs:policy.maxDurationMs}, capabilities:[...new Set(methods.map(m=>m.capability))],
    knowledgeRevision: memory.learningRevision ?? 0, strategy: strategyView(development),
    funding:{carriedGp:cash(state.inventory??[]),bankGp:bankCoins,reserveGp:policy.reserveCoins,evidence} };
  // Completed/poor trials affect later choices through the Director's method memory and cooldowns.
  // A bounded discovery cooldown is not missing implementation or a reason to
  // suppress normal productive opportunities. Surface its next eligibility.
  const budgetTimes=recentLocalProbeReviews.map(r=>r.at).sort((a,b)=>b-a);
  const probeBudget=learned.noveltyPressure?4:2;
  const budgetReadyAt=budgetTimes.length>=probeBudget?budgetTimes[probeBudget-1]!+LOCAL_PROBE_WINDOW_MS:now;
  const bootstrapReadyAt=discoveryBootstrap?now:(health.lastProductiveAt??now)+PROGRESS_TIMEOUT_MS;
  const nextProbeAt=Math.max(budgetReadyAt,bootstrapReadyAt);
  const discoveryRetryAt=supported.includes('exploration')&&safeProbeState&&nextProbeAt>now?nextProbeAt:undefined;
  return {view,opportunities,methods,tasks,discoveryRetryAt};
}
