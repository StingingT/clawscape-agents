import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Tile } from './contracts.ts';
import { LIVE_HAZARDS,liveHazardAt } from './live-hazards.ts';
const upstream=resolve(process.env.CLAWSCAPE_UPSTREAM??resolve(import.meta.dir,'../../tmp/clawscape/upstream'));
const map=await import(pathToFileURL(resolve(upstream,'sdk/pathfinding.ts')).href);
const rs=await import(pathToFileURL(resolve(upstream,'server/vendor/rsmod-pathfinder/rsmod-pathfinder.js')).href);
map.initPathfinding();
const hash=createHash('sha256').update(readFileSync(resolve(upstream,'sdk/collision-data.json'))).digest('hex');
// Publicly known wizard circles: the pilot will not route through either area.
for(const {x0,x1,z0,z1} of LIVE_HAZARDS)
  for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++)rs.changeLoc(x,z,0,1,1,false,false,true);
const distance=(a:Tile,b:Tile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
const expand=(from:Tile,turns:Tile[])=>{
  const points:Tile[]=[from];let a=from;
  for(const b of turns){const n=distance(a,b);for(let j=1;j<=n;j++)points.push({x:Math.round(a.x+(b.x-a.x)*j/n),z:Math.round(a.z+(b.z-a.z)*j/n),plane:a.plane});a=b;}
  return points;
};
self.onmessage=({data})=>{
  try{
    const from=Tile.parse(data.from),hint=Tile.parse(data.to);
    if(liveHazardAt(from))throw new Error('KNOWN_HAZARD_RECOVERY_REQUIRED');
    if(liveHazardAt(hint))throw new Error('HAZARDOUS_DESTINATION');
    if(from.plane!==hint.plane)throw new Error('TRANSITION_REQUIRED');
    const turns=map.findLongPath(from.plane,from.x,from.z,hint.x,hint.z,500)
      .map((p:any)=>({x:p.x,z:p.z,plane:p.level}));
    const endpoint:Tile=turns.at(-1)??from;
    // An area hint may resolve to a reachable approach within TWO tiles. This
    // is never proof that a bank/tree/service was reached or used.
    if(distance(endpoint,hint)>2 || !turns.length&&distance(from,hint)>2)throw new Error('PARTIAL_PATH');
    const points=expand(from,turns),doors=map.findDoorsAlongPath(points.map(p=>({...p,level:p.plane})));
    if(points.some(liveHazardAt))throw new Error('HAZARDOUS_ROUTE');
    const crossing=new Map<number,any[]>();
    for(const d of doors){
      const legal=points.slice(1).map((p,i)=>rs.canTravel(p.plane,points[i]!.x,points[i]!.z,p.x-points[i]!.x,p.z-points[i]!.z,1,0,rs.CollisionType.NORMAL));
      rs.changeWall(d.x,d.z,d.level,d.angle,d.shape,d.blockrange,false,true);
      try{points.slice(1).forEach((p,i)=>{
        if(legal[i]&&!rs.canTravel(p.plane,points[i]!.x,points[i]!.z,p.x-points[i]!.x,p.z-points[i]!.z,1,0,rs.CollisionType.NORMAL))
          crossing.set(i+1,[...(crossing.get(i+1)??[]),{x:d.x,z:d.z,plane:d.level}]);
      });}finally{rs.changeWall(d.x,d.z,d.level,d.angle,d.shape,d.blockrange,false,false);}
    }
    const legs:Array<{to:Tile;doors:Tile[]}>=[];let count=0;
    for(let j=1;j<points.length;j++){
      const before=points[j-1]!,p=points[j]!,next=points[j+1];
      if(crossing.has(j)){
        if(count>0)legs.push({to:before,doors:[]});
        legs.push({to:p,doors:crossing.get(j)!});count=0;continue;
      }
      count++;
      if(count>=8||!next||crossing.has(j+1)||p.x-before.x!==next.x-p.x||p.z-before.z!==next.z-p.z){legs.push({to:p,doors:[]});count=0;}
    }
    // Pilot area fence. This is a route permission, not a declaration of safety.
    if(points.some(p=>p.plane!==0 || p.x<3070 || p.x>3270 || p.z<3080 || p.z>3445))throw new Error('OUTSIDE_PILOT_AREA');
    self.postMessage({id:data.id,legs,endpoint,hint,hash,approachOnly:distance(endpoint,hint)>0});
  }catch(error){self.postMessage({id:data.id,error:error instanceof Error?error.message:'ROUTE_ERROR'});}
};
self.postMessage({ready:true,hash});
