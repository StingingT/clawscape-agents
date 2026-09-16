import { finalizeQuarantinedAction } from './transaction-quarantine.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Config, CompatibilityProfile, type Observation, type Intent } from './contracts.ts';
import { CliSession, LiveAdapter } from './live-adapter.ts';
import { ActionArbiter, type SafetyPolicy } from './arbiter.ts';
import { Store } from './store.ts';
import { LiveNavigator } from './live-navigation.ts';
import { LivePolicy, type LiveDecision } from './live-policy.ts';
import { Learner, OBJECTIVE, POLICY, contextKey } from './learning.ts';
import { researchTraining, type ResearchSummary } from './guide-research.ts';
import { liveHazardAt } from './live-hazards.ts';
import {prepareRecovery,runRecovery} from './recovery-runner.ts';
import {recoveryPreflight,RECOVERY_ID} from './live-recovery.ts';
import { LiveAgency, isSelection, type Selection } from '../../../src/agency/live-adapter.ts';
import { reconcileAstraJournals } from './restart-journals.ts';
import { acquireController } from '../../../src/controller-lease.ts';
import { runWithStartupStatus, readRequiredJson, checkedUpstream, type StartupContext } from './startup.ts';
import { agencyState, agencyCandidate, arbiterVerification, observedVerification, urgentDecision } from './agency-bridge.ts';
import { recoverableExecutorBlock } from './replanning.ts';

const codeRoot=resolve(import.meta.dir,'..');
const argv=process.argv.slice(2),mode=argv[0]??'status';
const option=(name:string,fallback:string)=>{const i=argv.indexOf('--'+name);return i>=0?(argv[i+1]??fallback):fallback;};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const atomic=(file:string,value:unknown)=>{const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2));renameSync(tmp,file);};
const brief=(o:Observation)=>({tick:o.tick,connected:o.connected,position:o.position,hp:o.hp,maxHp:o.max_hp,
  lifeId:o.life_id,respawns:o.respawns,skills:o.skills,inventory:o.inventory.map(i=>({name:i.name,count:i.count})),
  equipment:o.equipment.map(i=>({name:i.name,count:i.count}))});
