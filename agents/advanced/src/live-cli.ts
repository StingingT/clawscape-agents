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

const root=resolve(import.meta.dir,'..'),data=resolve(root,'data/astra-live');
const argv=process.argv.slice(2),mode=argv[0]??'status';
const option=(name:string,fallback:string)=>{const i=argv.indexOf('--'+name);return i>=0?(argv[i+1]??fallback):fallback;};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const atomic=(file:string,value:unknown)=>{const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2));renameSync(tmp,file);};
const brief=(o:Observation)=>({tick:o.tick,connected:o.connected,position:o.position,hp:o.hp,maxHp:o.max_hp,
  lifeId:o.life_id,respawns:o.respawns,skills:o.skills,inventory:o.inventory.map(i=>({name:i.name,count:i.count})),
  equipment:o.equipment.map(i=>({name:i.name,count:i.count}))});
async function main(){
  mkdirSync(data,{recursive:true});
  if(mode==='status'){
    console.log(existsSync(join(data,'status.json'))?readFileSync(join(data,'status.json'),'utf8'):JSON.stringify({character:'astra',live:false,status:'NOT_STARTED'}));return;
  }
  const store=new Store(join(data,'journal.sqlite'));
  if(['pause','stop','takeover','hard-disable','resume'].includes(mode)){
    try{
      if(mode==='resume')store.releaseManual();
      else store.setControl(({pause:'PAUSED',stop:'STOPPED',takeover:'MANUAL','hard-disable':'DISABLED'} as const)[mode as 'stop']);
      console.log(JSON.stringify({scope:'astra-live-only',control:store.control().mode,
        warning:'Revokes cooperating controller commands. Does not freeze the game; resume requires a new run.'}));
    }finally{store.close();}return;
  }
  const config=Config.parse(JSON.parse(readFileSync(resolve(root,option('config','config.local.json')),'utf8')));
  if(config.mode!=='live'||config.live_control!=='local-single-controller')throw new Error('LIVE_CONFIGURATION_REQUIRED');
  const cli=new CliSession(config,root);
  if(mode==='setup'){
    try{
      const owned=await cli.command(['characters','list']);
      if(!owned.characters?.some((c:any)=>c.name==='astra')){
        if(!argv.includes('--create'))throw new Error('ASTRA_NOT_CREATED');
        const result=await cli.command(['characters','create','astra']);
        if(result.error)throw new Error('CHARACTER_CREATE_REJECTED');
      }
      console.log(JSON.stringify({character:'astra',owned:true,connected:false,gameActions:0}));
    }finally{store.close();}return;
  }
  if(!['pilot','run','observe','reconcile','recover'].includes(mode))throw new Error('UNKNOWN_LIVE_COMMAND');
  const lastKnown=store.records<Observation>('observations_or_checkpoints').filter(o=>o.position!==null).at(-1);
  if(['run','pilot'].includes(mode)&&lastKnown&&liveHazardAt(lastKnown.position)){
    store.close();throw new Error('KNOWN_HAZARD_RECOVERY_REQUIRED');
  }
  const profile=CompatibilityProfile.parse(JSON.parse(readFileSync(join(root,'docs/compatibility-profile.json'),'utf8')));
  const adapter=new LiveAdapter(cli,profile.profile_id,store.records<Observation>('observations_or_checkpoints').at(-1)?.seq??0);
  if(mode==='recover'){
    try{
      recoveryPreflight(lastKnown,profile.profile_id,store.records<{id:string}>('recovery_attempts').some(r=>r.id===RECOVERY_ID));
      // Finish map work BEFORE logging in at a dangerous location.
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
    }finally{store.close();}return;
  }
  if(mode==='observe'){
    try{await adapter.snapshot();await sleep(500);console.log(JSON.stringify(brief(await adapter.snapshot())));}finally{store.close();}return;
  }
  if(mode==='reconcile'){
    try{
      await adapter.snapshot();await sleep(600);
      const a=new ActionArbiter(store,adapter,{maxStaleMs:config.max_stale_ms,maxDeaths:config.max_deaths,keepIds:config.keep_item_ids,
        allowedTiles:new Set(),safeEntities:new Set(),allowLocalEpoch:true});
      console.log(JSON.stringify({character:'astra',results:await a.reconcile(),remaining:store.pending().length}));
    }finally{store.close();}return;
  }
  const lease=store.acquire('astra-live:'+process.pid,Date.now());
  let revoked=false,latest:Observation|undefined,start:Observation|undefined,finished=false,reason='SESSION_LIMIT';
  const renewal=setInterval(()=>{try{store.renew(lease,Date.now());}catch{revoked=true;}},1000);
  const navigator=new LiveNavigator();
  const recordedRoutes=new WeakSet<object>();
  let navigation:unknown=null;
  const saved=store.records<any>('live_policy_checkpoints').at(-1);
  const policy=new LivePolicy(saved);
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
    allowedTiles:new Set(),safeEntities:new Set(),allowLocalEpoch:true,recoveryTiles:new Set()};
  const arbiter=new ActionArbiter(store,adapter,safety);
  let activeGoal='initialise',actions=0,verified=0,failed=0,lastProgress=Date.now();
  const deadline=Date.now()+Math.min(config.max_session_minutes*60,Number(option('seconds',mode==='pilot'?'120':String(config.max_session_minutes*60))))*1000;
  let pilotMoved=false,pilotInteracted=false,pilotDestination:Observation['position']=null;
  const publish=(status:string,why:string)=>{
    const result={character:'astra',time:new Date().toISOString(),mode,status,goal:activeGoal,reason:why,
      actions,verified,failed,elapsedSeconds:start?Math.round((Date.now()-start.observed_at)/1000):0,
      observation:latest?brief(latest):null,policy:policy.summary(),pending:store.pending().map(p=>({operation:p.command.intent.operation,status:p.result.status,reason:p.result.reason})),
      authority:'single cooperating local controller; server fencing unavailable',npcSpendingGp:0,
      navigation,
      research:research?{status:research.status,suggestedMonsters:research.suggestedMonsters,rejected:research.rejected,fetchedAt:research.fetchedAt}:null};
    atomic(join(data,'status.json'),result);console.log(JSON.stringify({time:result.time,status,goal:activeGoal,reason:why,tick:latest?.tick,hp:latest?.hp,position:latest?.position,actions,verified,failed}));
  };
  try{
    const connected=await cli.command(['connect'],25_000);
    if(connected.connected!==true)throw new Error('CONNECT_NOT_CONFIRMED');
    latest=await adapter.snapshot();await sleep(600);latest=await adapter.snapshot();start=latest;
    if(mode==='run')policy.resumeFromObservation(latest);
    store.append('observations_or_checkpoints',crypto.randomUUID(),start);
    queueResearch();
    publish('RUNNING','Connected; waiting for verified effects');
    while(Date.now()<deadline&&!revoked){
      const previous=latest;
      latest=await adapter.snapshot();
      if(previous){
        policy.observe(previous,latest);
        if(JSON.stringify(previous.skills)!==JSON.stringify(latest.skills)||JSON.stringify(previous.inventory)!==JSON.stringify(latest.inventory))lastProgress=Date.now();
      }
      if(research?.rejected.some(r=>r.startsWith('QUEUED_SOURCES:')))queueResearch();
      if(!latest.connected||latest.hp===0){reason='DISCONNECTED_OR_DEAD';break;}
      if(!navigator.isReady() && !latest.activity?.design_open && latest.danger.active===false
        && latest.hp===latest.max_hp){await sleep(700);continue;}
      let decision:LiveDecision;
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
      }else decision=policy.next(latest);
      activeGoal=decision.goal;
      if(decision.blocked){
        // A disappearing NPC or a short UI transition is a new observation
        // requirement, not a reason to disconnect the whole controller.
        if(['TARGET_NOT_OBSERVED','STALE_OBSERVATION','UNRESOLVED_THREAT'].includes(decision.blocked) && Date.now()-lastProgress<60_000){await sleep(700);continue;}
        const blockedReason = decision.blocked;
        const fallback = policy.replanAfterBlock(latest, blockedReason);
        if(!fallback.blocked){
          decision = fallback;
          activeGoal = fallback.goal;
          publish('REPLANNING', (blockedReason ?? 'blocked') + ' -> ' + fallback.goal);
        } else {
          publish('BLOCKED',decision.blocked);reason=decision.blocked;break;
        }
      }
      if(decision.destination){
        const step=await navigator.next(latest,decision.destination);
        if(step.route){
          navigation={hint:step.route.hint,endpoint:step.route.endpoint,mapHash:step.route.hash,approachOnly:step.route.approachOnly,
            next:step.intent?.operation==='move'?step.intent.destination:null};
          if(!recordedRoutes.has(step.route)){recordedRoutes.add(step.route);store.append('navigation_plans',crypto.randomUUID(),{at:Date.now(),from:latest.position,goal:decision.goal,...step.route});}
        }
        if(step.blocked){policy.recordOutcome(latest,latest,decision,'FAILED');publish('REPLANNING',step.blocked);failed++;await sleep(700);continue;}
        if(step.arrived){
          if(mode==='pilot'&&!pilotMoved){reason='PILOT_NO_ACTUAL_MOVEMENT';break;}
          policy.recordOutcome(latest,latest,decision,'ARRIVED');await sleep(500);continue;
        }
        if(step.intent)decision={...decision,intent:step.intent};
      }
      if(!decision.intent){
        if(Date.now()-lastProgress>60_000){reason='NO_VERIFIED_PROGRESS_60_SECONDS';publish('BLOCKED',reason);break;}
        await sleep(700);continue;
      }
      const before=latest,intent=decision.intent;
      safety.safeEntities.clear();
      if('entity_ref' in intent)safety.safeEntities.add(intent.entity_ref);
      safety.allowedTiles.clear();if(intent.operation==='move')safety.allowedTiles.add(JSON.stringify(intent.destination));
      const command={schema_version:'1.0',action_id:crypto.randomUUID(),character:'astra',world:before.world,
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
      policy.recordOutcome(before,latest,decision,result.status);
      store.append('live_policy_checkpoints',crypto.randomUUID(),policy.summary());
      store.append('observations_or_checkpoints',crypto.randomUUID(),latest);
      if(result.status==='SUCCEEDED'){
        verified++;lastProgress=Date.now();
        if(mode==='pilot'&&intent.operation==='move'&&JSON.stringify(before.position)!==JSON.stringify(latest.position))pilotMoved=true;
        if(mode==='pilot'&&decision.goal==='pilot-interaction')pilotInteracted=true;
      }else if(result.status==='RUNNING'){reason='UNRESOLVED_ACTION_STOP_NO_REPLAY';publish('BLOCKED',reason);break;}
      else{failed++;if(decision.destination)navigator.fail(decision.destination,result.reason);}
      publish('RUNNING',result.reason+': '+decision.reason);
      if(Date.now()-lastProgress>60_000){reason='NO_VERIFIED_PROGRESS_60_SECONDS';break;}
      await sleep(350);
    }
    if(revoked)reason='CONTROL_REVOKED';
  }finally{
    navigator.close();clearInterval(renewal);
    if(start&&latest){
      const learner=new Learner(store);
      learner.record({schema_version:'1.0',episode_id:crypto.randomUUID(),character:'astra',world:start.world,profile_id:start.profile_id,
        objective_id:OBJECTIVE,goal_id:activeGoal,method_id:'live-pilot-session',behaviour_version:'live-v0.2',policy_version:POLICY,
        context:contextKey(start,'supervised-live'),event_start:'session-start',event_end:'session-stop',start,end:latest,
        status:'INTERRUPTED',cause:reason,full_trip:false,
        metrics:{elapsed_ms:Math.max(1,Date.now()-start.observed_at),progress:Math.max(0,latest.skills.reduce((n,s)=>n+s.xp,0)-start.skills.reduce((n,s)=>n+s.xp,0)),new_unlocks:[],income_gp:0,acquisition_gp:0,losses_gp:0,scarcity_units:0,deaths:Math.max(0,(latest.respawns??0)-(start.respawns??0)),failures:failed,stalls_ms:0}});
    }
    store.append('live_policy_checkpoints',crypto.randomUUID(),policy.summary());
    if(store.control().lease===lease)store.setControl('STOPPED');
    // Leave the successful M1 pilot connected for the subsequent supervised run.
    // A manual takeover deliberately keeps the session for its new owner.
    if(!finished&&!revoked){try{await cli.command(['disconnect']);}catch{/* Report final state; never claim logout from an attempted command. */}}
    try{latest=await adapter.snapshot();}catch{}
    if(latest)store.append('observations_or_checkpoints',crypto.randomUUID(),latest);
    if(researchJob)await researchJob;
    publish(finished?'PILOT_PASSED':'STOPPED',reason);
    store.close();
  }
}
main().catch(error=>{console.error(JSON.stringify({error:error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'ASTRA_LIVE_COMMAND_FAILED',hint:'Check configuration, control state and local journal. External CLI output is intentionally suppressed.'}));process.exitCode=1;});
