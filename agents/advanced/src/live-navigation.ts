import type { Intent, Observation, Tile } from './contracts.ts';
export type Leg={to:Tile;doors:Tile[]};
export type Route={legs:Leg[];endpoint:Tile;hint:Tile;hash:string;approachOnly:boolean};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const distance=(a:Tile,b:Tile)=>a.plane===b.plane?Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z)):Infinity;
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
  constructor(factory=()=>new Worker(new URL('./live-map-worker.ts',import.meta.url).href)){
    this.worker=factory();
    this.worker.onmessage=({data})=>{
      if(data.ready){this.ready=true;for(const r of this.readiness)r.resolve();this.readiness.clear();return;}
      const callback=this.callbacks.get(data.id);if(!callback)return;
      this.callbacks.delete(data.id);data.error?callback.reject(new Error(data.error)):callback.resolve(data);
    };
    this.worker.onerror=()=>{
      this.ready=false;this.startupError='COLLISION_WORKER_FAILED';
      for(const r of this.readiness)r.reject(new Error(this.startupError));this.readiness.clear();
      for(const r of this.callbacks.values())r.reject(new Error(this.startupError));this.callbacks.clear();
    };
  }
  async waitUntilReady(timeoutMs=15_000):Promise<void> {
    if(this.startupError)throw new Error(this.startupError);
    if(this.ready)return;
    await new Promise<void>((resolve,reject)=>{
      const waiter={resolve:()=>{clearTimeout(timer);resolve();},reject:(e:Error)=>{clearTimeout(timer);reject(e);}};
      const timer=setTimeout(()=>{this.readiness.delete(waiter);reject(new Error('COLLISION_WORKER_TIMEOUT'));},timeoutMs);
      this.readiness.add(waiter);
    });
  }
  close(){
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
