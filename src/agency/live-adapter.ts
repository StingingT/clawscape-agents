import { intentionReviewSafe } from './goal-intents.ts';
import type { SourceTask } from './source-methods.ts';
import { SourceResources } from './source-resources.ts';
import type { SourcePort } from './source-actions.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateBuildRules, type BuildRules } from './build-rules.ts';
import { chooseDevelopment, reviewDevelopment, developmentReadiness, guardDevelopment, protectedXpChanged, type Development } from './development.ts';
import { observeQuietStep, recordViability, retryAllowed, retryExhausted, stepKey, type QuietWindow, type Viability } from './step-retry.ts';
import { effectState, progressHealth, PROGRESS_TIMEOUT_MS } from './progress.ts';
import { meaningfulFrontierRoute, reconcileDeathLoss } from './reconciliation.ts';
import { conflictsWithQuarantine, quarantineEligible, releaseFromFreshAccounting, transactionIdentity,
  type QuarantinedTransaction } from './transaction-quarantine.ts';
import { addAcquisition, emptyAcquisition, observeAcquisitionSources, rememberAcquisitionSources, type AcquisitionMemory, type AcquisitionHint } from './acquisition.ts';
import type { DropLead } from './drop-leads.ts';
import { bindItems, resolveItems, itemFact, itemCount, type ItemNeed, type ItemRef } from './item-intents.ts';
import { randomUUID } from 'node:crypto';
import { teamPlanning } from '../team/worker.ts';
import { observeHistoricalContext, historicalWindowReady, historicalTraversal, type HistoricalWindow } from './historical-context.ts';
import { emptyTrips, preparation, observeTrip, recordTripEffect, type TripLearning, type TripPreparation } from './trip-logistics.ts';
import { Director, createMemory } from './director.ts';
import type { Decision, Identity, Memory, Method, Observation, Outcome } from './types.ts';
import { buildCatalogue, capabilityContext, cash, defaultPolicy, emptyKnowledge, observeFacts, observeKnowledge, discoveryFact,
  type Catalogue, type Knowledge, type LiveState, type Policy, type Route, type Task, type TaskKind } from './world-model.ts';

export type LiveCandidate = { sourceAuthorization?:string; approach?:{x:number;z:number;level:number}; itemRefs?:ItemRef[]; id: string; type: string; fields?: Record<string, any>; waitTicks?: number };
export type Selection = { decision: Extract<Decision,{type:'execute'}>; method: Method; task: Task; view: Observation };
export type Receipt = { sourceTask?:SourceTask; commandId:string; action:LiveCandidate; before:LiveState; startedAt:number; scope:'task'|'safety'; methodId?:string; approach?:{x:number;z:number;level:number}; execution?:{accepted?:boolean;phase?:string;navigation?:{status:string;reason?:string;movementDispatched?:boolean}}; stationary?:QuietWindow; historical?:HistoricalWindow; investigation?:{at:number;reason:string;quietSince?:number} };
type Document = { acquisition?:AcquisitionMemory; interruptions?:Array<{at:number;receipt:Receipt;reason:string}>; trips?:TripLearning; preparation?:TripPreparation; version:2; memory:Memory; knowledge:Knowledge; receipt?:Receipt; safetyReceipt?:Receipt;
  buildReadiness?:ReturnType<typeof developmentReadiness>; lastCommands:string[]; route?:{goalKey:string;methodId:string;action:LiveCandidate}; blocked?:string; development?:Development; updatedAt?:number;
  retries?:Record<string,Viability>; lastOutcome?:{at:number;commandId:string;type:string;status:string;reason?:string;evidence:string[]};
  losses?:Array<{at:number;commandId:string;lifeFrom:any;lifeTo:any;lostGp:number;items:Array<{id:number|string;count:number;name?:string}>}>;
  transactionQuarantine?:QuarantinedTransaction[];
  historicalRetirements?:Array<{at:number;commandId:string;receipt:Receipt;reason:string;evidence:string[];lossAttribution:'unknown'}>;
  /** A bounded record of distinct abstract plans which had no executable first
   * step. This is a controller capability signal, not a route blacklist. */
  executorEpisode?:{at:number;context:string;learningRevision:number;executorRevision:string;failures:string[];recheckAt:number};
  discoveryRetryAt?:number;
  lastObservation?:{at:number;tick?:number;connected?:boolean;position?:{x:number;z:number;level:number}} };
export type Verification = { historical?:boolean; recovery?:'investigate'; status:'verified'|'rejected'|'unknown'|'interrupted'; evidence:string[]; reason?:string };
export const BOUNDED_INTERACTION_RECONCILIATION_MS = 30_000;
export const EXECUTOR_EPISODE_MAX_FAILURES = 3;
export const EXECUTOR_EPISODE_RECHECK_MS = 2*60_000;
/** A visible acknowledgement screen is proof that the acknowledgement has not
 * taken effect.  It is neither a transaction nor a player-choice packet, so a
 * long exponential retry window is counterproductive: it strands the whole
 * agent behind an unchanged UI.  Keep a short, bounded re-observation gap so
 * we never hammer the server, then allow a fresh acknowledgement attempt. */
export const STATE_PROVEN_ACKNOWLEDGEMENT_RETRY_MS = 30_000;
/** Actions in this set neither move value nor commit a player choice.  Their
 * historical effect can therefore be retired after fresh observation instead
 * of keeping the whole controller in reconciliation forever. */
const BOUNDED_NON_TRANSACTIONAL_INTERACTIONS = new Set([
  'interactNpc','interactLoc','talkToNpc','pickupItem','useItemOnLoc',
  'acceptCharacterDesign',
]);
export function stateProvesAcknowledgementStillRequired(action:LiveCandidate,state:LiveState):boolean {
  // This is intentionally narrower than "modal open".  A generic modal may
  // be a bank, dialogue, confirmation, or another value-bearing flow.  The
  // same observed predicate that proposes the design acknowledgement is the
  // only one which can bypass an old retry record.
  return action.type==='acceptCharacterDesign'&&state.modalOpen===true
    &&(state.inventory??[]).length===0&&state.bank?.isOpen!==true
    &&state.shop?.isOpen!==true&&state.dialog?.isOpen!==true;
}
/** Retire only an old non-transactional interaction after a bounded fresh investigation.
 * The historical effect remains unknown. This never records success/failure and never replays the old command. */
export function boundedInteractionRetirement(receipt:Receipt,state:LiveState,now:number):Verification|undefined {
  if(!BOUNDED_NON_TRANSACTIONAL_INTERACTIONS.has(receipt.action.type)||!Number.isFinite(receipt.startedAt)
    ||now-receipt.startedAt<BOUNDED_INTERACTION_RECONCILIATION_MS||state.inGame!==true)return;
  const before=receipt.before.player,current=state.player;
  if(!before||!current||before.isDead||current.isDead
    ||![receipt.before.tick,state.tick,before.worldX,before.worldZ,before.level,current.worldX,current.worldZ,current.level].every(Number.isFinite)
    ||Number(state.tick)<=Number(receipt.before.tick)||current.lifeId!==before.lifeId)return;
  for(const field of ['character','world','worldEpoch','profileId'] as const)
    if((receipt.before as any)[field]!==undefined&&(receipt.before as any)[field]!== (state as any)[field])return;
  return {status:'interrupted',recovery:'investigate',
    reason:'BOUNDED_UNATTRIBUTED_INTERACTION: fresh 30-second investigation horizon exhausted; historical outcome remains unknown.',
    evidence:[`bounded-interaction-window:${receipt.startedAt}->${now}`,`fresh-ticks:${receipt.before.tick}->${state.tick}`,
      'Historical interaction outcome remains unknown; old command retired without replay.']};
}

const atomic = (file:string,value:unknown) => {
  mkdirSync(dirname(file),{recursive:true});
  const tmp=file+'.'+randomUUID()+'.tmp';
  writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600}); renameSync(tmp,file);
};

