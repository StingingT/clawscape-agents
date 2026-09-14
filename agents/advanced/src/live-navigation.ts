import { COLLISION_STARTUP_TIMEOUT_MS, COLLISION_STARTUP_STAGES, COLLISION_FAILURE_CODES, type CollisionStage, type CollisionFailure, type CollisionDiagnostic } from './collision-startup.ts';
import type { Intent, Observation, Tile } from './contracts.ts';
export type Leg={to:Tile;doors:Tile[]};
export type Route={legs:Leg[];endpoint:Tile;hint:Tile;hash:string;approachOnly:boolean};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const distance=(a:Tile,b:Tile)=>a.plane===b.plane?Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z)):Infinity;
export type StartupClock={now:()=>number;schedule:(callback:()=>void,delayMs:number)=>()=>void};
const startupClock:StartupClock={now:()=>Date.now(),schedule:(callback,delayMs)=>{const timer=setTimeout(callback,delayMs);return ()=>clearTimeout(timer);}};
export class LiveNavigator {
  private worker:Worker;
  private callbacks=new Map<string,{resolve:(r:Route)=>void;reject:(e:Error)=>void}>();
  private route?:Route;
  private cursor=0;
  private life:number|null=null;
  private routeHint?:Tile;
  private failures=new Map<string,{until:number;count:number}>();
  private ready=false;
  private startupError:string|undefined;
  private readiness=new Set<{resolve:()=>void;reject:(e:Error)=>void}>();
  private readonly startupBegan:number;
  private readonly clock:StartupClock;
  private readonly onStartup:(event:CollisionDiagnostic)=>void;
  private stage:CollisionStage='starting';
  private closed=false;
  // Bun workers otherwise inherit the process's original environment, not runtime updates.
  constructor(factory=()=>new Worker(new URL('./live-map-worker.ts',import.meta.url).href,
    {env:{...process.env}} as WorkerOptions & {env:NodeJS.ProcessEnv}),
    onStartup:(event:CollisionDiagnostic)=>void=event=>console.error(JSON.stringify(event)),clock:StartupClock=startupClock){
    this.clock=clock;this.startupBegan=clock.now();this.onStartup=onStartup;
    this.worker=factory();
    this.emitStartup('starting');
    this.worker.onmessage=({data})=>{
      if(this.closed||this.startupError)return;
      if(data?.kind==='collision-startup') {
        if(!COLLISION_STARTUP_STAGES.includes(data.stage))return;
        if(data.status==='failed') {
          this.stage=data.stage;
          this.failStartup(COLLISION_FAILURE_CODES.includes(data.errorCode)?data.errorCode:'COLLISION_WORKER_FAILED');
        } else if(data.status==='starting' && data.stage!==this.stage) {
          this.stage=data.stage;this.emitStartup('starting');
        }
        return;
      }
      if(data?.ready===true){this.ready=true;this.stage='ready';this.emitStartup('ready');for(const r of this.readiness)r.resolve();this.readiness.clear();return;}
      const callback=this.callbacks.get(data?.id);if(!callback)return;
      this.callbacks.delete(data.id);data.error?callback.reject(new Error(data.error)):callback.resolve(data);
    };
    this.worker.onerror=(event)=>{
      event.preventDefault?.(); // Do not echo arbitrary worker errors containing private paths/values.
      this.failStartup('COLLISION_WORKER_FAILED');
    };
    this.worker.onmessageerror=()=>this.failStartup('COLLISION_WORKER_FAILED');
    this.worker.addEventListener?.('close',()=>{if(!this.closed)this.failStartup('COLLISION_WORKER_FAILED');});
  }
  startupStatus():CollisionDiagnostic {
    return {component:'astra-collision-worker',status:this.startupError?'failed':this.ready?'ready':'starting',
      stage:this.stage,elapsedMs:Math.max(0,this.clock.now()-this.startupBegan),
      ...(this.startupError?{errorCode:this.startupError as CollisionFailure}:{})};
  }
  private emitStartup(status:CollisionDiagnostic['status']) {
    try {this.onStartup({...this.startupStatus(),status});} catch { /* Diagnostics cannot grant or break control. */ }
  }
  private failStartup(reason:CollisionFailure) {
    if(this.closed||this.startupError)return;
    this.ready=false;this.startupError=reason;this.emitStartup('failed');
    for(const r of this.readiness)r.reject(new Error(reason));this.readiness.clear();
    for(const r of this.callbacks.values())r.reject(new Error(reason));this.callbacks.clear();
    this.worker.terminate();
  }
  async waitUntilReady(timeoutMs=COLLISION_STARTUP_TIMEOUT_MS):Promise<void> {
    if(this.closed)throw new Error('NAVIGATOR_CLOSED');
    if(this.startupError)throw new Error(this.startupError);
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>COLLISION_STARTUP_TIMEOUT_MS)throw new Error('COLLISION_STARTUP_TIMEOUT_INVALID');
    if(this.ready)return;
    await new Promise<void>((resolve,reject)=>{
      let cancel=()=>{};
      const waiter={resolve:()=>{cancel();resolve();},reject:(e:Error)=>{cancel();reject(e);}};
      // Measured from worker creation. Stage messages and repeated wait calls do NOT renew the deadline.
      const remaining=Math.max(0,timeoutMs-(this.clock.now()-this.startupBegan));
      this.readiness.add(waiter);
      cancel=this.clock.schedule(()=>this.failStartup('COLLISION_WORKER_TIMEOUT'),remaining);
    });
  }
  close(){
    if(this.closed)return;
    this.closed=true;this.ready=false;
    for(const r of this.readiness)r.reject(new Error('NAVIGATOR_CLOSED'));this.readiness.clear();
    for(const r of this.callbacks.values())r.reject(new Error('NAVIGATOR_CLOSED'));this.callbacks.clear();
    this.worker.terminate();
  }
  isReady(){return this.ready;}
  fail(destination:Tile,reason:string){
    const key=JSON.stringify(destination),old=this.failures.get(key);
    this.failures.set(key,{until:Date.now()+60_000*Math.min(5,(old?.count??0)+1),count:(old?.count??0)+1});
    this.route=undefined;return {blocked:reason};
  }
  async next(o:Observation,hint:Tile):Promise<{intent?:Intent;arrived?:boolean;wait?:boolean;blocked?:string;route?:Route}> {
    if(this.startupError)return {blocked:this.startupError};
    if(!o.position)return {blocked:'POSITION_UNKNOWN'};
    if(!this.ready)return {wait:true};
    if((this.failures.get(JSON.stringify(hint))?.until??0)>Date.now())return {blocked:'ROUTE_COOLDOWN'};
    if(o.position.plane!==hint.plane)return {blocked:'TRANSITION_REQUIRED'};
    if(!this.route||!same(hint,this.routeHint)||o.life_id!==this.life){
      this.route=undefined;this.routeHint=hint;this.life=o.life_id;this.cursor=0;
      try{
        this.route=await new Promise<Route>((resolve,reject)=>{
          const id=crypto.randomUUID();
          const timer=setTimeout(()=>{this.callbacks.delete(id);reject(new Error('MAP_TIMEOUT'));},3000);
          this.callbacks.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
          this.worker.postMessage({id,from:o.position,to:hint});
        });
      }catch(error){return this.fail(hint,error instanceof Error?error.message:'NO_ROUTE');}
    }
    while(this.route.legs[this.cursor]&&same(o.position,this.route.legs[this.cursor]!.to))this.cursor++;
    if(this.cursor>=this.route.legs.length){
      if(!same(o.position,this.route.endpoint))return this.fail(hint,'OFF_ROUTE');
      return {arrived:true,route:this.route};
    }
    const leg=this.route.legs[this.cursor]!;
    if(distance(o.position,leg.to)>8)return this.fail(hint,'OFF_ROUTE');
    for(const door of leg.doors){
      const e=o.entities.find(e=>e.kind==='object'&&same(e.position,door)&&e.options.some(p=>/^open$/i.test(p.text)));
      if(e){
        if(e.reachable!==true)return this.fail(hint,'DOOR_NOT_REACHABLE');
        return {intent:{operation:'interact',entity_ref:e.ref,option_index:e.options.find(p=>/^open$/i.test(p.text))!.index},route:this.route};
      }
    }
    return {intent:{operation:'move',destination:leg.to},route:this.route};
  }
}
