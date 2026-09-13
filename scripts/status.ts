// Read-only, secret-free status for the three existing agents.
import { resolve } from 'node:path';
import { callSkill } from '../src/skill-cli';
const root=resolve(import.meta.dir,'..');
for (const character of process.argv.slice(2).length ? process.argv.slice(2) : ['coincrafter','stinger','clawscout']) {
  let raw='';let err='';
  try {raw=JSON.stringify(await callSkill(character,['state'],resolve(root,'data/online-home')));} catch(error) {err=error instanceof Error?error.message:'State unavailable';}
  try {const s=JSON.parse(raw).state; console.log(JSON.stringify({character,tick:s.tick,player:s.player,skills:s.skills.filter((x:any)=>['Attack','Strength','Ranged','Fletching','Woodcutting','Mining'].includes(x.name)),inventory:s.inventory.map((i:any)=>({name:i.name,count:i.count,slot:i.slot})),equipment:s.equipment,dialog:s.dialog,bank:s.bank?.isOpen,shop:s.shop?.isOpen,messages:s.gameMessages?.slice(-4),npcs:s.nearbyNpcs?.filter((n:any)=>n.distance<8).map((n:any)=>({name:n.name,index:n.index,reachable:n.reachable,distance:n.distance,inCombat:n.inCombat})),locs:s.nearbyLocs?.filter((n:any)=>n.distance<5).map((n:any)=>({id:n.id,name:n.name,x:n.x,z:n.z,reachable:n.reachable,options:n.optionsWithIndex})),ground:s.groundItems?.filter((n:any)=>n.distance<8)}));}catch{console.log(JSON.stringify({character,error:err||'State unavailable'}));}
}