/** The Director selects an outcome FIRST. Registered task executors then propose actual actions. */
export class LiveAgency {
  readonly director:Director;
  readonly identity:Identity;
  readonly policy:Policy;
  private readonly file:string;
  private readonly supported:TaskKind[];
  private readonly routes:Route[];
  private readonly clock:()=>number;
  private document:Document;
  private readonly developmentHint?:string;
  private readonly buildRules?:BuildRules;
  private readonly dropLeads:DropLead[];
  private readonly acquisitionHints:AcquisitionHint[];
  private readonly executorRevision:string;
  private readonly observer = randomUUID();
  private readonly sourceResources?:SourceResources;
  constructor(file:string,identity:Identity,options:{sourceCatalogueRoot?:string;policy?:Partial<Policy>;supported:TaskKind[];routes?:Route[];
    dropLeads?:DropLead[];acquisitionHints?:AcquisitionHint[];preferences?:Memory['preferences'];now?:()=>number;developmentHint?:string;buildRules?:BuildRules;executorRevision?:string}) {
    this.dropLeads=options.dropLeads??[];this.acquisitionHints=options.acquisitionHints??[];
    this.file=file;this.identity={...identity};this.supported=options.supported;this.routes=options.routes??[];
    this.policy={...defaultPolicy,...options.policy};this.clock=options.now??Date.now;this.developmentHint=options.developmentHint;
    this.buildRules=options.buildRules?validateBuildRules(options.buildRules,identity):undefined;
    this.executorRevision=options.executorRevision??identity.revision;
    if (!Object.entries(this.policy).every(([_,v])=>v===undefined||Number.isFinite(v)&&Number(v)>=0)
      || !Number.isInteger(this.policy.maxDeaths) || this.policy.foodTarget<0 || this.policy.maxDurationMs<=0)
      throw new Error('INVALID_AGENCY_POLICY');
    if(existsSync(file)) {
      const saved=JSON.parse(readFileSync(file,'utf8'));
      if(saved.version!==2)throw new Error('LEGACY_AGENCY_MEMORY_REQUIRES_RECONCILIATION_AND_MIGRATION');
      this.document=saved;
    } else this.document={version:2,memory:createMemory(identity,options.preferences),knowledge:emptyKnowledge(),lastCommands:[]};
    this.document.knowledge.discovered??={};
    this.document.knowledge.interactions??={};
    const memory=this.document.memory;
    if(memory.agent!==identity.agent||memory.world!==identity.world||memory.revision!==identity.revision)throw new Error('AGENCY_IDENTITY_MISMATCH');
    if (!!memory.pending!==!!this.document.receipt || (memory.pending && memory.pending.commandId!==this.document.receipt?.commandId))
      throw new Error('AGENCY_JOURNAL_INCONSISTENT');
    this.director=new Director(memory);
    if(options.sourceCatalogueRoot)this.sourceResources=new SourceResources(options.sourceCatalogueRoot,file,this.identity,this.clock);
  }
  private save() { this.document.updatedAt=this.clock();atomic(this.file,this.document); }
  tripPreparation(state:LiveState,kind?:TaskKind):TripPreparation {
    this.document.trips??=emptyTrips();
    return preparation(state,kind,this.document.trips);
  }
  private activity():TaskKind|undefined {
    const id=this.director.memory.active?.id??'';
    if(!id)return;
    if(id.startsWith('train-')&&id!=='train-prayer')return 'combat';
    if(id.startsWith('supply-food')||id.startsWith('gathering'))return 'gathering';
    if(id.startsWith('production')||id==='supply-ammunition')return 'production';
    return 'exploration';
  }
  private executorEpisode(state:LiveState) {
    const episode=this.document.executorEpisode;
    if(!episode)return;
    const revision=this.director.memory.learningRevision??0;
    const productiveAt=this.director.memory.progress?.lastProductiveAt??0;
    // An executor episode is a bounded diagnostic pause, not a durable
    // blacklist.  Once its recheck is due, discard the old set and make a
    // genuinely fresh plan from the current observation.  A new failure can
    // create a new episode, but stale failures must not keep an agent idle.
    if(episode.executorRevision!==this.executorRevision||episode.context!==capabilityContext(state)||episode.learningRevision!==revision||productiveAt>episode.at
      ||(episode.failures.length>=EXECUTOR_EPISODE_MAX_FAILURES&&this.clock()>=episode.recheckAt)) {
      delete this.document.executorEpisode;
      return;
    }
    return episode;
  }
  private executorEpisodeBlocked(state:LiveState) {
    const episode=this.executorEpisode(state);
    return episode&&episode.failures.length>=EXECUTOR_EPISODE_MAX_FAILURES&&this.clock()<episode.recheckAt ? episode : undefined;
  }
  /** A closed interface is a safe, general precondition for replanning.
   * It is allowed only while a bounded executor episode has no outstanding
   * receipt, so it cannot discard a planned withdrawal, purchase, or dialogue. */
  blockedInterfaceRecovery(state:LiveState):LiveCandidate|undefined {
    if(!this.executorEpisodeBlocked(state)||this.document.receipt||this.document.safetyReceipt)return;
    if(state.bank?.isOpen===true)return {id:'recover-close-bank-interface',type:'closeModal',waitTicks:1,
      fields:{reason:'restore a neutral interface before a bounded executor replan'}};
    if(state.shop?.isOpen===true)return {id:'recover-close-shop-interface',type:'closeShop',waitTicks:1,
      fields:{reason:'restore a neutral interface before a bounded executor replan'}};
  }
  private recordExecutorFailure(state:LiveState,id:string):void {
    const now=this.clock(),context=capabilityContext(state),revision=this.director.memory.learningRevision??0;
    const prior=this.executorEpisode(state);
    const failures=prior?[...prior.failures]:[];
    if(!failures.includes(id))failures.push(id);
    this.document.executorEpisode={at:prior?.at??now,context,learningRevision:revision,executorRevision:this.executorRevision,failures:failures.slice(-EXECUTOR_EPISODE_MAX_FAILURES),
      recheckAt:failures.length>=EXECUTOR_EPISODE_MAX_FAILURES?now+EXECUTOR_EPISODE_RECHECK_MS:now};
  }
  catalogue(state:LiveState):Catalogue {
    if(state.character && String(state.character).toLowerCase()!==this.identity.agent.toLowerCase())throw new Error('OBSERVATION_AGENT_MISMATCH');
    if(state.world && state.world!==this.identity.world)throw new Error('OBSERVATION_WORLD_MISMATCH');
    this.director.memory.progress??={since:this.clock(),noProgressActions:0,recentStates:[]};
    if(this.document.transactionQuarantine?.some(q=>q.active)&&state.bank?.isOpen===true&&Array.isArray(state.bank?.items)&&Array.isArray(state.inventory)) {
      const now=this.clock();
      this.document.transactionQuarantine=this.document.transactionQuarantine.map(q=>releaseFromFreshAccounting(q,state,now));
    }
    this.document.lastObservation={at:this.clock(),tick:state.tick,connected:state.inGame,position:state.player && {x:state.player.worldX,z:state.player.worldZ,level:state.player.level}};
    observeKnowledge(state,this.document.knowledge,this.clock(),this.routes);
    const discoveryHold=this.document.knowledge.discoveryHold;
    if(discoveryHold && (discoveryHold.until<=this.clock()
      || discoveryHold.context!==capabilityContext(state)
      || discoveryHold.learningRevision!==(this.director.memory.learningRevision??0)))
      delete this.document.knowledge.discoveryHold;
    this.document.trips??=emptyTrips();
    observeTrip(this.document.trips,state,this.activity(),this.clock());
    this.document.preparation=this.tripPreparation(state,this.activity());
    // Keep collision observations local, but do not promote incidental scenery into
    // strategic/support exploration goals. Existing bundled/source routes remain.
    for (const [id, route] of Object.entries(this.document.knowledge.routes)) {
      if (!meaningfulFrontierRoute(route)) {
        delete this.document.knowledge.routes[id];
        delete this.document.knowledge.visited[id];
      }
    }
    this.document.buildReadiness=developmentReadiness(this.document.development,state,this.buildRules);
    const catalogue=buildCatalogue(this.identity,state,this.document.knowledge,{...this.policy,foodTarget:this.document.preparation.foodTarget},this.supported,this.director.memory,this.clock(),this.document.development,this.buildRules,this.document.trips);
    if(this.supported.includes('acquisition')) {
      this.document.acquisition??=emptyAcquisition();
      observeAcquisitionSources(this.document.acquisition,state,this.clock());
      const need=this.document.acquisition.need,goal=this.director.memory.active;
      if(need&&!need.optional&&goal?.key===need.parentKey&&!this.document.receipt&&!this.document.safetyReceipt
        && itemCount(state.inventory,need)<need.minimum && (!goal.requestedSupport||catalogue.view.facts[goal.requestedSupport.target.fact]!>=goal.requestedSupport.target.minimum))
        this.director.requestSupport({fact:itemFact(need),minimum:need.minimum},need.reason,[`own-missing-item:${need.at}`]);
      addAcquisition(catalogue,state,this.document.knowledge.bank,this.document.acquisition,this.director.memory,
        {...this.policy,foodTarget:this.tripPreparation(state,'combat').foodTarget},this.dropLeads,this.acquisitionHints,this.clock());
    }
    this.sourceResources?.augment(catalogue,state,this.document.knowledge,this.document.acquisition,this.policy,this.director.memory);
    return catalogue;
  }
  async sourceActions(task:Task,state:LiveState,port:SourcePort):Promise<LiveCandidate[]> {
    if(!task.sourceResource||!this.sourceResources)return [];
    return (await this.sourceResources.actions(task.sourceResource,state,port)).actions;
  }
  async sourcePreflight(selection:Selection,action:LiveCandidate,state:LiveState,port:SourcePort):Promise<LiveCandidate> {
    if(!selection.task.sourceResource)return action;
    if(!this.sourceResources)throw new Error('SOURCE_EXECUTOR_NOT_INSTALLED');
    return this.sourceResources.preflight(selection,action,state,port);
  }
  sourceOutcome(task:Task,before:LiveState,after:LiveState,action:LiveCandidate,original:Verification):Verification {
    if(!task.sourceResource)return original;
    return this.sourceResources?.outcome(task.sourceResource,before,after,action,original)??{status:'unknown',evidence:[],reason:'Source executor unavailable for reconciliation.'};
  }
  plan(state:LiveState):Selection|Decision {
    if(state.character && String(state.character).toLowerCase()!==this.identity.agent.toLowerCase())throw new Error('OBSERVATION_AGENT_MISMATCH');
    if(state.world && state.world!==this.identity.world)throw new Error('OBSERVATION_WORLD_MISMATCH');
    if(this.document.safetyReceipt)return {type:'blocked',reason:'Reconcile the safety action before any further dispatch.',missingCapabilities:[]};
    if (!this.document.receipt && !this.document.safetyReceipt) {
      this.document.development ??= chooseDevelopment(state,this.director.memory,this.clock(),this.developmentHint,this.buildRules);
      this.document.development = reviewDevelopment(this.document.development,state,this.director.memory,this.clock(),this.buildRules);
    }
    if (protectedXpChanged(this.document.development,state)) {
      this.document.blocked='PURE_BUILD_XP_BOUNDARY_CHANGED: inspect the observed change before continuing combat.';this.save();
    }
    const catalogue=this.catalogue(state);
    if(protectedXpChanged(this.document.development,state)) {
      catalogue.opportunities=catalogue.opportunities.filter(g=>g.domain!=='combat');
      catalogue.methods=catalogue.methods.filter(m=>m.domain!=='combat');
    }
    if(!this.document.receipt) {
      if(catalogue.intentPolicyEnabled&&intentionReviewSafe(state))this.director.retireUnjustifiedIntents(new Set(catalogue.retiredIntentIds??[]),this.clock());
      this.director.retireObsoleteSurveys(new Set(Object.keys(this.document.knowledge.routes)),this.clock());
      this.director.retireObsoleteDiscovery(new Set(catalogue.tasks.keys()),this.clock());
      this.director.reviseFoodNeed(this.document.preparation!.foodTarget,this.clock());
      this.checkProgress(state);
    }
    const executorEpisode=this.executorEpisodeBlocked(state);
    if(executorEpisode) {
      const reason=`EXECUTOR_CAPABILITY_EPISODE: ${executorEpisode.failures.length} distinct plans had no executable first step. Await a verified state/knowledge change or recheck at ${new Date(executorEpisode.recheckAt).toISOString()}.`;
      this.document.blocked=reason;
      // Export no phantom work to Herdr while the executor is rate-limited.
      teamPlanning({...catalogue,opportunities:[],methods:[],tasks:new Map()},this.director,state.inGame===true,false,reason,process.env,this.clock(),false,executorEpisode);
      this.save();
      return {type:'blocked',reason,missingCapabilities:[]};
    }
    const episode=this.executorEpisode(state);
    const preference=teamPlanning(catalogue,this.director,state.inGame===true,!!this.document.receipt||!!this.document.safetyReceipt,this.document.blocked,process.env,this.clock(),true,episode);
    const decision=this.director.next(catalogue.view,catalogue.opportunities,catalogue.methods,preference);
    this.document.discoveryRetryAt=undefined;
    if(decision.type==='blocked'&&!this.director.memory.pending&&!this.director.memory.active&&catalogue.discoveryRetryAt) {
      this.document.discoveryRetryAt=catalogue.discoveryRetryAt;
      decision.reason+=' Local discovery is temporarily budgeted/cooling down; next eligibility '+new Date(catalogue.discoveryRetryAt).toISOString()+'. Feasible ordinary goals are still reconsidered on each observation.';
    }
    if(decision.type==='blocked'&&this.director.memory.active?.domain==='combat'&&catalogue.methods.some(m=>m.risk==='unknown'))
      decision.reason+=' Combat loss valuation is unknown: provide an audited carried-kit replacement-loss ceiling in agency-policy.json.';
    this.document.blocked=decision.type==='blocked'?decision.reason:undefined;this.save();
    if(decision.type!=='execute')return decision;
    const method=catalogue.methods.find(m=>m.id===decision.step.methodId),task=catalogue.tasks.get(decision.step.methodId);
    if(!method||!task)throw new Error('UNREGISTERED_PLANNED_METHOD');
    return {decision,method,task:{...task,foodTarget:this.tripPreparation(state,task.kind==='food'?this.activity():task.kind).foodTarget,target:decision.step.lineage?.at(-1)},view:catalogue.view};
  }
  pending(scope:'task'|'safety'='task'):Receipt|undefined {
    const receipt=scope==='safety'?this.document.safetyReceipt:this.document.receipt;
    return receipt && structuredClone(receipt);
  }
  quarantinedTransaction(commandId:string):QuarantinedTransaction|undefined {
    const entry=this.document.transactionQuarantine?.find(q=>q.commandId===commandId);
    return entry&&structuredClone(entry);
  }
  /** Preserve a historically unresolved bank mutation as audit state instead of inventing success/failure. */
  quarantinePendingTransaction(state:LiveState,reason:string):QuarantinedTransaction|undefined {
    const receipt=this.document.receipt,pending=this.director.memory.pending;
    if(!receipt||receipt.scope!=='task'||!pending||pending.commandId!==receipt.commandId||pending.status!=='unknown')return;
    const now=this.clock();
    const identity=transactionIdentity(receipt.action,receipt.before);if(!identity)return;
    const quantity=Number(receipt.action.fields?.amount);
    if(!Number.isSafeInteger(quantity)||!(quantity>0||receipt.action.type==='bankDeposit'&&quantity===-1))return;
    let historicalEvidence:string[]=[];
    if(!quarantineEligible(receipt.action,receipt.before,state,receipt.startedAt,now,reason)) {
      const current=observeHistoricalContext(receipt.before,state,now,this.observer,receipt.historical);
      receipt.historical=current.window;
      receipt.investigation={at:now,reason:current.reason,quietSince:current.window?.since};
      this.document.blocked=current.reason;this.save();
      // A new current-context window, not the old server tick origin, establishes
      // administrative finality. The original value-moving effect stays unknown.
      if(!current.settled||!Number.isFinite(receipt.startedAt)||now-receipt.startedAt<120_000)return;
      historicalEvidence=current.evidence;
    }
    const evidence=[`historical-command-quarantined:${receipt.commandId}`,`fresh-current-state:${state.tick}`,...historicalEvidence,
      'No historical success or failure inferred; exact command must never be replayed.',
      'Future bank mutations for the affected item require a complete fresh bank snapshot.'];
    const goalKey=pending.goalKey;
    const entry:QuarantinedTransaction={at:now,commandId:receipt.commandId,type:receipt.action.type,semanticKey:identity.semanticKey,
      itemIds:identity.itemIds,reason,evidence,goalKey,active:true,originalReceipt:structuredClone(receipt),
      observation:{tick:state.tick,sessionId:state.sessionId,character:state.character,world:state.world,
        worldEpoch:state.worldEpoch,profileId:state.profileId}};
    this.document.transactionQuarantine=[...(this.document.transactionQuarantine??[]),entry];
    delete this.director.memory.pending;delete this.document.receipt;delete this.document.route;
    if(this.document.acquisition?.need?.parentKey===goalKey)delete this.document.acquisition.need;
    this.document.lastCommands=[...this.document.lastCommands,receipt.commandId].slice(-128);
    this.document.lastOutcome={at:now,commandId:receipt.commandId,type:receipt.action.type,status:'quarantined',reason,evidence};
    if(this.director.memory.active)this.director.deferCurrent(now,'Historical bank transaction quarantined; replan only from fresh current state.',evidence);
    this.document.blocked='Historical bank transaction quarantined; value-moving replay disabled until fresh bank accounting.';
    this.save();return structuredClone(entry);
  }
  private transactionConflict(action:LiveCandidate,state:LiveState):boolean {
    return (this.document.transactionQuarantine??[]).some(q=>conflictsWithQuarantine(q,action,state));
  }
  /** Persist only command-scoped executor evidence, never an entire global navigation cache. */
  rememberExecution(commandId:string,result:any):void {
    const r=this.document.receipt?.commandId===commandId?this.document.receipt:this.document.safetyReceipt;
    if(!r||r.commandId!==commandId)throw new Error('EXECUTION_WITHOUT_MATCHING_INTENT');
    r.execution ??= {};
    if(result?.accepted===false||result?.success===false&&result?.reason==='action_in_progress')r.execution.accepted=false;
    if(result?.phase==='rejected')r.execution.phase='rejected';
    if(result?.navigation)r.execution={...r.execution,navigation:{status:String(result.navigation.status),
      reason:result.navigation.reason,movementDispatched:result.navigation.movementDispatched}};
    this.save();
  }
  /** Continue the committed destination after a partial leg, including after restart. */
  routeStep(selection:Selection,state:LiveState):LiveCandidate|undefined {
    const r=this.document.route;
    if(!r)return;
    if(r.goalKey!==selection.decision.goal.key||r.methodId!==selection.method.id){delete this.document.route;this.save();return;}
    const f=r.action.fields??{},p=state.player;
    if(p?.level!==f.level && !(p?.level===0&&f.level===undefined)){delete this.document.route;this.save();return;}
    if(Math.max(Math.abs(Number(p?.worldX)-Number(f.x)),Math.abs(Number(p?.worldZ)-Number(f.z)))<=1){delete this.document.route;this.save();return;}
    return structuredClone(r.action);
  }
  /** Only idempotent navigation/read steps and narrowly proven non-effects can expire.
   * Purchases, transfers and dialogue choices still require attributable terminal evidence. */
  settleStep(commandId:string,state:LiveState):Verification|undefined {
    const r=this.document.receipt?.commandId===commandId?this.document.receipt:this.document.safetyReceipt;
    if(!r||r.commandId!==commandId)return;
    const bounded=boundedInteractionRetirement(r,state,this.clock());
    if(bounded)return bounded;
    const result=observeQuietStep(r.action,r.before,state,this.clock(),this.observer,r.stationary);
    r.stationary=result.window;
    if(!result.settled&&historicalTraversal(r.action,r.before)) {
      const current=observeHistoricalContext(r.before,state,this.clock(),this.observer,r.historical,true);
      r.historical=current.window;
      if(current.window) {
        r.investigation={at:this.clock(),reason:current.reason,quietSince:current.window.since};
        this.document.blocked=current.reason;this.save();
        return current.settled?{status:'interrupted',recovery:'investigate',historical:true,
          reason:current.reason,evidence:['historical-context-retired',...current.evidence]}:undefined;
      }
    }
    r.investigation={at:this.clock(),reason:result.reason,quietSince:result.window?.since};
    this.document.blocked=result.reason;this.save();
    return result.settled?{status:'interrupted',recovery:['interactNpc','interactLoc','pickupItem','useItemOnItem','useItemOnLoc'].includes(r.action.type)?'investigate':undefined,evidence:[result.reason],reason:result.reason}:undefined;
  }
  /** Retire a non-transactional receipt inherited from an earlier runtime when two fresh own observations
   * still cannot attribute its terminal effect. This never calls the executor and never records success.
   * Purchases, bank transfers and dialogue choices remain strict because replay could duplicate value/choice. */
  retireRestartPending(scope:'task'|'safety',first:LiveState,stable:LiveState,reason:string):boolean {
    const receipt=scope==='safety'?this.document.safetyReceipt:this.document.receipt;
    if(!receipt)return false;
    const strict=new Set(['shopBuy','shopSell','bankDeposit','bankWithdraw','clickDialogOption']);
    if(strict.has(receipt.action.type))return false;
    if(BOUNDED_NON_TRANSACTIONAL_INTERACTIONS.has(receipt.action.type)||['useInventoryItem','equip'].includes(receipt.action.type)) {
      // A changed world epoch invalidates the original command timeline. Do
      // not start a quiet-window investigation that can never attribute that
      // old interaction; use the two fresh current observations below to
      // retire this non-value-moving receipt without replaying it.
      const epochChanged=(receipt.before as any).worldEpoch!==undefined
        &&(receipt.before as any).worldEpoch!==(stable as any).worldEpoch;
      if(!epochChanged) {
        const settled=this.settleStep(receipt.commandId,stable);
        if(settled)this.record(receipt.commandId,stable,settled);
      }
      // A previous server/client epoch may reset the action's original tick or
      // life id, so settleStep cannot always establish its normal quiet window.
      // Two new observations of this same live actor are nevertheless enough to
      // retire an old *non-value-moving* probe without replaying or claiming an
      // outcome.  This is deliberately narrower than transaction quarantine.
      if(!(scope==='safety'?this.document.safetyReceipt:this.document.receipt))return true;
      // settleStep has already started a controller-owned quiet-window
      // investigation. A restart must not shortcut that bounded evidence window
      // merely because it happens to have two fresh observations.
      if(receipt.investigation)return false;
      const a=first.player,b=stable.player;
      const fresh=first.inGame===true&&stable.inGame===true&&a&&b&&!a.isDead&&!b.isDead
        &&[first.tick,stable.tick,a.worldX,a.worldZ,a.level,b.worldX,b.worldZ,b.level].every(Number.isFinite)
        &&Number(stable.tick)>Number(first.tick)
        &&['character','world','profileId'].every(field=>(first as any)[field]===undefined||(first as any)[field]===(stable as any)[field]);
      if(fresh) {
        const evidence=[`restart-fresh-observations:${first.tick}->${stable.tick}`,
          `stale-${receipt.action.type}-retired-without-replay`,
          'Historical non-transactional interaction remains unknown; select a new action from current state.'];
        this.record(receipt.commandId,stable,{status:'interrupted',recovery:'investigate',evidence,
          reason:'RESTART_UNATTRIBUTED_NONTRANSACTIONAL_INTERACTION: original action clock cannot be compared after restart.'},
        {spentGp:0,lostGp:0,deaths:0,elapsedMs:Math.max(0,this.clock()-receipt.startedAt)});
      }
      return !(scope==='safety'?this.document.safetyReceipt:this.document.receipt);
    }
    const a=first.player,b=stable.player;
    if(first.inGame!==true||stable.inGame!==true||!a||!b||a.isDead||b.isDead
      ||![first.tick,stable.tick,a.worldX,a.worldZ,a.level,b.worldX,b.worldZ,b.level].every(Number.isFinite)
      ||Number(stable.tick)<=Number(first.tick))return false;
    for(const field of ['character','world','worldEpoch','profileId'] as const)
      if((first as any)[field]!==undefined&&(first as any)[field]!== (stable as any)[field])return false;
    const evidence=[`restart-fresh-observations:${first.tick}->${stable.tick}`,
      `stale-${receipt.action.type}-retired-without-replay`,
      'Historical effect remains unknown; a future action must be selected and validated from fresh state.'];
    const deaths=Math.max(0,Number(b.respawnCount??0)-Number(receipt.before.player?.respawnCount??0));
    this.record(receipt.commandId,stable,{status:'interrupted',evidence,reason:'RESTART_UNATTRIBUTED_NONTRANSACTIONAL_ACTION: '+reason},
      {spentGp:0,lostGp:0,deaths,elapsedMs:Math.max(0,this.clock()-receipt.startedAt)});
    return !(scope==='safety'?this.document.safetyReceipt:this.document.receipt);
  }
  // Existing controller adapters retain compatibility; semantics remain operation-specific.
  settleNavigation(commandId:string,state:LiveState):Verification|undefined { return this.settleStep(commandId,state); }
  eligible(action:LiveCandidate,state:LiveState):boolean {
    let current=action;try{current=bindItems(action,state);}catch{return false;}
    if(this.transactionConflict(current,state))return false;
    const retry=this.document.retries?.[stepKey(current,state)];
    if(stateProvesAcknowledgementStillRequired(current,state)&&retry&&retry.state!=='viable')
      return this.clock()>=retry.at+STATE_PROVEN_ACKNOWLEDGEMENT_RETRY_MS;
    return retryAllowed(retry,this.clock(),capabilityContext(state),this.director.memory.learningRevision??0);
  }
  retryExhausted(action:LiveCandidate,state:LiveState):boolean {
    let current=action;try{current=bindItems(action,state);}catch{return false;}
    return retryExhausted(this.document.retries?.[stepKey(current,state)],capabilityContext(state),this.director.memory.learningRevision??0);
  }
  /** Funding is an observed prerequisite. This never grants purchase authority by itself. */
  prepareFunding(action:LiveCandidate,state:LiveState):boolean {
    if(action.type!=='shopBuy'||this.document.receipt)return false;
    const row=(state.shop?.shopItems??[]).find((i:any)=>i.slot===action.fields?.slot);
    const n=Number(action.fields?.amount),price=Number(row?.buyPrice);
    if(!Number.isInteger(n)||n<1||!Number.isFinite(price)||price<0)return false;
    const needed=price*n+this.policy.reserveCoins;
    if(cash(state.inventory??[])>=needed)return false;
    // Remembered own bank stock is a planning lead only. Actual withdrawal uses a fresh bank view.
    if(cash(this.document.knowledge.bank)<needed-cash(state.inventory??[]))return false;
    this.director.requestSupport({fact:'coins',minimum:needed},'Access own bank funds before the quoted preparation purchase.',
      [`own-shop-quote:${state.tick}:${row.id}:${price}`,`own-bank-lead:${this.document.knowledge.bankCheckedAt}`]);
    this.save();return true;
  }
  requestItem(need:ItemNeed,state:LiveState,reason:string):void {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal=this.director.memory.active;
    if(!goal||!this.supported.includes('acquisition')){this.blocked('Item acquisition capability required: '+need.name);return;}
    if(!need.name.trim()||need.name.length>120||!Number.isSafeInteger(need.minimum)||need.minimum<1||need.minimum>100000
      ||need.id!==undefined&&(!Number.isInteger(need.id)||need.id<0))throw new Error('INVALID_ITEM_REQUIREMENT');
    this.document.acquisition??=emptyAcquisition();
    this.document.acquisition.need={...need,parentKey:goal.key,reason,at:this.clock()};
    this.director.requestSupport({fact:itemFact(need),minimum:need.minimum},reason,[`own-missing-item:${state.tick}:${need.id??need.name}`]);
    delete this.document.route;this.save();
  }
  deferCurrent(state:LiveState,reason:string,executorFailure=true,methodId?:string):void {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal=this.director.memory.active;if(!goal)return;
    if(methodId)this.director.executorUnavailable(this.catalogue(state).view,methodId,this.clock());
    if(executorFailure)this.recordExecutorFailure(state,goal.id);
    this.director.deferCurrent(this.clock(),reason,[`fresh-no-executor:${state.tick}:${goal.id}`]);
    delete this.document.route;this.document.blocked=reason;this.save();
  }
  deferSurvey(route:Route,state:LiveState,reason:string,executorFailure=true):void {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    this.document.knowledge.routeFailures??={};
    const old=this.document.knowledge.routeFailures[route.id],now=this.clock(),attempts=(old?.attempts??0)+1;
    if(executorFailure)this.recordExecutorFailure(state,'survey:'+route.id);
    this.document.knowledge.routeFailures[route.id]={at:now,retryAt:now+Math.min(30*60_000,60_000*2**Math.min(5,attempts)),
      attempts,context:capabilityContext(state),learningRevision:this.director.memory.learningRevision??0,reason};
    this.director.deferSurvey(route.id,now,reason,[`own-route-assessment:${state.tick}:${route.id}`]);
    delete this.document.route;this.document.blocked=reason;this.save();
  }
  /** A failed path assessment is allowed one fresh, read-only local observation
   * before it is deferred.  This is deliberately keyed to the route failure and
   * current capability context: scans do not become a success signal, and a
   * route cannot be kept alive by repeatedly scanning the same stale scene. */
  needsSurveyObservation(route:Route,state:LiveState):boolean {
    const prior=this.document.knowledge.surveyObservations?.[route.id];
    const failure=this.document.knowledge.routeFailures?.[route.id];
    return !prior || prior.context!==capabilityContext(state)
      || prior.failureAt!==failure?.at;
  }
  blocked(reason:string):void {
    this.director.blocked(this.clock(),reason);this.document.blocked=reason;this.save();
  }
  /** Shared productive-progress deadline. Reconciliation/safety is never bypassed,
   * and starting another attempt does not reset the exported health clock. */
  checkProgress(state:LiveState):boolean {
    if(this.document.receipt||this.document.safetyReceipt)return false;
    const goal=this.director.memory.active,p=this.director.memory.progress;
    if(!goal||!p||this.clock()-Math.max(goal.startedAt,p.lastProductiveAt??p.since)<PROGRESS_TIMEOUT_MS)return false;
    this.director.blocked(this.clock(),'No causal progress within the bounded method window.',[]);
    this.deferCurrent(state,'Productive-progress deadline exceeded; reconsider methods from fresh observations.',false);
    return true;
  }
  /** No re-selection here. A refused begin MUST prevent normal execution. */
  begin(selection:Selection,action:LiveCandidate,state:LiveState,commandId:string=randomUUID()):string {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    if(this.quarantinedTransaction(commandId))throw new Error('QUARANTINED_COMMAND_ID_CANNOT_BE_REUSED');
    if(this.document.historicalRetirements?.some(r=>r.commandId===commandId))throw new Error('HISTORICAL_COMMAND_ID_CANNOT_BE_REUSED');
    action=bindItems(action,state);
    if(this.transactionConflict(action,state))throw new Error('TRANSACTION_QUARANTINED_UNTIL_FRESH_BANK_ACCOUNTING');
    const current=this.catalogue(state),view=current.view;
    if(current.intentPolicyEnabled&&(current.retiredIntentIds??[]).some(id=>id===selection.decision.goal.id||id===selection.method.id))
      throw new Error('INTENTION_REVIEW_REQUIRED: the selected legacy goal/leaf no longer has a current purpose; replan before dispatch.');
    if(view.context!==selection.view.context)throw new Error('CAPABILITY_CONTEXT_CHANGED');
    if(!this.eligible(action,state))throw new Error('STEP_AWAITING_EVIDENCE_OR_COOLDOWN');
    guardDevelopment(this.document.development,state,action,selection.task.skill,this.buildRules);
    // A shop cannot spend banked money; preserve the carried working reserve too.
    const cost=authorizeAction(state,action,selection.method,Math.max(0,cash(state.inventory??[])-this.policy.reserveCoins));
    const priced={...selection.method,costGp:cost};
    if(selection.task.sourceResource) {
      if(!this.sourceResources)throw new Error('SOURCE_EXECUTOR_NOT_INSTALLED');
      this.sourceResources.authorize(selection,action,state,commandId);
    }
    this.director.begin(view,selection.decision,priced,commandId);
    let approach=action.approach;
    if(action.type==='walkTo'&&!approach) {
      const route=selection.task.route;
      const f=action.fields??{};
      const end=route??{x:f.x,z:f.z,level:f.level??state.player?.level};
      if([end.x,end.z,end.level].every(Number.isFinite))approach={x:end.x,z:end.z,level:end.level};
    }
    this.document.receipt={sourceTask:selection.task.sourceResource?structuredClone(selection.task.sourceResource):undefined,commandId,action:structuredClone(action),before:structuredClone(state),startedAt:this.clock(),scope:'task',methodId:selection.method.id,approach};
    if(action.type==='walkTo')this.document.route={goalKey:selection.decision.goal.key,methodId:selection.method.id,action:structuredClone(action)};
    this.save();return commandId;
  }
  /** Urgent survival and a bounded neutral interface close are independent of
   * the goal; neither can overwrite an unresolved ordinary intent. */
  beginSafety(action:LiveCandidate,state:LiveState,commandId:string=randomUUID()):string {
    if(this.document.safetyReceipt)throw new Error('RECONCILE_SAFETY_ACTION_FIRST');
    if(this.quarantinedTransaction(commandId)||this.document.historicalRetirements?.some(r=>r.commandId===commandId))throw new Error('HISTORICAL_COMMAND_ID_CANNOT_BE_REUSED');
    action=bindItems(action,state);
    if(!safetyAction(state,action)&&!neutralInterfaceRecovery(state,action))throw new Error('NOT_AN_URGENT_SAFETY_ACTION');
    this.document.safetyReceipt={commandId,action:structuredClone(action),before:structuredClone(state),startedAt:this.clock(),scope:'safety'};
    this.save();return commandId;
  }
  record(commandId:string,after:LiveState,verification:Verification,metrics?:{spentGp:number;lostGp:number;deaths:number;elapsedMs:number}):void {
    if(this.document.lastCommands.includes(commandId)||this.document.historicalRetirements?.some(r=>r.commandId===commandId)||this.quarantinedTransaction(commandId))return;
    const safety=this.document.safetyReceipt?.commandId===commandId;
    const receipt=safety?this.document.safetyReceipt:this.document.receipt;
    if(!receipt && this.document.lastCommands.includes(commandId))return;
    if(!receipt||receipt.commandId!==commandId)throw new Error('OUTCOME_WITHOUT_MATCHING_INTENT');
    if(receipt.sourceTask)this.sourceResources?.reconcileSpend(commandId,receipt.before,after,receipt.action);
    if(receipt.sourceTask)verification=this.sourceResources?.outcome(receipt.sourceTask,receipt.before,after,receipt.action,verification)
      ??{status:'unknown',evidence:[],reason:'Source catalogue required to reconcile this receipt.'};
    const historical=verification.historical===true&&verification.status==='interrupted'
      &&verification.evidence.includes('historical-context-retired')&&historicalTraversal(receipt.action,receipt.before)
      &&historicalWindowReady(receipt.before,after,this.clock(),this.observer,receipt.historical,true);
    if(verification.historical&&!historical)verification={status:'unknown',evidence:[],reason:'Historical retirement requires the current controller-owned measured current-context window.'};
    if(historical) {
      this.document.historicalRetirements=[...(this.document.historicalRetirements??[]),
        {at:this.clock(),commandId,receipt:structuredClone(receipt),reason:verification.reason??'historical context ended',
         evidence:[...verification.evidence],lossAttribution:'unknown'}];
      // These are administrative charges, NOT a claim that no loss/death occurred.
      // Unattributable historical losses remain explicitly unknown in the audit.
      metrics={spentGp:0,lostGp:0,deaths:0,elapsedMs:0};
    }
    if(verification.status==='verified') {
      this.document.acquisition??=emptyAcquisition();rememberAcquisitionSources(this.document.acquisition,receipt.before,after,receipt.action,this.clock());
      // The dispatcher deliberately strips controller-only fields before it
      // sends a CLI command.  The intent receipt retains them, but a generic
      // scan may also have been selected while an exploration survey is
      // active (for example to refresh a collision edge).  Attribute that
      // scan to the active survey as well.  Otherwise each successful scan
      // is invisible to `needsSurveyObservation`, causing a read-only scan
      // loop with no new world evidence or route decision.
      const activeSurvey=this.director.memory.active?.id;
      const receiptSurvey=receipt.methodId?.startsWith('survey:')
        ?receipt.methodId.slice('survey:'.length):undefined;
      const surveyRouteId=typeof receipt.action.fields?.surveyRouteId==='string'
        ?receipt.action.fields.surveyRouteId
        // The director can complete/defer the active goal while recording a
        // terminal receipt. Its method id is stable across that transition.
        :receiptSurvey??(activeSurvey?.startsWith('survey:')?activeSurvey.slice('survey:'.length):undefined);
      if(receipt.action.type==='scanNearbyLocs'&&surveyRouteId) {
        this.document.knowledge.surveyObservations??={};
        this.document.knowledge.surveyObservations[surveyRouteId]={at:this.clock(),tick:Number(after.tick),lifeId:Number(after.player?.lifeId),
          context:capabilityContext(after),learningRevision:this.director.memory.learningRevision??0,
          failureAt:this.document.knowledge.routeFailures?.[surveyRouteId]?.at};
      }
      if(receipt.action.type==='interactLoc') {
        const loc=(receipt.before.nearbyLocs??[]).find((l:any)=>l.id===receipt.action.fields?.locId&&l.x===receipt.action.fields?.x&&l.z===receipt.action.fields?.z);
        const option=(loc?.optionsWithIndex??[]).find((o:any)=>o.opIndex===receipt.action.fields?.optionIndex);
        if(loc&&option&&/^(open|climb(?:-up|-down)?|enter|cross|use)$/i.test(String(option.text))) {
          const fact=discoveryFact(loc,Number(option.opIndex));
          this.document.knowledge.discovered[fact]=`own-interaction:${receipt.before.player?.lifeId}:${receipt.before.tick}->${after.tick}`;
          const key=`${Number(loc.id)}:${Number(loc.x)}:${Number(loc.z)}:${Number(loc.level??receipt.before.player?.level??0)}:${Number(option.opIndex)}`;
          this.document.knowledge.interactions[key]={name:String(loc.name),id:Number(loc.id),x:Number(loc.x),z:Number(loc.z),level:Number(loc.level??receipt.before.player?.level??0),option:String(option.text),at:this.clock(),evidence:`own-interaction:${receipt.before.tick}->${after.tick}`};
        }
      }
    }
    if(verification.status==='rejected'&&receipt.action.type==='interactLoc') {
      const loc=(receipt.before.nearbyLocs??[]).find((l:any)=>l.id===receipt.action.fields?.locId&&l.x===receipt.action.fields?.x&&l.z===receipt.action.fields?.z);
      const option=(loc?.optionsWithIndex??[]).find((o:any)=>o.opIndex===receipt.action.fields?.optionIndex);
      if(loc&&option&&/^(open|climb(?:-up|-down)?|enter|cross|use)$/i.test(String(option.text))) {
        const fact=discoveryFact(loc,Number(option.opIndex));
        this.document.knowledge.unavailableInteractions??={};
        this.document.knowledge.unavailableInteractions[fact]={at:this.clock(),until:this.clock()+15*60_000,
          context:capabilityContext(after),learningRevision:this.director.memory.learningRevision??0,
          reason:verification.reason??'explicit interaction refusal'};
      }
    }
    if(verification.status==='interrupted')this.document.interruptions=[...(this.document.interruptions??[]),{at:this.clock(),receipt:structuredClone(receipt),reason:verification.reason??'interrupted'}].slice(-16);
    this.document.trips??=emptyTrips();
    recordTripEffect(this.document.trips,commandId,receipt.before,after,receipt.action,verification.status==='verified');
    const state=this.catalogue(after).view;
    if(verification.status==='interrupted' && verification.evidence.length)delete this.document.route;
    const deaths=historical?0:Number(after.player?.lifeId!==receipt.before.player?.lifeId);
    let reconciledMetrics=metrics;
    if(deaths && !metrics && !['shopBuy','shopSell','bankDeposit','bankWithdraw','clickDialogOption'].includes(receipt.action.type)) {
      const loss=reconcileDeathLoss(receipt.before,after);
      if(loss.settled) {
        verification={status:'interrupted',evidence:loss.evidence,reason:loss.reason};
        reconciledMetrics={spentGp:0,lostGp:loss.lostGp,deaths:1,elapsedMs:Math.max(0,this.clock()-receipt.startedAt)};
        this.document.losses=[...(this.document.losses??[]),{at:this.clock(),commandId,lifeFrom:receipt.before.player?.lifeId,
          lifeTo:after.player?.lifeId,lostGp:loss.lostGp,items:loss.itemLosses}].slice(-64);
      } else verification={status:'unknown',evidence:[],reason:loss.reason};
    }
    if(deaths&&!reconciledMetrics)verification={status:'unknown',evidence:[],reason:'Life changed: transaction attribution or complete loss observations are still required.'};
    const deltas=reconciledMetrics??{
      spentGp:receipt.action.type==='shopBuy'&&verification.status==='verified'?Math.max(0,cash(receipt.before.inventory??[])-cash(after.inventory??[])):0,
      lostGp:0,deaths,elapsedMs:Math.max(0,this.clock()-receipt.startedAt),
    };
    if(verification.status==='verified' && receipt.action.type==='shopBuy' && this.director.memory.active?.workingReserveGp)
      this.director.memory.active.workingReserveGp=Math.max(this.policy.reserveCoins,this.director.memory.active.workingReserveGp-deltas.spentGp);
    this.document.lastOutcome={at:this.clock(),commandId,type:receipt.action.type,status:verification.status,reason:verification.reason,evidence:verification.evidence.slice(0,8)};
    if(safety) {
      if(verification.status==='unknown'||!verification.evidence.length){this.save();return;}
      delete this.document.safetyReceipt;
    } else {
      const pending=this.director.memory.pending;
      if(!pending || pending.commandId!==commandId)throw new Error('OUTCOME_WITHOUT_MATCHING_INTENT');
      const productive=Object.keys(pending.method.effects).some(k=>(state.facts[k]??0)>(pending.before[k]??0));
      const status:Outcome['status']=verification.status==='verified'&&!productive?'progress':verification.status;
      const end=receipt.approach??receipt.action.approach,from=receipt.before.player,to=after.player;
      const approach=end&&from?.level===end.level&&to?.level===end.level
        ? {key:JSON.stringify([end.x,end.z,end.level]),before:Math.max(Math.abs(from.worldX-end.x),Math.abs(from.worldZ-end.z)),
          after:Math.max(Math.abs(to.worldX-end.x),Math.abs(to.worldZ-end.z))}:undefined;
      this.director.record({commandId,sequence:this.director.memory.sequence+1,status,at:state.at,facts:state.facts,
        effectState:{before:effectState(receipt.before,pending.before),after:effectState(after,state.facts)},approach,
        ...deltas,evidence:verification.evidence,actionType:receipt.action.type,
        observationOnly:['wait','scanNearbyLocs'].includes(receipt.action.type)});
      if(!this.director.memory.pending) {
        delete this.document.receipt;
        if(verification.status==='interrupted'&&verification.recovery==='investigate'&&verification.evidence.length) {
          // The historical effect remains unknown. Retire only this bounded
          // approach; generic discovery/alternative plans compete on the next tick.
          const reason='QUIESCENT_INTERACTION_REPLAN: '+(verification.reason??'Historical effect unknown; current state is quiet.');
          // The experiment is deliberately not replayed and it does not prove
          // that this object or the whole discovery capability is broken. Hold
          // only this observed interaction, so another nearby object or an
          // ordinary productive goal can compete immediately.
          if(receipt.action.type==='interactLoc') {
            const loc=(receipt.before.nearbyLocs??[]).find((l:any)=>l.id===receipt.action.fields?.locId&&l.x===receipt.action.fields?.x&&l.z===receipt.action.fields?.z);
            const option=(loc?.optionsWithIndex??[]).find((o:any)=>o.opIndex===receipt.action.fields?.optionIndex);
            if(loc&&option) {
              const fact=discoveryFact(loc,Number(option.opIndex));
              this.document.knowledge.unavailableInteractions??={};
              this.document.knowledge.unavailableInteractions[fact]={at:this.clock(),until:this.clock()+EXECUTOR_EPISODE_RECHECK_MS,
                context:capabilityContext(after),learningRevision:this.director.memory.learningRevision??0,reason};
            }
          }
          this.director.deferCurrent(this.clock(),reason,verification.evidence);
          delete this.document.route;this.document.blocked=reason;
        }
      }
    }
    if(!this.document.receipt || this.document.receipt.commandId!==commandId)
      this.document.lastCommands=[...this.document.lastCommands,commandId].slice(-128);
    if(verification.status!=='unknown' && (verification.evidence.length || verification.status==='rejected')) {
      const key=stepKey(receipt.action,receipt.before);this.document.retries??={};
      this.document.retries[key]=recordViability(this.document.retries[key],verification.status,this.clock(),
        capabilityContext(receipt.before),this.director.memory.learningRevision??0,verification.evidence,verification.reason??verification.status);
      const entries=Object.entries(this.document.retries).sort((a,b)=>b[1].at-a[1].at).slice(0,512);
      this.document.retries=Object.fromEntries(entries);
    }
    // A terminally exhausted navigation attempt is a refusal of this approach,
    // not authority to keep the same exploration goal idle for another timeout.
    const nav=receipt.execution?.navigation,active=this.director.memory.active;
    // The navigator may report a conditional-edge failure as "replanning"
    // after it quarantines that edge. Once this action has ended without a
    // movement dispatch, retaining the old survey gives the planner no next
    // executable step. Release that one route so another safe frontier or
    // ordinary goal can compete; do not turn the obstacle into a global ban.
    if(!safety&&!this.document.receipt&&!this.document.safetyReceipt&&active&&verification.status==='interrupted'
      &&verification.evidence.length&&(nav?.status==='blocked'||(nav?.status==='replanning'&&nav?.movementDispatched===false))
      &&/^(door-did-not-open|door-retry-budget|empty-route|partial-path|unverified-collision-coverage|transition-required|no-progress|leg-timeout|map-initialization-timeout)$/.test(nav.reason??'')) {
      const routeId=receipt.methodId?.startsWith('survey:')?receipt.methodId.slice(7):undefined;
      const route=routeId?this.document.knowledge.routes[routeId]:undefined;
      // A route-owned survey has its own reversible route record.  For every
      // other goal, the failed approach belongs to the selected method rather
      // than to the whole capability: retire this bounded attempt, cool down
      // only that method/context pair, and let fresh evidence choose the next
      // safe plan.  Leaving a non-exploration parent active here used to
      // produce a retained-but-idle objective after a partial path.
      if(route&&(active.id==='survey:'+routeId||active.investigation?.id==='survey:'+routeId)) {
        this.deferSurvey(route,after,'EXHAUSTED_NAVIGATION: '+nav.reason,false);
      } else {
        if(receipt.methodId)this.director.executorUnavailable(this.catalogue(after).view,receipt.methodId,this.clock());
        this.deferCurrent(after,'EXHAUSTED_NAVIGATION: '+nav.reason,false);
      }
    }
    this.save();
  }
  summary() {
    const brief=(r:Receipt|undefined)=>r?{commandId:r.commandId,action:r.action,startedAt:r.startedAt,investigation:r.investigation}:undefined;
    const observation=this.document.lastObservation;
    const health=progressHealth(this.director.memory,this.clock());
    const verifiedAt=health.lastVerifiedActionAt??(this.document.lastOutcome?.status==='verified'?this.document.lastOutcome.at:null);
    const objectiveAt=health.lastObjectiveProgressAt??this.director.memory.active?.lastObjectiveProgressAt??null;
    const supportAt=health.lastSupportProgressAt??this.director.memory.active?.lastSupportProgressAt??null;
    const measurableAt=Math.max(objectiveAt??0,supportAt??0)||null;
    const ageMs=observation?.at===undefined?null:Math.max(0,this.clock()-observation.at);
    const stage=measurableAt!==null&&(!verifiedAt||measurableAt>=verifiedAt)?'measurable-progress'
      :verifiedAt!==null?'verified'
      :this.document.receipt||this.document.safetyReceipt?'executing'
      :observation?.connected===true&&ageMs!==null&&ageMs<=120_000?'observing':'alive';
    return {sourceResources:this.sourceResources?.brief(),source:'agency-v2.json',acquisition:this.document.acquisition,routeFailures:this.document.knowledge.routeFailures,preparation:this.document.preparation,updatedAt:this.document.updatedAt,buildReadiness:this.document.buildReadiness,development:this.document.development,
      lastObservation:this.document.lastObservation,lastOutcome:this.document.lastOutcome,losses:(this.document.losses??[]).slice(-8),
      progressHealth:{...health,stage:health.stalled?'stalled':stage,connected:observation?.connected===true,ageMs,lastObservationAt:observation?.at??null,
        lastVerifiedOutcomeAt:verifiedAt,lastObjectiveProgressAt:objectiveAt,lastSupportProgressAt:supportAt,
        noProgressAttempts:this.director.memory.active?.noProgress??0,
        preparationOnlyStreak:this.director.memory.active?.preparationOnlyStreak??0},
      transactionQuarantine:(this.document.transactionQuarantine??[]).slice(-8).map(({originalReceipt,...brief})=>brief),
      historicalRetirements:(this.document.historicalRetirements??[]).slice(-8).map(({receipt,...brief})=>brief),
      discoveryRetryAt:this.document.discoveryRetryAt,executorEpisode:this.document.executorEpisode,
      goal:this.director.memory.active,pending:brief(this.pending()),safetyPending:brief(this.pending('safety')),blocked:this.document.blocked};
  }
}
export const isSelection=(v:Selection|Decision):v is Selection=>'decision' in v;

