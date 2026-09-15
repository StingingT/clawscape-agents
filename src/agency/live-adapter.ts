import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateBuildRules, type BuildRules } from './build-rules.ts';
import { chooseDevelopment, reviewDevelopment, developmentReadiness, guardDevelopment, protectedXpChanged, type Development } from './development.ts';
import { observeQuietStep, recordViability, retryAllowed, stepKey, type QuietWindow, type Viability } from './step-retry.ts';
import { meaningfulFrontierRoute, reconcileDeathLoss } from './reconciliation.ts';
import { addAcquisition, emptyAcquisition, observeAcquisitionSources, rememberAcquisitionSources, type AcquisitionMemory, type AcquisitionHint } from './acquisition.ts';
import type { DropLead } from './drop-leads.ts';
import { bindItems, resolveItems, itemFact, itemCount, type ItemNeed, type ItemRef } from './item-intents.ts';
import { randomUUID } from 'node:crypto';
import { emptyTrips, preparation, observeTrip, recordTripEffect, type TripLearning, type TripPreparation } from './trip-logistics.ts';
import { Director, createMemory } from './director.ts';
import type { Decision, Identity, Memory, Method, Observation, Outcome } from './types.ts';
import { buildCatalogue, capabilityContext, cash, defaultPolicy, emptyKnowledge, observeFacts, observeKnowledge, discoveryFact,
  type Catalogue, type Knowledge, type LiveState, type Policy, type Route, type Task, type TaskKind } from './world-model.ts';

export type LiveCandidate = { itemRefs?:ItemRef[]; id: string; type: string; fields?: Record<string, any>; waitTicks?: number };
export type Selection = { decision: Extract<Decision,{type:'execute'}>; method: Method; task: Task; view: Observation };
export type Receipt = { commandId:string; action:LiveCandidate; before:LiveState; startedAt:number; scope:'task'|'safety'; methodId?:string; execution?:{accepted?:boolean;phase?:string;navigation?:{status:string;reason?:string;movementDispatched?:boolean}}; stationary?:QuietWindow };
type Document = { acquisition?:AcquisitionMemory; interruptions?:Array<{at:number;receipt:Receipt;reason:string}>; trips?:TripLearning; preparation?:TripPreparation; version:2; memory:Memory; knowledge:Knowledge; receipt?:Receipt; safetyReceipt?:Receipt;
  buildReadiness?:ReturnType<typeof developmentReadiness>; lastCommands:string[]; route?:{goalKey:string;methodId:string;action:LiveCandidate}; blocked?:string; development?:Development; updatedAt?:number;
  retries?:Record<string,Viability>; lastOutcome?:{at:number;commandId:string;type:string;status:string;reason?:string;evidence:string[]};
  losses?:Array<{at:number;commandId:string;lifeFrom:any;lifeTo:any;lostGp:number;items:Array<{id:number|string;count:number;name?:string}>}>;
  lastObservation?:{at:number;tick?:number;connected?:boolean;position?:{x:number;z:number;level:number}} };
