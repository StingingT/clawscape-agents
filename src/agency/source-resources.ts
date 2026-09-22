import { applyIntentPolicy } from './goal-intents.ts';
import { buildGoalReadiness, readGoalSettings } from './goal-readiness.ts';
/** Shared factual source, agent-local observations, and an explicitly bounded opt-in executor. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadSourceCatalogue, SOURCE_ADAPTER_VERSION, type SourceCatalogue } from '../catalog/source-catalogue.ts';
import { makePlan } from './director.ts';
import { buildSourceMethods, type SourceSettings, type SourceReport, type SourceTask } from './source-methods.ts';
import { sourceOutcome } from './source-outcome.ts';
import { sourceActions, type SourceDialog, type SourcePort, type SourceActionResult } from './source-actions.ts';
import type { Catalogue, Knowledge, LiveState, Policy } from './world-model.ts';
import type { AcquisitionMemory } from './acquisition.ts';
import type { Identity, Memory } from './types.ts';
import type { LiveCandidate, Selection, Verification } from './live-adapter.ts';

export const MAIN_SOURCE_AGENTS = ['clawscout', 'stinger', 'coincrafter', 'featherer'];
export const SOURCE_CONFIG = 'data/catalog/source-integration.json';
type PilotLedger = { version:1; pilotId:string; actions:number; quotedGp:number; dialog?:SourceDialog; last?:{at:number;type:string;methodId:string}; charges?:Record<string,{quotedGp:number;observedGp:number}> };
type Ticket = { methodId:string; action:string; snapshot:string; expires:number; pilotId:string; task:SourceTask };
const atomic=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';
  writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,file);};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actionKey=(action:LiveCandidate)=>digest({type:action.type,fields:action.fields??{}});
// A ticket is generated only after the dispatcher's second state read. It is not valid for a later observation.
const snapshotKey=(s:LiveState)=>digest({character:s.character,world:s.world,epoch:s.worldEpoch,session:s.sessionId,
  tick:s.tick,inGame:s.inGame,player:s.player,inventory:s.inventory,equipment:s.equipment,skills:s.skills,
  bank:s.bank,shop:s.shop,dialog:s.dialog,interface:s.interface,modalOpen:s.modalOpen,
  nearbyLocs:s.nearbyLocs,nearbyNpcs:s.nearbyNpcs,groundItems:s.groundItems,members:s.members,unavailable:s.unavailable});

export function readSourceSettings(root:string):SourceSettings|undefined {
  const file=resolve(root,SOURCE_CONFIG);if(!existsSync(file))return;
  const c=JSON.parse(readFileSync(file,'utf8')) as SourceSettings;
  const within=typeof c.directory==='string'?relative(resolve(root),resolve(root,c.directory)):'..';
  if(c.version!==1||!['shadow','pilot'].includes(c.mode)||typeof c.directory!=='string'||isAbsolute(c.directory)
    ||within==='..'||within.startsWith('..'+(process.platform==='win32'?'\\':'/'))
    ||!Array.isArray(c.pilotAgents)||c.pilotAgents.some(x=>!MAIN_SOURCE_AGENTS.includes(x))
    ||!Number.isSafeInteger(c.maxActions)||c.maxActions<1||c.maxActions>120
    ||!Number.isSafeInteger(c.maxSpendGp)||c.maxSpendGp<0||c.maxSpendGp>10000
    ||c.members!==undefined&&typeof c.members!=='boolean')throw new Error('INVALID_SOURCE_INTEGRATION_SETTINGS');
  if(c.requests!==undefined){if(!c.requests||typeof c.requests!=='object'||Array.isArray(c.requests))throw new Error('INVALID_SOURCE_REQUESTS');
    for(const [agent,requests] of Object.entries(c.requests))if(!MAIN_SOURCE_AGENTS.includes(agent)||!Array.isArray(requests)||requests.length>5
      ||requests.some(r=>!['string','number'].includes(typeof r.item)||!Number.isSafeInteger(r.quantity)||r.quantity<1||r.quantity>1000))throw new Error('INVALID_SOURCE_REQUESTS');}
  return c;
}

export class SourceResources {
  private source?:SourceCatalogue;
  private sourceDirectory?:string;
  private readonly configFile:string;
  readonly reportFile:string;
  private readonly ledgerFile:string;
  private lastReport?:SourceReport & {gateReason?:string;actionsRemaining?:number;spendRemainingGp?:number};
  private lastWrite=0;
  private lastGoalWrite=0;
  private readonly goalReportFile:string;
  private error?:string;
  private tickets=new Map<string,Ticket>();
  private readonly root:string;
  private readonly identity:Identity;
  private readonly clock:()=>number;
  constructor(root:string,agentFile:string,identity:Identity,clock:()=>number=Date.now) {
    this.root=root;this.identity=identity;this.clock=clock;
    this.configFile=resolve(root,SOURCE_CONFIG);
    this.reportFile=resolve(dirname(agentFile),'source-catalogue-report.json');
    this.goalReportFile=resolve(dirname(agentFile),'goal-planning-report.json');
    this.ledgerFile=resolve(dirname(agentFile),'source-catalogue-pilot.json');
  }
  private settings():SourceSettings|undefined {
    try {
      const c=readSourceSettings(this.root);if(!c)return;
      const directory=resolve(this.root,c.directory);
      if(directory!==this.sourceDirectory){this.source=loadSourceCatalogue(directory);this.sourceDirectory=directory;}
      this.error=undefined;return c;
    } catch(e){this.error=String(e);return;}
  }
  private ledger(c:SourceSettings):PilotLedger {
    if(!c.pilotId)throw new Error('SOURCE_PILOT_ID_REQUIRED');
    if(!existsSync(this.ledgerFile))return {version:1,pilotId:c.pilotId,actions:0,quotedGp:0};
    const saved=JSON.parse(readFileSync(this.ledgerFile,'utf8')) as PilotLedger;
    if(saved.version!==1||typeof saved.pilotId!=='string'||!Number.isSafeInteger(saved.actions)||saved.actions<0
      ||!Number.isSafeInteger(saved.quotedGp)||saved.quotedGp<0)throw new Error('SOURCE_PILOT_LEDGER_CORRUPT');
    // Only the operator's explicit new pilot command can introduce a different ID.
    return saved.pilotId===c.pilotId?saved:{version:1,pilotId:c.pilotId,actions:0,quotedGp:0};
  }
  private gate(c:SourceSettings,state:LiveState):{ok:boolean;reason:string;ledger?:PilotLedger} {
    if(c.mode!=='pilot')return {ok:false,reason:'Shadow mode: knowledge and plans are inspected; no new action is authorized.'};
    if(!MAIN_SOURCE_AGENTS.includes(this.identity.agent)||!c.pilotAgents.includes(this.identity.agent))return {ok:false,reason:'This worker is not selected for the local pilot.'};
    if(c.confirmedProfileId!==this.source?.data.profile.id||c.confirmedWorld!==this.identity.world)return {ok:false,reason:'Source profile and running world must be explicitly confirmed.'};
    if(state.character&&String(state.character).toLowerCase()!==this.identity.agent.toLowerCase()||state.world&&state.world!==this.identity.world)
      return {ok:false,reason:'Fresh character/world mismatch.'};
    if(state.inGame!==true||!Array.isArray(state.inventory)||!state.player||state.player.isDead===true||!(state.player.hp>0))
      return {ok:false,reason:'A complete living player observation is required.'};
    const now=this.clock();
    if(typeof c.pilotId!=='string'||c.pilotId.length<8||!Number.isFinite(c.expiresAt)||c.expiresAt!<=now||c.expiresAt!-now>15*60_000)
      return {ok:false,reason:'Pilot absent, expired, or exceeds the 15-minute wall-clock limit.'};
    try {const ledger=this.ledger(c);
      if(ledger.actions>=c.maxActions)return {ok:false,reason:'Pilot action budget exhausted.',ledger};
      return {ok:true,reason:'Explicit bounded local pilot; fresh per-action checks still required.',ledger};
    } catch(e){return {ok:false,reason:String(e)};}
  }
  private writeReport(force=false):void {
    const now=this.clock();if(!force&&now-this.lastWrite<15000)return;
    try {atomic(this.reportFile,this.lastReport??{version:SOURCE_ADAPTER_VERSION,agent:this.identity.agent,at:now,enabled:false,error:this.error??'No source configuration.'});this.lastWrite=now;}
    catch(e){this.error='SOURCE_REPORT_WRITE_FAILED: '+String(e);}
  }
  augment(c:Catalogue,state:LiveState,k:Knowledge,acquisition:AcquisitionMemory|undefined,policy:Policy,memory:Memory):void {
    const cfg=this.settings();if(!cfg||!this.source){if(this.error)this.writeReport();return;}
    const candidate:Catalogue={...c,view:{...c.view,facts:{...c.view.facts},capabilities:[...c.view.capabilities]},
      methods:[...c.methods],opportunities:[...c.opportunities],tasks:new Map(c.tasks)};
    const report=buildSourceMethods(this.source,candidate,state,k,acquisition,policy,memory,cfg,this.clock());
    const gate=this.gate(cfg,state);report.enabled=gate.ok;
    for(const goal of candidate.opportunities.filter(g=>g.id.startsWith('source-')).slice(0,6)) {
      const plan=makePlan(memory,candidate.view,goal,candidate.methods);
      report.plans.push(plan?{goal:goal.id,methods:plan.steps.map(s=>s.methodId),costGp:plan.costGp}:{goal:goal.id,blocked:true});
    }
    this.lastReport={...report,gateReason:gate.reason,
      ...(gate.ledger?{actionsRemaining:Math.max(0,cfg.maxActions-gate.ledger.actions),spendRemainingGp:Math.max(0,cfg.maxSpendGp-gate.ledger.quotedGp)}:{})};
    this.writeReport();
    let chosen=candidate,goalFailed=false,intentEnabled=false;
    try {
      const goalSettings=readGoalSettings(this.root);
      intentEnabled=goalSettings?.intentMode==='enforce';
      if(goalSettings&&((goalSettings.mode==='pilot'&&gate.ok)||this.clock()-this.lastGoalWrite>=15_000)){
        const analysis=buildGoalReadiness(this.source,c,state,k,acquisition,policy,memory,cfg,goalSettings,this.clock(),gate.ok);
        if(this.clock()-this.lastGoalWrite>=15_000){atomic(this.goalReportFile,analysis.report);this.lastGoalWrite=this.clock();}
        if(analysis.enabled)chosen=analysis.catalogue;
      }
    } catch(error) {
      goalFailed=true;
      // New diagnostic/forecast failure never authorizes new actions or damages existing memory.
      if(this.clock()-this.lastGoalWrite>=15_000){atomic(this.goalReportFile,{agent:memory.agent,at:this.clock(),enabled:false,error:String(error)});this.lastGoalWrite=this.clock();}
    }
    if(gate.ok&&!goalFailed){c.view=chosen.view;c.methods=chosen.methods;c.opportunities=chosen.opportunities;c.tasks=chosen.tasks;}
    // Apply on EVERY catalogue build, not only the 15-second diagnostic cadence. This never copies source methods into shadow gameplay.
    if(intentEnabled){applyIntentPolicy(c,k,memory,this.clock());c.intentPolicyEnabled=true;}
  }
  async actions(task:SourceTask,state:LiveState,port:SourcePort):Promise<SourceActionResult> {
    const cfg=this.settings();if(!cfg||!this.source)return {actions:[],reason:this.error??'Source integration is not configured.'};
    const g=this.gate(cfg,state);if(!g.ok)return {actions:[],reason:g.reason};
    const result=await sourceActions(this.source,task,state,cfg,port,g.ledger?.dialog,this.clock());
    if(result.reason&&this.lastReport){this.lastReport.blockers=[{id:'live-executor',reason:result.reason},...this.lastReport.blockers].slice(0,150);this.writeReport(true);}
    return result;
  }
  /** Rebuild the permitted packet from the second fresh state, after ordinary item-slot rebinding. */
  async preflight(selection:Selection,action:LiveCandidate,state:LiveState,port:SourcePort):Promise<LiveCandidate> {
    const task=selection.task.sourceResource;if(!task)throw new Error('SOURCE_TASK_REQUIRED');
    const cfg=this.settings();if(!cfg||!this.source)throw new Error(this.error??'SOURCE_NOT_CONFIGURED');
    const g=this.gate(cfg,state);if(!g.ok)throw new Error('SOURCE_GATE: '+g.reason);
    const observedAt=this.clock();
    const allowed=await this.actions(task,state,port);
    if(this.clock()-observedAt>1500)throw new Error('SOURCE_OBSERVATION_TOO_OLD: re-read state after route preparation.');
    if(!allowed.actions.some(a=>actionKey(a)===actionKey(action)))throw new Error('SOURCE_PREFLIGHT: '+(allowed.reason??'Proposed packet no longer matches the fresh source executor.'));
    if(action.type==='shopBuy'&&(task.expectedPrice??Infinity)+g.ledger!.quotedGp>cfg.maxSpendGp)throw new Error('SOURCE_GP_BUDGET_EXHAUSTED');
    const ticket=randomUUID();this.tickets.clear();
    this.tickets.set(ticket,{methodId:selection.method.id,action:actionKey(action),snapshot:snapshotKey(state),expires:this.clock()+5000,pilotId:cfg.pilotId!,task});
    return {...action,sourceAuthorization:ticket};
  }
  /** Reserve before the ordinary journal is committed. Refused attempts can consume budget, never grant credit. */
  authorize(selection:Selection,action:LiveCandidate,state:LiveState,commandId:string):void {
    const key=action.sourceAuthorization,ticket=key&&this.tickets.get(key);if(key)this.tickets.delete(key);
    const cfg=this.settings();if(!cfg||!this.source)throw new Error(this.error??'SOURCE_NOT_CONFIGURED');
    const g=this.gate(cfg,state);if(!g.ok)throw new Error('SOURCE_GATE: '+g.reason);
    if(!ticket||ticket.expires<this.clock()||ticket.methodId!==selection.method.id||ticket.pilotId!==cfg.pilotId
      ||ticket.action!==actionKey(action)||ticket.snapshot!==snapshotKey(state)||digest(ticket.task)!==digest(selection.task.sourceResource))throw new Error('SOURCE_FRESH_AUTHORIZATION_REQUIRED');
    const ledger=g.ledger!,cost=action.type==='shopBuy'?ticket.task.expectedPrice!:0;
    if(!Number.isSafeInteger(cost)||cost<0||ledger.quotedGp+cost>cfg.maxSpendGp)throw new Error('SOURCE_GP_BUDGET_EXHAUSTED');
    ledger.charges??={};if(ledger.charges[commandId])throw new Error('SOURCE_COMMAND_ALREADY_RESERVED');
    ledger.charges[commandId]={quotedGp:cost,observedGp:0};
    ledger.actions++;ledger.quotedGp+=cost;ledger.last={at:this.clock(),type:action.type,methodId:selection.method.id};
    if(ticket.task.recipeId==='recipe:fletch-shafts:fletching_normal'&&action.type==='useItemOnItem')
      ledger.dialog={recipeId:ticket.task.recipeId,lifeId:state.player.lifeId,at:this.clock()};
    else if(action.type==='clickDialogOption')delete ledger.dialog;
    atomic(this.ledgerFile,ledger);
  }
  reconcileSpend(commandId:string,before:LiveState,after:LiveState,action:LiveCandidate):void {
    if(action.type!=='shopBuy'||!existsSync(this.ledgerFile)||!Array.isArray(before.inventory)||!Array.isArray(after.inventory)
      ||before.player?.lifeId!==after.player?.lifeId||!(after.tick>before.tick))return;
    const ledger=JSON.parse(readFileSync(this.ledgerFile,'utf8')) as PilotLedger,charge=ledger.charges?.[commandId];
    if(!charge)return;
    const balance=(s:LiveState)=>s.inventory.filter((x:any)=>x.id===995).reduce((n:number,x:any)=>n+Number(x.count),0);
    const observed=Math.max(charge.observedGp,balance(before)-balance(after),0);
    if(!Number.isSafeInteger(observed))return;
    // Reserve the greater of the quote and observed payment, idempotently even while an outcome remains unknown.
    ledger.quotedGp+=Math.max(charge.quotedGp,observed)-Math.max(charge.quotedGp,charge.observedGp);
    charge.observedGp=observed;atomic(this.ledgerFile,ledger);
  }
  outcome(task:SourceTask,before:LiveState,after:LiveState,action:LiveCandidate,original:Verification):Verification {
    this.settings();return this.source?sourceOutcome(this.source,task,before,after,action,original):{status:'unknown',evidence:[],reason:'Source receipt needs its original catalogue for reconciliation.'};
  }
  brief(){return this.lastReport?{version:SOURCE_ADAPTER_VERSION,mode:this.lastReport.mode,enabled:this.lastReport.enabled,
    reason:this.lastReport.gateReason,registeredMethods:this.lastReport.registeredMethods,report:this.reportFile,
    actionsRemaining:this.lastReport.actionsRemaining,spendRemainingGp:this.lastReport.spendRemainingGp}:{version:SOURCE_ADAPTER_VERSION,enabled:false,error:this.error};}
}