export function safetyAction(state:LiveState,action:LiveCandidate):boolean {
  const hp=Number(state.player?.hp),max=Number(state.player?.maxHp);
  const danger=state.player?.combat?.inCombat===true||state.player?.combat?.targetType==='player'||hp<=max*.8
    || Number(state.player?.combat?.lastDamageTick)>=0&&Number(state.tick)-Number(state.player.combat.lastDamageTick)>=0&&Number(state.tick)-Number(state.player.combat.lastDamageTick)<=10;
  if(!danger)return false;
  if(action.type==='retreat')return true;
  if(['closeModal','closeShop'].includes(action.type))return state.bank?.isOpen===true||state.shop?.isOpen===true||state.dialog?.isOpen===true||state.modalOpen===true;
  if(action.type!=='useInventoryItem')return false;
  const item=(state.inventory??[]).find((i:any)=>i.slot===action.fields?.slot);
  return hp<max && (item?.optionsWithIndex??[]).some((o:any)=>o.opIndex===action.fields?.optionIndex&&/^eat$/i.test(String(o.text)));
}

/** A neutral UI close has no value transfer or dialogue choice.  It is allowed
 * only against an interface observed open in this exact state, and is used to
 * return to a planning-safe view after bounded executor exhaustion. */
export function neutralInterfaceRecovery(state:LiveState,action:LiveCandidate):boolean {
  if(action.type==='closeShop')return state.shop?.isOpen===true;
  return action.type==='closeModal'&&(state.bank?.isOpen===true||state.dialog?.isOpen===true||state.modalOpen===true);
}