export type Verification = { status:'verified'|'rejected'|'unknown'|'interrupted'; evidence:string[]; reason?:string };

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
  private readonly observer = randomUUID();
  constructor(file:string,identity:Identity,options:{policy?:Partial<Policy>;supported:TaskKind[];routes?:Route[];
    dropLeads?:DropLead[];acquisitionHints?:AcquisitionHint[];preferences?:Memory['preferences'];now?:()=>number;developmentHint?:string;buildRules?:BuildRules}) {
    this.dropLeads=options.dropLeads??[];this.acquisitionHints=options.acquisitionHints??[];
    this.file=file;this.identity={...identity};this.supported=options.supported;this.routes=options.routes??[];
    this.policy={...defaultPolicy,...options.policy};this.clock=options.now??Date.now;this.developmentHint=options.developmentHint;
    this.buildRules=options.buildRules?validateBuildRules(options.buildRules,identity):undefined;
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
  catalogue(state:LiveState):Catalogue {
    if(state.character && String(state.character).toLowerCase()!==this.identity.agent.toLowerCase())throw new Error('OBSERVATION_AGENT_MISMATCH');
    if(state.world && state.world!==this.identity.world)throw new Error('OBSERVATION_WORLD_MISMATCH');
    this.document.lastObservation={at:this.clock(),tick:state.tick,connected:state.inGame,position:state.player && {x:state.player.worldX,z:state.player.worldZ,level:state.player.level}};
    observeKnowledge(state,this.document.knowledge,this.clock(),this.routes);
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
    return catalogue;
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
      this.director.retireObsoleteSurveys(new Set(Object.keys(this.document.knowledge.routes)),this.clock());
      this.director.reviseFoodNeed(this.document.preparation!.foodTarget,this.clock());
    }
    const decision=this.director.next(catalogue.view,catalogue.opportunities,catalogue.methods);
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
    const result=observeQuietStep(r.action,r.before,state,this.clock(),this.observer,r.stationary);
    r.stationary=result.window;
    this.document.blocked=result.reason;this.save();
    return result.settled?{status:'interrupted',evidence:[result.reason],reason:result.reason}:undefined;
  }
  /** Retire a non-transactional receipt inherited from an earlier runtime when two fresh own observations
   * still cannot attribute its terminal effect. This never calls the executor and never records success.
   * Purchases, bank transfers and dialogue choices remain strict because replay could duplicate value/choice. */
  retireRestartPending(scope:'task'|'safety',first:LiveState,stable:LiveState,reason:string):boolean {
    const receipt=scope==='safety'?this.document.safetyReceipt:this.document.receipt;
    if(!receipt)return false;
    const strict=new Set(['shopBuy','shopSell','bankDeposit','bankWithdraw','clickDialogOption']);
    if(strict.has(receipt.action.type))return false;
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
    return retryAllowed(this.document.retries?.[stepKey(current,state)],this.clock(),capabilityContext(state),this.director.memory.learningRevision??0);
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
  deferCurrent(state:LiveState,reason:string):void {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal=this.director.memory.active;if(!goal)return;
    this.director.deferCurrent(this.clock(),reason,[`fresh-no-executor:${state.tick}:${goal.id}`]);
    delete this.document.route;this.document.blocked=reason;this.save();
  }
  deferSurvey(route:Route,state:LiveState,reason:string):void {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    this.document.knowledge.routeFailures??={};
    const old=this.document.knowledge.routeFailures[route.id],now=this.clock(),attempts=(old?.attempts??0)+1;
    this.document.knowledge.routeFailures[route.id]={at:now,retryAt:now+Math.min(30*60_000,60_000*2**Math.min(5,attempts)),
      attempts,context:capabilityContext(state),learningRevision:this.director.memory.learningRevision??0,reason};
    this.director.deferSurvey(route.id,now,reason,[`own-route-assessment:${state.tick}:${route.id}`]);
    delete this.document.route;this.document.blocked=reason;this.save();
  }
  blocked(reason:string):void {
    this.director.blocked(this.clock(),reason);this.document.blocked=reason;this.save();
  }
  /** No re-selection here. A refused begin MUST prevent normal execution. */
  begin(selection:Selection,action:LiveCandidate,state:LiveState,commandId:string=randomUUID()):string {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    action=bindItems(action,state);
    const view=this.catalogue(state).view;
    if(view.context!==selection.view.context)throw new Error('CAPABILITY_CONTEXT_CHANGED');
    if(!this.eligible(action,state))throw new Error('STEP_AWAITING_EVIDENCE_OR_COOLDOWN');
    guardDevelopment(this.document.development,state,action,selection.task.skill,this.buildRules);
    // A shop cannot spend banked money; preserve the carried working reserve too.
    const cost=authorizeAction(state,action,selection.method,Math.max(0,cash(state.inventory??[])-this.policy.reserveCoins));
    const priced={...selection.method,costGp:cost};
    this.director.begin(view,selection.decision,priced,commandId);
    this.document.receipt={commandId,action:structuredClone(action),before:structuredClone(state),startedAt:this.clock(),scope:'task',methodId:selection.method.id};
    if(action.type==='walkTo')this.document.route={goalKey:selection.decision.goal.key,methodId:selection.method.id,action:structuredClone(action)};
    this.save();return commandId;
  }
  /** Urgent survival is independent of the goal; it cannot overwrite an unresolved ordinary intent. */
  beginSafety(action:LiveCandidate,state:LiveState,commandId:string=randomUUID()):string {
    if(this.document.safetyReceipt)throw new Error('RECONCILE_SAFETY_ACTION_FIRST');
    action=bindItems(action,state);
    if(!safetyAction(state,action))throw new Error('NOT_AN_URGENT_SAFETY_ACTION');
    this.document.safetyReceipt={commandId,action:structuredClone(action),before:structuredClone(state),startedAt:this.clock(),scope:'safety'};
    this.save();return commandId;
  }
  record(commandId:string,after:LiveState,verification:Verification,metrics?:{spentGp:number;lostGp:number;deaths:number;elapsedMs:number}):void {
    if(this.document.lastCommands.includes(commandId))return;
    const safety=this.document.safetyReceipt?.commandId===commandId;
    const receipt=safety?this.document.safetyReceipt:this.document.receipt;
    if(!receipt && this.document.lastCommands.includes(commandId))return;
    if(!receipt||receipt.commandId!==commandId)throw new Error('OUTCOME_WITHOUT_MATCHING_INTENT');
    if(verification.status==='verified') {
      this.document.acquisition??=emptyAcquisition();rememberAcquisitionSources(this.document.acquisition,receipt.before,after,receipt.action,this.clock());
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
    if(verification.status==='interrupted')this.document.interruptions=[...(this.document.interruptions??[]),{at:this.clock(),receipt:structuredClone(receipt),reason:verification.reason??'interrupted'}].slice(-16);
    this.document.trips??=emptyTrips();
    recordTripEffect(this.document.trips,commandId,receipt.before,after,receipt.action,verification.status==='verified');
    const state=this.catalogue(after).view;
    if(verification.status==='interrupted' && verification.evidence.length)delete this.document.route;
    const deaths=Number(after.player?.lifeId!==receipt.before.player?.lifeId);
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
      this.director.record({commandId,sequence:this.director.memory.sequence+1,status,at:state.at,facts:state.facts,
        ...deltas,evidence:verification.evidence,actionType:receipt.action.type,
        observationOnly:['wait','scanNearbyLocs'].includes(receipt.action.type)});
      if(!this.director.memory.pending)delete this.document.receipt;
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
    this.save();
  }
  summary() {
    const brief=(r:Receipt|undefined)=>r?{commandId:r.commandId,action:r.action,startedAt:r.startedAt}:undefined;
    const observation=this.document.lastObservation;
    const verifiedAt=this.document.lastOutcome?.status==='verified'?this.document.lastOutcome.at:null;
    const objectiveAt=this.director.memory.active?.lastObjectiveProgressAt??null;
    const supportAt=this.director.memory.active?.lastSupportProgressAt??null;
    const measurableAt=Math.max(objectiveAt??0,supportAt??0)||null;
    const ageMs=observation?.at===undefined?null:Math.max(0,this.clock()-observation.at);
    const stage=measurableAt!==null&&(!verifiedAt||measurableAt>=verifiedAt)?'measurable-progress'
      :verifiedAt!==null?'verified'
      :this.document.receipt||this.document.safetyReceipt?'executing'
      :observation?.connected===true&&ageMs!==null&&ageMs<=120_000?'observing':'alive';
    return {source:'agency-v2.json',acquisition:this.document.acquisition,routeFailures:this.document.knowledge.routeFailures,preparation:this.document.preparation,updatedAt:this.document.updatedAt,buildReadiness:this.document.buildReadiness,development:this.document.development,
      lastObservation:this.document.lastObservation,lastOutcome:this.document.lastOutcome,losses:(this.document.losses??[]).slice(-8),
      progressHealth:{stage,connected:observation?.connected===true,ageMs,lastObservationAt:observation?.at??null,
        lastVerifiedOutcomeAt:verifiedAt,lastObjectiveProgressAt:objectiveAt,lastSupportProgressAt:supportAt,
        noProgressAttempts:this.director.memory.active?.noProgress??0,
        preparationOnlyStreak:this.director.memory.active?.preparationOnlyStreak??0},
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
