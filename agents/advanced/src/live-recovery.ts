import { Tile, type Intent, type Observation } from './contracts.ts';
import { liveHazardAt } from './live-hazards.ts';

// A narrowly reviewed egress, not permission to enter or explore a danger zone.
export const RECOVERY_ID = 'draynor-jail-south-v1';
export const RECOVERY_ORIGIN: Tile = Object.freeze({x:3110,z:3228,plane:0});
export const RECOVERY_EXIT: Tile = Object.freeze({x:3110,z:3216,plane:0});
export const RECOVERY_MAP_HASH = '2e957bc8032690cae7b6a2b549517bb689c48f5bcf366b9a7d13ca73156225cb';
export const sameTile = (a: Tile|null, b: Tile|null) => !!a && !!b && a.x===b.x && a.z===b.z && a.plane===b.plane;
export const recoveryCorridor = (p:Tile) => p.plane===0 && p.x>=3107 && p.x<=3113 && p.z>=3216 && p.z<=3228;
export type RecoveryRoute = {id:typeof RECOVERY_ID; hash:string; points:Tile[]; legs:Tile[]};
const approvedFoodCount=(o:Observation)=>o.inventory.filter(i=>i.count>0&&/^(Shrimps|Bread)$/i.test(i.name)&&i.options.some(p=>/^eat$/i.test(p.text))).reduce((n,i)=>n+i.count,0);
export function planRecovery(canStep:(a:Tile,b:Tile)=>boolean, covered:(p:Tile)=>boolean): RecoveryRoute['points'] {
  const key=(p:Tile)=>`${p.x},${p.z}`, queue=[{...RECOVERY_ORIGIN}];
  const parents=new Map<string,Tile|null>([[key(RECOVERY_ORIGIN),null]]);
  if(!covered(RECOVERY_ORIGIN))throw new Error('RECOVERY_MAP_COVERAGE_UNKNOWN');
  for(let n=0;n<queue.length;n++){
    const a=queue[n]!;
    if(sameTile(a,RECOVERY_EXIT)){
      const points:Tile[]=[];let p:Tile|null=a;
      while(p){points.unshift(p);p=parents.get(key(p))??null;}
      if(points.length>25)throw new Error('RECOVERY_ROUTE_TOO_LONG');
      return points;
    }
    // Never move farther north/deeper into the recorded guard area.
    for(const [dx,dz] of [[0,-1],[-1,0],[1,0]] as const){
      const b={x:a.x+dx,z:a.z+dz,plane:0};
      if(!recoveryCorridor(b)||parents.has(key(b))||!covered(b)||!canStep(a,b))continue;
      parents.set(key(b),a);queue.push(b);
    }
  }
  throw new Error('RECOVERY_NO_COLLISION_ROUTE');
}
export function recoveryLegs(points:Tile[]):Tile[]{
  const legs:Tile[]=[];let count=0;
  for(let n=1;n<points.length;n++){
    const a=points[n-1]!,b=points[n]!,c=points[n+1];count++;
    if(count===4||!c||b.x-a.x!==c.x-b.x||b.z-a.z!==c.z-b.z){legs.push(b);count=0;}
  }
  return legs;
}
export function validateRecoveryRoute(route:RecoveryRoute):void{
  if(route.id!==RECOVERY_ID||route.hash!==RECOVERY_MAP_HASH)throw new Error('RECOVERY_MAP_CHANGED');
  if(route.points.length<2||route.points.length>25||!sameTile(route.points[0]!,RECOVERY_ORIGIN)
    ||!sameTile(route.points.at(-1)!,RECOVERY_EXIT))throw new Error('RECOVERY_ROUTE_INVALID');
  if(new Set(route.points.map(p=>`${p.x},${p.z},${p.plane}`)).size!==route.points.length)throw new Error('RECOVERY_ROUTE_LOOP');
  for(let n=0;n<route.points.length;n++){
    const b=Tile.parse(route.points[n]),a=route.points[n-1];
    if(!recoveryCorridor(b)||(liveHazardAt(b)?.name??'Draynor jail guards')!=='Draynor jail guards'
      ||a&&(b.z>a.z||Math.abs(b.x-a.x)+Math.abs(b.z-a.z)!==1))throw new Error('RECOVERY_ROUTE_INVALID');
  }
  if(JSON.stringify(route.legs)!==JSON.stringify(recoveryLegs(route.points)))throw new Error('RECOVERY_LEGS_INVALID');
}
export function recoveryPreflight(last:Observation|undefined,profile:string,used:boolean):void{
  if(used)throw new Error('RECOVERY_ATTEMPT_ALREADY_USED');
  if(!last||last.character!=='astra'||last.profile_id!==profile||last.connected
    ||!sameTile(last.position,RECOVERY_ORIGIN))throw new Error('RECOVERY_ORIGIN_NOT_APPROVED');
  if(last.hp===null||last.hp<8||last.max_hp!==10||last.respawns!==0)throw new Error('RECOVERY_HEALTH_NOT_APPROVED');
  if(approvedFoodCount(last)<2)throw new Error('RECOVERY_FOOD_REQUIRED');
}
export class RecoveryPolicy {
  private cursor=0;
  constructor(readonly route:RecoveryRoute,readonly start:Observation){
    validateRecoveryRoute(route);
    if(!sameTile(start.position,RECOVERY_ORIGIN)||start.hp===null||start.hp<8||start.max_hp!==10
      ||start.respawns!==0||start.life_id===null)throw new Error('RECOVERY_LIVE_START_CHANGED');
    if(approvedFoodCount(start)<2)throw new Error('RECOVERY_LIVE_FOOD_CHANGED');
  }
  common(o:Observation):string|null{
    if(o.character!==this.start.character||o.world!==this.start.world||o.profile_id!==this.start.profile_id
      ||o.session_id!==this.start.session_id||o.life_id!==this.start.life_id||o.respawns!==this.start.respawns)
      return 'RECOVERY_IDENTITY_CHANGED';
    if(!o.connected||o.hp===null||o.hp<=0||o.max_hp!==this.start.max_hp||!o.activity)return 'RECOVERY_STATE_UNAVAILABLE';
    if(o.activity.target_type==='player')return 'RECOVERY_PLAYER_THREAT';
    if(!o.position||!this.route.points.some(p=>sameTile(p,o.position)))return 'RECOVERY_OFF_ROUTE';
    return null;
  }
  next(o:Observation):{intent?:Intent;arrived?:boolean;blocked?:string}{
    const blocked=this.common(o);if(blocked)return {blocked};
    // Food and move effects must reconcile before another decision is requested.
    const food=o.inventory.find(i=>i.count>0&&/^(Shrimps|Bread)$/i.test(i.name)&&i.options.some(p=>/^eat$/i.test(p.text)));
    if(o.hp!<=o.max_hp!*0.8&&food){
      if(o.bank.open||o.shop_open||o.dialog.open||o.activity!.modal_open)return {intent:{operation:'close_interface'}};
      return {intent:{operation:'eat',slot:food.slot,item_id:food.id}};
    }
    if(o.hp!<=4)return {blocked:'RECOVERY_HEALTH_RESERVE_EXHAUSTED'};
    if(o.bank.open||o.shop_open||o.dialog.open||o.activity!.modal_open)return {intent:{operation:'close_interface'}};
    while(this.route.legs[this.cursor]&&sameTile(o.position,this.route.legs[this.cursor]!))this.cursor++;
    if(this.cursor===this.route.legs.length)return sameTile(o.position,RECOVERY_EXIT)?{arrived:true}:{blocked:'RECOVERY_OFF_ROUTE'};
    const previous=this.cursor===0?RECOVERY_ORIGIN:this.route.legs[this.cursor-1]!;
    if(!sameTile(o.position,previous))return {blocked:'RECOVERY_UNRECONCILED_MOVEMENT'};
    return {intent:{operation:'move',destination:this.route.legs[this.cursor]!}};
  }
  // Called by the arbiter on BOTH fresh pre-dispatch snapshots, not only by next().
  validate(intent:Intent,o:Observation):string|null{
    const invalid=this.common(o);if(invalid)return invalid;
    if(intent.operation==='eat')return /^(Shrimps|Bread)$/i.test(o.inventory.find(i=>i.slot===intent.slot&&i.id===intent.item_id)?.name??'')?null:'RECOVERY_FOOD_NOT_APPROVED';
    if(intent.operation==='close_interface')return o.bank.open||o.shop_open||o.dialog.open||o.activity?.modal_open?null:'RECOVERY_INTERFACE_NOT_OPEN';
    if(intent.operation!=='move')return 'RECOVERY_OPERATION_NOT_ALLOWED';
    const from=this.cursor===0?RECOVERY_ORIGIN:this.route.legs[this.cursor-1]!;
    if(o.hp!<=4)return 'RECOVERY_HEALTH_RESERVE_EXHAUSTED';
    if(o.hp!<=o.max_hp!*0.8&&o.inventory.some(i=>i.count>0&&/^(Shrimps|Bread)$/i.test(i.name)&&i.options.some(p=>/^eat$/i.test(p.text))))return 'RECOVERY_HEAL_BEFORE_MOVE';
    if(!sameTile(o.position,from)||!sameTile(intent.destination,this.route.legs[this.cursor]??null))return 'RECOVERY_UNREVIEWED_LEG';
    if(o.bank.open||o.shop_open||o.dialog.open||o.activity?.modal_open)return 'RECOVERY_INTERFACE_NOT_CLOSED';
    return null;
  }
}
