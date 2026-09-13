import {ActionArbiter,type Adapter,type SafetyPolicy} from './arbiter.ts';
import type {Observation} from './contracts.ts';
import type {LiveConfig} from './live-adapter.ts';
import type {Store} from './store.ts';
import {RECOVERY_ID,RECOVERY_EXIT,RecoveryPolicy,recoveryPreflight,validateRecoveryRoute,sameTile,type RecoveryRoute} from './live-recovery.ts';

export async function prepareRecovery():Promise<RecoveryRoute>{
  const worker=new Worker(new URL('./recovery-map-worker.ts',import.meta.url).href);
  try{return await new Promise<RecoveryRoute>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('RECOVERY_MAP_TIMEOUT')),30_000);
    worker.onerror=()=>{clearTimeout(timer);reject(new Error('RECOVERY_MAP_FAILED'));};
    worker.onmessage=({data})=>{clearTimeout(timer);try{
      if(data.error)throw new Error(data.error);validateRecoveryRoute(data);resolve(data);
    }catch(error){reject(error);}};
  });}finally{worker.terminate();}
}
type Clock={now:()=>number;delay:(ms:number)=>Promise<void>};
type Report={status:string;reason:string;actions:number;verified:number;observation:Observation|null;logoutVerified:boolean};
export async function runRecovery(options:{
  store:Store;adapter:Adapter;config:LiveConfig;profile:string;last:Observation|undefined;route:RecoveryRoute;
  connect:()=>Promise<{connected?:boolean}>;disconnect:()=>Promise<{connected?:boolean}>;
  publish:(report:Report)=>void;clock?:Clock;
}):Promise<Report>{
  const {store,adapter,config,last,route,profile}=options;
  const clock=options.clock??{now:Date.now,delay:(ms:number)=>new Promise(r=>setTimeout(r,ms))};
  recoveryPreflight(last,profile,store.records<{id:string}>('recovery_attempts').some(r=>r.id===RECOVERY_ID));
  validateRecoveryRoute(route);
  if(last!.world!==config.world)throw new Error('RECOVERY_WORLD_CHANGED');
  // acquire refuses pending effects, manual takeover, disabled or another owner.
  const lease=store.acquire('astra-recovery:'+process.pid,clock.now());
  let revoked=false,connectedAttempted=false,latest:Observation|null=null,policy:RecoveryPolicy|undefined;
  let actions=0,verified=0,reason='RECOVERY_SESSION_LIMIT',status='STOPPED',logoutVerified=false;
  const renewal=setInterval(()=>{try{store.renew(lease,clock.now());}catch{revoked=true;}},1000);
  const publish=()=>options.publish({status,reason,actions,verified,observation:latest,logoutVerified});
  const safety:SafetyPolicy={maxStaleMs:config.max_stale_ms,maxDeaths:1,keepIds:config.keep_item_ids,
    allowedTiles:new Set(),safeEntities:new Set(),recoveryTiles:new Set(),allowLocalEpoch:true,
    additionalCheck:(i,o)=>policy?policy.validate(i,o):'RECOVERY_NOT_INITIALISED'};
  const arbiter=new ActionArbiter(store,adapter,safety,clock.now);
  const record=()=>{if(latest)store.append('observations_or_checkpoints',crypto.randomUUID(),latest);};
  const owns=()=>{const c=store.control();return !revoked&&!c.disabled&&c.mode==='RUNNING'&&c.lease===lease&&c.expires>clock.now();};
  try{
    // Persist BEFORE login; crashes and repeated invocations cannot auto-retry.
    store.append('recovery_attempts',RECOVERY_ID,{id:RECOVERY_ID,at:clock.now(),origin:last!.position,profile,route,automaticRetries:0});
    if(!owns())throw new Error('CONTROL_REVOKED');
    connectedAttempted=true;
    if((await options.connect()).connected!==true)throw new Error('RECOVERY_CONNECT_NOT_CONFIRMED');
    const deadline=clock.now()+60_000;
    latest=await adapter.snapshot();await clock.delay(450);latest=await adapter.snapshot();record();
    policy=new RecoveryPolicy(route,latest);
    status='RECOVERING';reason='COLLISION_CHECKED_EGRESS';publish();
    let quietSince:number|null=null,quietTick:number|null=null,quietHp:number|null=null;
    while(clock.now()<deadline&&owns()){
      store.renew(lease,clock.now());
      latest=await adapter.snapshot();
      const decision=policy.next(latest);
      if(decision.blocked){reason=decision.blocked;break;}
      if(latest.fresh_at===null||clock.now()-latest.fresh_at>config.max_stale_ms){reason='RECOVERY_STALE_STATE';break;}
      if(decision.arrived){
        if(latest.danger.active!==false||latest.hp!==quietHp){quietSince=null;quietTick=null;}
        quietHp=latest.hp;
        if(latest.danger.active===false&&quietSince===null){quietSince=clock.now();quietTick=latest.tick;}
        if(quietSince!==null&&quietTick!==null&&latest.tick!==null&&clock.now()-quietSince>=3000&&latest.tick-quietTick>=8){
          status='RECOVERED';reason='EXIT_AND_QUIET_WINDOW_VERIFIED';record();break;
        }
        await clock.delay(250);continue;
      }
      quietSince=null;quietTick=null;
      if(!decision.intent){reason='RECOVERY_NO_ACTION';break;}
      if(actions>=12){reason='RECOVERY_ACTION_BUDGET';break;}
      const before=latest,intent=decision.intent;
      safety.allowedTiles.clear();safety.recoveryTiles!.clear();
      if(intent.operation==='move'){
        safety.allowedTiles.add(JSON.stringify(intent.destination));safety.recoveryTiles!.add(JSON.stringify(intent.destination));
      }
      const command={schema_version:'1.0',action_id:crypto.randomUUID(),character:'astra',world:before.world,
        session_id:before.session_id,world_epoch:before.world_epoch,profile_id:before.profile_id,lease,plan_id:RECOVERY_ID,
        based_on_snapshot:before.seq,expires_at:clock.now()+config.max_stale_ms,intent};
      let result=await arbiter.submit(command);actions++;
      const actionDeadline=Math.min(deadline,clock.now()+5000);
      while(result.status==='RUNNING'&&clock.now()<actionDeadline&&owns()){
        store.renew(lease,clock.now());await clock.delay(200);
        result=(await arbiter.reconcile()).find(r=>r.action_id===command.action_id)??result;
        latest=await adapter.snapshot();
        const invalid=policy.common(latest);
        if(invalid){reason=invalid;break;}
      }
      latest=await adapter.snapshot();record();
      if(result.status!=='SUCCEEDED'){
        reason=result.status==='RUNNING'?'RECOVERY_UNCERTAIN_ACTION_NO_REPLAY':result.reason;break;
      }
      verified++;reason='VERIFIED_'+intent.operation.toUpperCase();publish();
    }
    if(!owns()){status='STOPPED';reason='CONTROL_REVOKED';}
    else if(clock.now()>=deadline&&status!=='RECOVERED')reason='RECOVERY_SESSION_LIMIT';
    if(status!=='RECOVERED')status='STOPPED';
  }catch(error){status='STOPPED';reason=error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'RECOVERY_FAILED';}
  finally{
    clearInterval(renewal);safety.recoveryTiles!.clear();
    const control=store.control();
    // Manual takeover/another owner retains the session. Soft stop/pause still
    // gets best-effort logout, as requested by those controls.
    const otherOwner=control.mode==='MANUAL'||control.lease!==null&&control.lease!==lease;
    if(control.lease===lease)store.setControl('STOPPED');
    if(connectedAttempted&&!otherOwner){try{logoutVerified=(await options.disconnect()).connected===false;}catch{/* Never infer logout from an attempt. */}}
    try{latest=await adapter.snapshot();logoutVerified=latest.connected===false;record();}catch{/* Last position is still evidence, not a fresh login state. */}
    const report={status,reason,actions,verified,observation:latest,logoutVerified};
    store.append('recovery_results',crypto.randomUUID(),{id:RECOVERY_ID,at:clock.now(),...report,
      endpointVerified:status==='RECOVERED'&&sameTile(latest?.position??null,RECOVERY_EXIT),pending:store.pending().length});
    publish();
  }
  return {status,reason,actions,verified,observation:latest,logoutVerified};
}