/** Authorize by the selected live option, not by action-name regexes. */
export function authorizeAction(state:LiveState,action:LiveCandidate,method:Method,spendableGp:number):number {
  if(action.fields?.playerIndex!==undefined || action.fields?.targetType==='player' || /attackPlayer|tradeAccept|offerItem|confirmTrade/i.test(action.type))
    throw new Error('PVP_OR_UNVERIFIED_TRANSFER_DISABLED');
  if(state.inGame===false||state.player?.isDead===true||!(Number(state.player?.hp)>0))throw new Error('DISCONNECTED_OR_DEAD');
  if(method.risk==='pvp'||method.risk==='unknown')throw new Error('UNBOUNDED_METHOD_DISABLED');
  const allowed=['walkTo','scanNearbyLocs','closeModal','closeShop','wait','retreat','useInventoryItem','equip','setCombatStyle',
    'interactNpc','interactLoc','talkToNpc','pickupItem','useItemOnItem','useItemOnLoc','shopBuy','shopSell','bankDeposit','bankWithdraw','clickDialogOption','acceptCharacterDesign'];
  if(!allowed.includes(action.type))throw new Error('UNREGISTERED_OPERATION');
  if(action.type==='interactNpc') {
    const npc=(state.nearbyNpcs??[]).find((n:any)=>n.index===action.fields?.npcIndex);
    const option=(npc?.optionsWithIndex??[]).find((o:any)=>o.opIndex===action.fields?.optionIndex);
    if(!npc||npc.reachable!==true||!option)throw new Error('FRESH_NPC_OPTION_REQUIRED');
    if(/^attack$/i.test(String(option.text)) && (method.risk!=='bounded'||method.domain!=='combat'))throw new Error('COMBAT_REQUIRES_A_BOUNDED_COMBAT_METHOD');
  }
  if(action.type==='interactLoc') {
    const f=action.fields??{},loc=(state.nearbyLocs??[]).find((l:any)=>l.id===f.locId&&l.x===f.x&&l.z===f.z);
    const option=(loc?.optionsWithIndex??[]).find((o:any)=>o.opIndex===f.optionIndex),p=state.player;
    const samePlane=Number(loc?.level??p?.level??0)===Number(p?.level??0);
    const adjacent=samePlane&&Math.max(Math.abs(Number(p?.worldX)-Number(loc?.x)),Math.abs(Number(p?.worldZ)-Number(loc?.z)))<=1;
    if(!loc||!option||!(loc.reachable===true||adjacent))throw new Error('FRESH_LOC_OPTION_REQUIRED');
  }
  bindItems(action,state); // Refuse absent/changed items before creating any pending journal.
  if(action.type==='shopBuy') {
    const row=(state.shop?.shopItems??[]).find((i:any)=>i.slot===action.fields?.slot),n=Number(action.fields?.amount);
    if(!state.shop?.isOpen||!row||!Number.isFinite(row.buyPrice)||row.buyPrice<0||!Number.isInteger(n)||n<1||Number(row.count)<n)
      throw new Error('FRESH_SHOP_PRICE_QUANTITY_AND_STOCK_REQUIRED');
    const cost=Number(row.buyPrice)*n;
    if(cost>spendableGp||cost>cash(state.inventory??[]))throw new Error('SUPPLY_PRESERVING_BUDGET_EXCEEDED');
    return cost;
  }
  return 0;
}
