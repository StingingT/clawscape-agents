import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Director, createMemory } from './director.ts';
import type { Decision, Identity, Memory, Method, Observation, Outcome } from './types.ts';
import { buildCatalogue, capabilityContext, cash, defaultPolicy, emptyKnowledge, observeFacts, observeKnowledge,
  type Catalogue, type Knowledge, type LiveState, type Policy, type Route, type Task, type TaskKind } from './world-model.ts';

export type LiveCandidate = { id: string; type: string; fields?: Record<string, any>; waitTicks?: number };
export type Selection = { decision: Extract<Decision,{type:'execute'}>; method: Method; task: Task; view: Observation };
export type Receipt = { commandId:string; action:LiveCandidate; before:LiveState; startedAt:number; scope:'task'|'safety'; methodId?:string; execution?:{navigation?:{status:string;reason?:string;movementDispatched?:boolean}}; stationary?:{tick:number;position:string;since:number} };
type Document = { version:2; memory:Memory; knowledge:Knowledge; receipt?:Receipt; safetyReceipt?:Receipt;
  lastCommands:string[]; route?:{goalKey:string;methodId:string;action:LiveCandidate}; blocked?:string };
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
  constructor(file:string,identity:Identity,options:{policy?:Partial<Policy>;supported:TaskKind[];routes?:Route[];
    preferences?:Memory['preferences'];now?:()=>number}) {
    this.file=file;this.identity={...identity};this.supported=options.supported;this.routes=options.routes??[];
    this.policy={...defaultPolicy,...options.policy};this.clock=options.now??Date.now;
    if (!Object.entries(this.policy).every(([_,v])=>v===undefined||Number.isFinite(v)&&Number(v)>=0)
      || !Number.isInteger(this.policy.maxDeaths) || this.policy.foodTarget<1 || this.policy.maxDurationMs<=0)
      throw new Error('INVALID_AGENCY_POLICY');
    if(existsSync(file)) {
      const saved=JSON.parse(readFileSync(file,'utf8'));
      if(saved.version!==2)throw new Error('LEGACY_AGENCY_MEMORY_REQUIRES_RECONCILIATION_AND_MIGRATION');
      this.document=saved;
    } else this.document={version:2,memory:createMemory(identity,options.preferences),knowledge:emptyKnowledge(),lastCommands:[]};
    const memory=this.document.memory;
    if(memory.agent!==identity.agent||memory.world!==identity.world||memory.revision!==identity.revision)throw new Error('AGENCY_IDENTITY_MISMATCH');
    if (!!memory.pending!==!!this.document.receipt || (memory.pending && memory.pending.commandId!==this.document.receipt?.commandId))
      throw new Error('AGENCY_JOURNAL_INCONSISTENT');
    this.director=new Director(memory);
  }
  private save() { atomic(this.file,this.document); }
  catalogue(state:LiveState):Catalogue {
    if(state.character && String(state.character).toLowerCase()!==this.identity.agent.toLowerCase())throw new Error('OBSERVATION_AGENT_MISMATCH');
    if(state.world && state.world!==this.identity.world)throw new Error('OBSERVATION_WORLD_MISMATCH');
    observeKnowledge(state,this.document.knowledge,this.clock(),this.routes);
    return buildCatalogue(this.identity,state,this.document.knowledge,this.policy,this.supported,this.director.memory,this.clock());
  }
  plan(state:LiveState):Selection|Decision {
    if(this.document.safetyReceipt)return {type:'blocked',reason:'Reconcile the safety action before any further dispatch.',missingCapabilities:[]};
    const catalogue=this.catalogue(state), decision=this.director.next(catalogue.view,catalogue.opportunities,catalogue.methods);
    if(decision.type==='blocked'&&catalogue.methods.some(m=>m.risk==='unknown'))
      decision.reason+=' Combat loss valuation is unknown: provide an audited carried-kit replacement-loss ceiling in agency-policy.json.';
    this.document.blocked=decision.type==='blocked'?decision.reason:undefined;this.save();
    if(decision.type!=='execute')return decision;
    const method=catalogue.methods.find(m=>m.id===decision.step.methodId),task=catalogue.tasks.get(decision.step.methodId);
    if(!method||!task)throw new Error('UNREGISTERED_PLANNED_METHOD');
    return {decision,method,task,view:catalogue.view};
  }
  pending(scope:'task'|'safety'='task'):Receipt|undefined {
    const receipt=scope==='safety'?this.document.safetyReceipt:this.document.receipt;
    return receipt && structuredClone(receipt);
  }
  /** Persist only command-scoped executor evidence, never an entire global navigation cache. */
  rememberExecution(commandId:string,result:any):void {
    const r=this.document.receipt?.commandId===commandId?this.document.receipt:this.document.safetyReceipt;
    if(!r||r.commandId!==commandId)throw new Error('EXECUTION_WITHOUT_MATCHING_INTENT');
    if(result?.navigation)r.execution={navigation:{status:String(result.navigation.status),
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
  /** Only idempotent navigation/read steps can expire without causal success evidence.
   * Require two fresh stationary observations after the settling window. Never use for
   * dialogue, production, purchases, transfers, eating, or other inventory mutations. */
  settleNavigation(commandId:string,state:LiveState):Verification|undefined {
    const r=this.document.receipt?.commandId===commandId?this.document.receipt:this.document.safetyReceipt;
    if(!r||r.commandId!==commandId||!['walkTo','retreat'].includes(r.action.type))return;
    const a=state.player,b=r.before.player;
    if(!a||!b||a.lifeId!==b.lifeId||a.level!==b.level||state.inGame===false||a.isDead||a.combat?.inCombat)return;
    if(r.before.sessionId && state.sessionId && r.before.sessionId!==state.sessionId)return;
    if(![a.worldX,a.worldZ,a.level,state.tick,r.before.tick].every(Number.isFinite)||state.tick<=r.before.tick)return;
    if(a.animId!==-1)return; // No idle evidence means no safe automatic retirement.
    const position=JSON.stringify([a.worldX,a.worldZ,a.level]);
    const previous=r.stationary;
    if(!previous||previous.position!==position){r.stationary={tick:state.tick,position,since:this.clock()};this.save();return;}
    if(state.tick<=previous.tick||this.clock()-Math.max(r.startedAt,previous.since)<30_000)return;
    return {status:'interrupted',evidence:['two fresh stationary idle observations after navigation settling window; no action replay and no success inferred'],reason:'Navigation leg retired as interrupted; retain the goal and reassess the route.'};
  }
  blocked(reason:string):void {
    this.director.blocked(this.clock(),reason);this.document.blocked=reason;this.save();
  }
  /** No re-selection here. A refused begin MUST prevent normal execution. */
  begin(selection:Selection,action:LiveCandidate,state:LiveState,commandId=randomUUID()):string {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const view=this.catalogue(state).view;
    if(view.context!==selection.view.context)throw new Error('CAPABILITY_CONTEXT_CHANGED');
    const cost=authorizeAction(state,action,selection.method,view.budget.spendableGp);
    const priced={...selection.method,costGp:cost};
    this.director.begin(view,selection.decision,priced,commandId);
    this.document.receipt={commandId,action:structuredClone(action),before:structuredClone(state),startedAt:this.clock(),scope:'task',methodId:selection.method.id};
    if(action.type==='walkTo')this.document.route={goalKey:selection.decision.goal.key,methodId:selection.method.id,action:structuredClone(action)};
    this.save();return commandId;
  }
  /** Urgent survival is independent of the goal; it cannot overwrite an unresolved ordinary intent. */
  beginSafety(action:LiveCandidate,state:LiveState,commandId=randomUUID()):string {
    if(this.document.safetyReceipt)throw new Error('RECONCILE_SAFETY_ACTION_FIRST');
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
    const state=this.catalogue(after).view;
    if(verification.status==='interrupted')delete this.document.route;
    const deaths=Number(after.player?.lifeId!==receipt.before.player?.lifeId);
    // Without server-attributed loss valuation a death cannot be called a free successful attempt.
    if(deaths && !metrics)verification={status:'unknown',evidence:[],reason:'Death requires inventory/loss reconciliation.'};
    const deltas=metrics??{
      spentGp:receipt.action.type==='shopBuy'&&verification.status==='verified'?Math.max(0,cash(receipt.before.inventory??[])-cash(after.inventory??[])):0,
      lostGp:0,deaths,elapsedMs:Math.max(0,this.clock()-receipt.startedAt),
    };
    if(safety) {
      if(verification.status==='unknown'||!verification.evidence.length){this.save();return;}
      delete this.document.safetyReceipt;
    } else {
      const pending=this.director.memory.pending;
      if(!pending || pending.commandId!==commandId)throw new Error('OUTCOME_WITHOUT_MATCHING_INTENT');
      const productive=Object.keys(pending.method.effects).some(k=>(state.facts[k]??0)>(pending.before[k]??0));
      const status:Outcome['status']=verification.status==='verified'&&!productive?'progress':verification.status;
      this.director.record({commandId,sequence:this.director.memory.sequence+1,status,at:state.at,facts:state.facts,
        ...deltas,evidence:verification.evidence});
      if(!this.director.memory.pending)delete this.document.receipt;
    }
    if(!this.document.receipt || this.document.receipt.commandId!==commandId)
      this.document.lastCommands=[...this.document.lastCommands,commandId].slice(-128);
    this.save();
  }
  summary() {
    const brief=(r:Receipt|undefined)=>r?{commandId:r.commandId,action:r.action,startedAt:r.startedAt}:undefined;
    return {goal:this.director.memory.active,pending:brief(this.pending()),safetyPending:brief(this.pending('safety')),blocked:this.document.blocked};
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