export async function main(context:StartupContext){
  const {root,data}=context;
  mkdirSync(data,{recursive:true});
  if(mode==='status'){
    console.log(existsSync(join(data,'status.json'))?readFileSync(join(data,'status.json'),'utf8'):JSON.stringify({character:'astra',live:false,status:'NOT_STARTED'}));return;
  }
  if(existsSync(join(data,'agency-v2.json'))&&!existsSync(join(data,'journal.sqlite')))
    throw new Error('EXECUTOR_JOURNAL_MISSING');
  const administrative=['pause','stop','takeover','hard-disable','resume'].includes(mode);
  let config!: ReturnType<typeof Config.parse>;
  if(!administrative) {
  context.publish('STARTING','VALIDATING_CONFIGURATION');
  const configFile=resolve(root,option('config','config.local.json'));
  const configValue=readRequiredJson(configFile,'CONFIG_FILE_MISSING','CONFIG_FILE_INVALID');
  const parsedConfig=Config.safeParse(configValue);
  if(!parsedConfig.success)throw new Error('CONFIG_SCHEMA_INVALID');
  config=parsedConfig.data;
  if(config.mode!=='live'||config.live_control!=='local-single-controller')throw new Error('LIVE_CONFIGURATION_REQUIRED');
  }
  const releaseController=['run','pilot','recover','reconcile'].includes(mode)?acquireController(join(data,'controller.lock')):()=>{};
  let store:Store|undefined;
  let renewal:ReturnType<typeof setInterval>|undefined;
  let navigator:LiveNavigator|undefined;
  let lease:string|undefined;
  try {
  store=new Store(join(data,'journal.sqlite'));
  if(['pause','stop','takeover','hard-disable','resume'].includes(mode)){
      if(mode==='resume')store.releaseManual();
      else store.setControl(({pause:'PAUSED',stop:'STOPPED',takeover:'MANUAL','hard-disable':'DISABLED'} as const)[mode as 'stop']);
      console.log(JSON.stringify({scope:'astra-live-only',control:store.control().mode,
        warning:'Revokes cooperating controller commands. Does not freeze the game; resume requires a new run.'}));
    return;
  }
  context.publish('STARTING','VALIDATING_OWNER_CLI_CONFIGURATION');
  const cli=new CliSession(config,root);
  if(mode==='setup'){
      const owned=await cli.command(['characters','list']);
      if(!owned.characters?.some((c:any)=>c.name==='astra')){
        if(!argv.includes('--create'))throw new Error('ASTRA_NOT_CREATED');
        const result=await cli.command(['characters','create','astra']);
        if(result.error)throw new Error('CHARACTER_CREATE_REJECTED');
      }
      console.log(JSON.stringify({character:'astra',owned:true,connected:false,gameActions:0}));
    return;
  }
  if(!['pilot','run','observe','reconcile','recover'].includes(mode))throw new Error('UNKNOWN_LIVE_COMMAND');
  const lastKnown=store.records<Observation>('observations_or_checkpoints').filter(o=>o.position!==null).at(-1);
  if(['run','pilot'].includes(mode)&&lastKnown&&liveHazardAt(lastKnown.position)){
    throw new Error('KNOWN_HAZARD_RECOVERY_REQUIRED');
  }
  const profileValue=readRequiredJson(join(root,'docs/compatibility-profile.json'),'COMPATIBILITY_PROFILE_MISSING','COMPATIBILITY_PROFILE_INVALID');
  const profileResult=CompatibilityProfile.safeParse(profileValue);
  if(!profileResult.success)throw new Error('COMPATIBILITY_PROFILE_INVALID');
  const profile=profileResult.data;
  const adapter=new LiveAdapter(cli,profile.profile_id,store.records<Observation>('observations_or_checkpoints').at(-1)?.seq??0);
  if(mode==='recover'){
      recoveryPreflight(lastKnown,profile.profile_id,store.records<{id:string}>('recovery_attempts').some(r=>r.id===RECOVERY_ID));
      // Finish map work BEFORE logging in at a dangerous location.
      process.env.CLAWSCAPE_UPSTREAM=checkedUpstream(root,config.game_root);
      const route=await prepareRecovery();
      const report=await runRecovery({store,adapter,config,profile:profile.profile_id,last:lastKnown,route,
        connect:()=>cli.command(['connect'],25_000),disconnect:()=>cli.command(['disconnect']),
        publish:r=>{
          const value={character:'astra',time:new Date().toISOString(),mode,...r,
            observation:r.observation?brief(r.observation):null};
          atomic(join(data,'recovery-status.json'),value);atomic(join(data,'status.json'),value);
          console.log(JSON.stringify({...value,observation:r.observation?{connected:r.observation.connected,
            tick:r.observation.tick,position:r.observation.position,hp:r.observation.hp}:null}));
        }});
      if(report.status!=='RECOVERED')process.exitCode=1;
    return;
  }
  if(mode==='observe'){
    await adapter.snapshot();await sleep(500);console.log(JSON.stringify(brief(await adapter.snapshot())));return;
  }
  lease=store.acquireRecovery('astra-live:'+process.pid,Date.now());
  let revoked=false,latest:Observation|undefined,start:Observation|undefined,finished=false,reason='SESSION_LIMIT';
  renewal=setInterval(()=>{try{store.renew(lease,Date.now());}catch{revoked=true;}},1000);
  if(mode!=='reconcile') {
    context.publish('STARTING','VALIDATING_COLLISION_RUNTIME');
    process.env.CLAWSCAPE_UPSTREAM=checkedUpstream(root,config.game_root);
    navigator=new LiveNavigator();
    await navigator.waitUntilReady();
  }
  const recordedRoutes=new WeakSet<object>();
  let navigation:unknown=null;
  const checkpoint=store.records<any>('live_policy_checkpoints').at(-1);
  const saved=checkpoint?.state??checkpoint;
  let policy=new LivePolicy();let policyInitialized=false;
  let agency:LiveAgency|undefined;
  let research:ResearchSummary|undefined,researchJob:Promise<void>|undefined;
  let researchQueued=0;
  const queueResearch=()=>{
    if(researchJob||mode!=='run'||researchQueued>=2)return;
    const recent=store.records<{at:number;reserved:number}>('research_budget').filter(r=>Date.now()-r.at<3_600_000);
    const quota=Math.min(2,config.max_research_searches_per_hour-recent.reduce((n,r)=>n+r.reserved,0));
    if(quota<=0)return;
    store.append('research_budget',crypto.randomUUID(),{at:Date.now(),reserved:quota});researchQueued++;
    researchJob=researchTraining({profileId:profile.profile_id,cachePath:join(data,'guide-cache.json'),maxRequests:quota}).then(result=>{
      research=result;
      policy.setResearchHints(result.suggestedMonsters,result.claims.map(c=>c.claim_id));
      for(const claim of result.claims)store.append('research_claims',claim.claim_id,claim);
      store.append('research_results',crypto.randomUUID(),result);
    }).catch(()=>{store.append('events',crypto.randomUUID(),{kind:'RESEARCH_UNAVAILABLE',at:Date.now()});})
      .finally(()=>{researchJob=undefined;});
  };
  const safety:SafetyPolicy={maxStaleMs:config.max_stale_ms,maxDeaths:config.max_deaths,keepIds:config.keep_item_ids,
    allowedTiles:new Set(),safeEntities:new Set(),allowLocalEpoch:true,recoveryTiles:new Set(),
    foodRequirement:o=>agency?.tripPreparation(agencyState(o),'combat').foodTarget ?? 1};
  const arbiter=new ActionArbiter(store,adapter,safety);
  let activeGoal='initialise',actions=0,verified=0,failed=0,lastProgress=Date.now();
  const deadline=Date.now()+Math.min(config.max_session_minutes*60,Number(option('seconds',mode==='pilot'?'120':String(config.max_session_minutes*60))))*1000;
  let pilotMoved=false,pilotInteracted=false,pilotDestination:Observation['position']=null;
  const publish=(status:string,why:string)=>{
    const result={character:'astra',time:new Date().toISOString(),mode,status,live:latest?.connected===true,goal:agency?.summary().goal?.id??(agency?'selecting-next-goal':activeGoal),reason:why,
      actions,verified,failed,elapsedSeconds:start?Math.round((Date.now()-start.observed_at)/1000):0,
      observation:latest?brief(latest):null,policy:policy.summary(),pending:store.pending().map(p=>({operation:p.command.intent.operation,status:p.result.status,reason:p.result.reason})),
      authority:'single cooperating local controller; server fencing unavailable',npcSpendingGp:0,
      navigation,agency:agency?.summary(),
      research:research?{status:research.status,suggestedMonsters:research.suggestedMonsters,rejected:research.rejected,fetchedAt:research.fetchedAt}:null};
    context.publish(status,why,{...result,retryable:status==='RECONCILIATION_REQUIRED'?false:undefined});console.log(JSON.stringify({time:result.time,status,goal:activeGoal,reason:why,tick:latest?.tick,hp:latest?.hp,position:latest?.position,actions,verified,failed}));
  };
  try{
    context.publish('RECONCILING','CHECKING_EXECUTOR_AND_LEGACY_JOURNALS');
    if(mode!=='reconcile') {
      const connected=await cli.command(['connect'],25_000);
      if(connected.connected!==true)throw new Error('CONNECT_NOT_CONFIRMED');
    }
    const first=await adapter.snapshot();await sleep(600);latest=await adapter.snapshot();start=latest;
    if(mode==='run'||mode==='reconcile') {
      const settings=join(data,'agency-policy.json');
      agency=new LiveAgency(join(data,'agency-v2.json'),{agent:latest.character,world:latest.world,revision:profile.profile_id},{
        supported:['food','bank','equipment','combat','exploration','discovery'],preferences:{exploration:2,combat:1},
        policy:existsSync(settings)?readRequiredJson(settings,'AGENCY_POLICY_MISSING','AGENCY_POLICY_INVALID'):{},
        routes:[{id:'documented-draynor-approach',x:3088,z:3226,level:0,evidence:'documented lead; still requires collision-safe travel and own arrival'},
          {id:'documented-goblin-area',x:3252,z:3230,level:0,evidence:'documented lead; no encounter claimed before observation'},
          {id:'documented-chicken-area',x:3232,z:3295,level:0,evidence:'documented lead; no encounter claimed before observation'}],
      });
    }
    // Explicit renewal around potentially expensive journal scans prevents scheduler/SQLite stalls from
    // turning a valid sole-controller recovery lease into RECOVERY_LEASE_REQUIRED mid-reconciliation.
    store.renew(lease,Date.now());
    let recovery=reconcileAstraJournals(store,data,first,latest,agency);
    const settleUntil=Date.now()+45_000;
    while(!recovery.ready&&recovery.unresolved.some(r=>r.settling)&&Date.now()<settleUntil&&!revoked) {
      publish('RECONCILING','Observing stale transient journals; no actions dispatched');
      await sleep(1_000);const previous=latest;latest=await adapter.snapshot();
      store.renew(lease,Date.now());
      recovery=reconcileAstraJournals(store,data,previous,latest,agency);
    }
    if(!recovery.ready) {
      reason='JOURNAL_RECONCILIATION_REQUIRED';publish('RECONCILIATION_REQUIRED',reason);process.exitCode=2;return;
    }
    if(mode==='reconcile'){reason='JOURNALS_RECONCILED';publish('RECONCILED',reason);return;}
    store.promoteRecovery(lease,Date.now());
    if(saved?.uncertain) {
      // This policy-only duplicate has no authority to replay a command. Preserve it verbatim,
      // and retire its bookkeeping uncertainty only AFTER every executor receipt is accounted.
      store.append('retired_policy_uncertainty',crypto.randomUUID(),{at:Date.now(),original:saved.uncertain,reason:'executor journals reconciled; no success or reward inferred'});
      policy=new LivePolicy({...saved,uncertain:null});
    } else policy=new LivePolicy(saved);
    if(mode==='run')policy.resumeFromObservation(latest);
    policyInitialized=true;
    store.append('observations_or_checkpoints',crypto.randomUUID(),start);
    queueResearch();
    publish('RUNNING','Connected; waiting for verified effects');
    while(Date.now()<deadline&&!revoked){
      const previous=latest;
      latest=await adapter.snapshot();
      if(previous){
        policy.observe(previous,latest);
        if(!agency&&JSON.stringify(previous.skills)!==JSON.stringify(latest.skills))lastProgress=Date.now();
      }
      if(research?.rejected.some(r=>r.startsWith('QUEUED_SOURCES:')))queueResearch();
      if(!latest.connected||latest.hp===0){reason='DISCONNECTED_OR_DEAD';break;}
      if(!navigator!.isReady() && !latest.activity?.design_open && latest.danger.active===false
        && latest.hp===latest.max_hp){await sleep(700);continue;}
      let decision:LiveDecision;
      let planned:Selection|undefined;
      let emergency=false;
      if(mode==='pilot'){
        if(latest.activity?.design_open)decision={goal:'pilot-design',reason:'Accept ordinary tutorial appearance',intent:{operation:'accept_design'}};
        else if(!pilotMoved){
          pilotDestination??=latest.position?{...latest.position,x:latest.position.x+2}:null;
          decision=pilotDestination?{goal:'pilot-movement',reason:'Verify ordinary collision-routed movement',destination:pilotDestination}:{goal:'pilot',reason:'No position',blocked:'POSITION_UNKNOWN'};
        }else if(!pilotInteracted){
          const guide=latest.entities.find(e=>e.kind==='npc'&&/runescape guide/i.test(e.name)&&e.reachable===true&&e.options.some(p=>/^talk/i.test(p.text)));
          decision=guide?{goal:'pilot-interaction',reason:'Open observed guide dialogue',intent:{operation:'interact',entity_ref:guide.ref,option_index:guide.options.find(p=>/^talk/i.test(p.text))!.index}}
            :{goal:'pilot-interaction',reason:'No reachable tutorial guide',blocked:'GUIDE_UNAVAILABLE'};
        }else{
          // Live no-dispatch takeover check; then finish this bounded pilot.
          store.setControl('MANUAL');
          const result=await arbiter.submit({schema_version:'1.0',action_id:crypto.randomUUID(),character:'astra',world:latest.world,
            session_id:latest.session_id,world_epoch:latest.world_epoch,profile_id:latest.profile_id,lease,plan_id:'pilot-takeover-check',
            based_on_snapshot:latest.seq,expires_at:Date.now()+2000,intent:{operation:'move',destination:latest.position!}});
          store.append('live_acceptance',crypto.randomUUID(),{test:'takeover-rejects-old-controller',result});
          if(result.reason!=='CONTROL_REVOKED')throw new Error('TAKEOVER_TEST_FAILED');
          store.releaseManual();finished=true;reason='M1_MOVEMENT_INTERACTION_TAKEOVER_PASSED';break;
        }
      } else {
        if(!agency)throw new Error('AGENCY_NOT_INITIALIZED');
        // Reconcile the SAME journaled action. A later action cannot satisfy its receipt.
        for(const scope of ['safety','task'] as const){const r=agency.pending(scope);if(r)agency.settleStep(r.commandId,agencyState(latest));}
        await arbiter.reconcile();
        for (const scope of ['safety','task'] as const) {
          const receipt=agency.pending(scope);
          if(!receipt)continue;
          const stored=store.action(receipt.commandId);
          let proof=receipt.action.type==='wait'
            ? observedVerification(receipt.before,agencyState(latest),receipt.action)
            : stored ? arbiterVerification(receipt.commandId,stored.result)
            : {status:'rejected' as const,evidence:['No arbiter reservation exists; transport could not have started.']};
          if(proof.status==='unknown'){
            const observed=observedVerification(receipt.before,agencyState(latest),receipt.action);
            if(observed.status==='verified')proof=observed;
          }
          agency.record(receipt.commandId,agencyState(latest),proof);
          if(agency.pending(scope)&&scope==='task'&&proof.status==='unknown'&&stored) {
            const current=agencyState(latest);
            const observed=observedVerification(receipt.before,current,receipt.action);
            const q=agency.quarantinePendingTransaction(current,observed.reason??'');
            const retired=q&&finalizeQuarantinedAction(store,agency,q.commandId);
            if(retired&&receipt.before._advanced) {
              policy.retireReconciledOutcome(receipt.before._advanced,stored.command.intent,retired);
              store.append('live_policy_checkpoints',crypto.randomUUID(),policy.summary());
            }
          }
          if(proof.status==='interrupted'&&proof.recovery==='investigate'&&stored&&receipt.before._advanced) {
            policy.retireReconciledOutcome(receipt.before._advanced,stored.command.intent,stored.result);
            store.append('live_policy_checkpoints',crypto.randomUUID(),policy.summary());
          }
        }
        if(agency.pending('safety')){publish('RECONCILING','Unresolved safety action');await sleep(700);continue;}
        const urgent=urgentDecision(latest);
        if(urgent) { decision=urgent; emergency=true; }
        else {
          if(agency.pending()){publish('RECONCILING','Unresolved exact command; no replay');await sleep(700);continue;}
          agency.checkProgress(agencyState(latest));
          const selection=agency.plan(agencyState(latest));
          if(!isSelection(selection)){publish('BLOCKED',selection.type==='blocked'?selection.reason:'Reconciliation required');await sleep(700);continue;}
          planned=selection;
          decision=policy.next(latest,planned.task);
        }
      }
      if(agency)lastProgress=agency.summary().progressHealth.lastProductiveAt??lastProgress;
      activeGoal=decision.goal;
      if(decision.blocked){
        if(agency&&planned?.task.kind==='exploration'&&planned.task.route&&!agency.pending()&&!agency.pending('safety')){
          agency.deferSurvey(planned.task.route,agencyState(latest),decision.blocked);
          publish('REPLANNING',decision.blocked);await sleep(700);continue;
        }
        // A disappearing NPC or a short UI transition is a new observation
        // requirement, not a reason to disconnect the whole controller.
        if(['TARGET_NOT_OBSERVED','STALE_OBSERVATION','UNRESOLVED_THREAT'].includes(decision.blocked) && Date.now()-lastProgress<60_000){await sleep(700);continue;}
        if(agency){
          if(!agency.pending()&&!agency.pending('safety')) {
            if(recoverableExecutorBlock(decision.blocked)) {
              agency.deferCurrent(agencyState(latest),decision.blocked);
              publish('REPLANNING',decision.blocked);await sleep(700);continue;
            }
            agency.blocked(decision.blocked);
          }
          publish('BLOCKED',decision.blocked);await sleep(700);continue;
        }
        publish('BLOCKED',decision.blocked);reason=decision.blocked;break;
      }
      if(decision.destination){
        const step=await navigator!.next(latest,decision.destination);
        if(step.route){
          navigation={hint:step.route.hint,endpoint:step.route.endpoint,mapHash:step.route.hash,approachOnly:step.route.approachOnly,
            next:step.intent?.operation==='move'?step.intent.destination:null};
          if(!recordedRoutes.has(step.route)){recordedRoutes.add(step.route);store.append('navigation_plans',crypto.randomUUID(),{at:Date.now(),from:latest.position,goal:decision.goal,...step.route});}
        }
        if(step.blocked){
          if(agency&&!agency.pending()){
            if(planned?.task.kind==='exploration'&&planned.task.route)agency.deferSurvey(planned.task.route,agencyState(latest),step.blocked);
            else agency.deferCurrent(agencyState(latest),step.blocked);
          }
          policy.recordOutcome(latest,latest,decision,'FAILED');publish('REPLANNING',step.blocked);failed++;await sleep(700);continue;
        }
        if(step.arrived){
          if(mode==='pilot'&&!pilotMoved){reason='PILOT_NO_ACTUAL_MOVEMENT';break;}
          policy.recordOutcome(latest,latest,decision,'ARRIVED');await sleep(500);continue;
        }
        if(step.intent)decision={...decision,intent:step.intent};
      }
      if(!decision.intent){
        if(agency&&planned&&decision.wait){
          const before=latest,action=agencyCandidate(before,decision),commandId=crypto.randomUUID();
          agency.begin(planned,action,agencyState(before),commandId);
          await sleep(700);latest=await adapter.snapshot();
          agency.record(commandId,agencyState(latest),observedVerification(agencyState(before),agencyState(latest),action));
          policy.observe(before,latest);
          continue;
        }
        if(!agency&&Date.now()-lastProgress>60_000){reason='NO_VERIFIED_PROGRESS_60_SECONDS';publish('BLOCKED',reason);break;}
        await sleep(700);continue;
      }
      const before=latest,intent=decision.intent;
      const commandId=crypto.randomUUID();
      // One ID links the Director intent, arbiter reservation, dispatch and result.
      if(agency){
        const action=agencyCandidate(before,decision);
        if(emergency) agency.beginSafety(action,agencyState(before),commandId);
        else {
          if(!planned)throw new Error('GOAL_SELECTION_REQUIRED');
          agency.begin(planned,action,agencyState(before),commandId);
        }
      }
      safety.safeEntities.clear();
      if('entity_ref' in intent)safety.safeEntities.add(intent.entity_ref);
      safety.allowedTiles.clear();if(intent.operation==='move')safety.allowedTiles.add(JSON.stringify(intent.destination));
      const command={schema_version:'1.0',action_id:commandId,character:'astra',world:before.world,
        session_id:before.session_id,world_epoch:before.world_epoch,profile_id:before.profile_id,lease,plan_id:decision.goal,
        based_on_snapshot:before.seq,expires_at:Date.now()+config.max_stale_ms,intent};
      let result=await arbiter.submit(command);actions++;
      const until=Math.min(deadline,Date.now()+25_000);
      while(result.status==='RUNNING'&&Date.now()<until&&!revoked){
        await sleep(600);const reconciled=await arbiter.reconcile();
        result=reconciled.find(r=>r.action_id===command.action_id)??result;
        if(result.status==='RUNNING'){
          const urgent=await adapter.snapshot();
          if(arbiter.interruptForFood(urgent)){
            result=store.action(command.action_id)!.result;break;
          }
        }
      }
      latest=await adapter.snapshot();
      if(agency)agency.record(command.action_id,agencyState(latest),arbiterVerification(command.action_id,result));
      policy.recordOutcome(before,latest,decision,result.status);
      store.append('live_policy_checkpoints',crypto.randomUUID(),policy.summary());
      store.append('observations_or_checkpoints',crypto.randomUUID(),latest);
      if(result.status==='SUCCEEDED'){
        verified++;if(!agency)lastProgress=Date.now();
        if(mode==='pilot'&&intent.operation==='move'&&JSON.stringify(before.position)!==JSON.stringify(latest.position))pilotMoved=true;
        if(mode==='pilot'&&decision.goal==='pilot-interaction')pilotInteracted=true;
      }else if(result.status==='RUNNING'){publish('RECONCILING','Awaiting exact outcome or transient settling; no replay');await sleep(700);continue;}
      else{failed++;if(decision.destination)navigator!.fail(decision.destination,result.reason);}
      publish('RUNNING',result.reason+': '+decision.reason);
      if(!agency&&Date.now()-lastProgress>60_000){reason='NO_VERIFIED_PROGRESS_60_SECONDS';break;}
      await sleep(350);
    }
    if(revoked)reason='CONTROL_REVOKED';
  }finally{

    if(start&&latest&&actions>0&&mode!=='reconcile'){
      const learner=new Learner(store);
      learner.record({schema_version:'1.0',episode_id:crypto.randomUUID(),character:'astra',world:start.world,profile_id:start.profile_id,
        objective_id:OBJECTIVE,goal_id:activeGoal,method_id:'live-pilot-session',behaviour_version:'live-v0.2',policy_version:POLICY,
        context:contextKey(start,'supervised-live'),event_start:'session-start',event_end:'session-stop',start,end:latest,
        status:'INTERRUPTED',cause:reason,full_trip:false,
        metrics:{elapsed_ms:Math.max(1,Date.now()-start.observed_at),progress:Math.max(0,latest.skills.reduce((n,s)=>n+s.xp,0)-start.skills.reduce((n,s)=>n+s.xp,0)),new_unlocks:[],income_gp:0,acquisition_gp:0,losses_gp:0,scarcity_units:0,deaths:Math.max(0,(latest.respawns??0)-(start.respawns??0)),failures:failed,stalls_ms:0}});
    }
    if(policyInitialized)store.append('live_policy_checkpoints',crypto.randomUUID(),policy.summary());
    if(store.control().lease===lease)store.setControl('STOPPED');
    // Leave the successful M1 pilot connected for the subsequent supervised run.
    // A manual takeover deliberately keeps the session for its new owner.
    if(!finished&&!revoked&&mode!=='reconcile'&&reason!=='JOURNAL_RECONCILIATION_REQUIRED'){try{await cli.command(['disconnect']);}catch{/* Report final state; never claim logout from an attempted command. */}}
    try{latest=await adapter.snapshot();}catch{}
    if(latest)store.append('observations_or_checkpoints',crypto.randomUUID(),latest);
    if(researchJob)await researchJob;
    publish(reason==='JOURNAL_RECONCILIATION_REQUIRED'?'RECONCILIATION_REQUIRED':reason==='JOURNALS_RECONCILED'?'RECONCILED':finished?'PILOT_PASSED':'STOPPED',reason);

  }
  } finally {
    try {
    if(renewal)clearInterval(renewal);
    navigator?.close();
    if(store) {
      try { if(lease&&store.control().lease===lease)store.setControl('STOPPED'); }
      finally { store.close(); }
    }
    } finally { releaseController(); }
  }
}
if(import.meta.main) await runWithStartupStatus(codeRoot,process.argv.slice(2),main);
