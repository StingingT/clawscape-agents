import { upstreamRoot } from '../../../src/runtime-paths.ts';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {RECOVERY_ID,RECOVERY_MAP_HASH,planRecovery,recoveryLegs} from './live-recovery.ts';
// Independent offline collision memory. No connection, game writes, door unmasking,
// or removal of the normal navigator's hazard exclusions.
try{
  const upstream=upstreamRoot();
  const raw=readFileSync(resolve(upstream,'sdk/collision-data.json'));
  const hash=createHash('sha256').update(raw).digest('hex');
  if(hash!==RECOVERY_MAP_HASH)throw new Error('RECOVERY_MAP_CHANGED');
  const data=JSON.parse(raw.toString());
  const rs=await import(pathToFileURL(resolve(upstream,'server/vendor/rsmod-pathfinder/rsmod-pathfinder.js')).href);
  const zones=new Set<string>();
  for(const [level,x,z] of data.zones)if(level===0&&x>=3104&&x<=3112&&z>=3208&&z<=3232){
    zones.add(`${x},${z}`);rs.allocateIfAbsent(x,z,level);
  }
  for(const [level,x,z,flags] of data.tiles)if(level===0&&zones.has(`${x&~7},${z&~7}`))rs.__set(x,z,level,flags);
  // Treat every door as CLOSED. The recovery cannot open doors or cross a
  // conditional passage. A route requiring one fails before the live login.
  for(const [level,x,z,shape,angle,blockrange] of data.doors??[])if(level===0&&x>=3104&&x<=3116&&z>=3212&&z<=3232)
    rs.changeWall(x,z,level,angle,shape,!!blockrange,false,true);
  const points=planRecovery((a,b)=>rs.canTravel(0,a.x,a.z,b.x-a.x,b.z-a.z,1,0,rs.CollisionType.NORMAL),p=>zones.has(`${p.x&~7},${p.z&~7}`));
  self.postMessage({id:RECOVERY_ID,hash,points,legs:recoveryLegs(points)});
}catch(error){self.postMessage({error:error instanceof Error?error.message:'RECOVERY_MAP_ERROR'});}
