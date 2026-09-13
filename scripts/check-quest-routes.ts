// Source and collision verification only. No credentials, login or game actions.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QUEST_BUTTON, QUEST_JOURNAL, TRANSITIONS, QUEST_NPCS, SOUTH_ROAD, EAST_ROAD } from '../src/quests/rune-mysteries';
import { samples } from '../src/navigation/geometry';
import { inQuestDanger } from '../src/navigation/quest-hazards';
import { mapEntries } from '../src/training/catalog';
const upstream=resolve(import.meta.dir,'../../tmp/clawscape/upstream');
const read=(p:string)=>readFileSync(resolve(upstream,p),'utf8');
assert(read('server/content/pack/interface.pack').includes(`${QUEST_BUTTON}=questlist:runemysteries\n`));
assert(read('server/content/pack/interface.pack').includes(`${QUEST_JOURNAL}=questjournal_scroll\n`));
for(const t of Object.values(TRANSITIONS)) {
  const name=`m${t.at.x>>6}_${t.at.z>>6}`;
  assert(mapEntries(read(`server/content/maps/${name}.jm2`),name,'LOC').some(l=>l.id===t.id&&l.x===t.at.x&&l.z===t.at.z&&l.level===t.at.level));
}
const worker=new Worker(new URL('../src/navigation/map-worker.ts',import.meta.url).href);
let ready:()=>void; const loaded=new Promise<void>(r=>ready=r); let seq=0;
const pending=new Map<number,(v:any)=>void>();
worker.onmessage=({data})=>data.ready?ready():pending.get(data.id)?.(data);
const timeout=setTimeout(()=>{worker.terminate();throw new Error('quest-probe-timeout');},120000);
async function probe(name:string,from:any,to:any) {
  const id=++seq; const r:any=await new Promise(done=>{pending.set(id,done);worker.postMessage({id,from,to,questTravel:true});});pending.delete(id);
  console.log(JSON.stringify({name,from,to,error:r.error,legs:r.legs?.length,unmapped:r.unmappedTiles,liveVerified:false}));
  assert.equal(r.error,undefined,name);assert.equal(r.unmappedTiles,0,name);assert.deepEqual(r.legs.at(-1)?.target??from,to);
  let prior=from;
  for(const leg of r.legs) {
    for(const tile of samples(prior,leg.target)) {
      assert(!inQuestDanger(tile),`${name}: quest danger zone ${JSON.stringify(tile)}`);
    }
    prior=leg.target;
  }
  if(to.x===3105&&to.z===3162&&from.z<9000) assert(r.legs.some((l:any)=>l.doors.some((d:any)=>d.x===3107&&d.z===3162&&d.shape===9)), 'tower entry must emit diagonal-door prerequisite');
}
try {
  await loaded;
  const lum={x:3222,z:3218,level:0};
  await probe('CoinCrafter preparation bank',{x:3113,z:3487,level:0},{x:3094,z:3491,level:0});
  await probe('bank to free food patch',{x:3094,z:3491,level:0},{x:3195,z:3286,level:0});
  await probe('castle ground approach',lum,TRANSITIONS.castleUp.approach);
  await probe('castle upstairs to Duke',TRANSITIONS.castleUp.exit,QUEST_NPCS.duke.approach);
  await probe('Duke return stairs',QUEST_NPCS.duke.approach,TRANSITIONS.castleDown.approach);
  await probe('castle exit',TRANSITIONS.castleDown.exit,lum);
  let p=lum;
  for(const to of [...SOUTH_ROAD,TRANSITIONS.towerDown.approach]) { await probe('southern tower corridor',p,to);p=to; }
  await probe('CoinCrafter north shop approach',{x:3229,z:3389,level:0},{x:3253,z:3410,level:0});
  await probe('CoinCrafter north departure',{x:3241,z:3407,level:0},{x:3238,z:3426,level:0});
  await probe('north road to east gate',{x:3238,z:3426,level:0},EAST_ROAD[0]);
  await probe('basement to Sedridor',TRANSITIONS.towerDown.exit,QUEST_NPCS.sedridor.approach);
  await probe('Sedridor to exit',QUEST_NPCS.sedridor.approach,TRANSITIONS.towerUp.approach);
  p=TRANSITIONS.towerUp.exit;
  for(const to of [SOUTH_ROAD[1],SOUTH_ROAD[0],lum,...EAST_ROAD.slice(0,3).reverse(),{x:3253,z:3410,level:0},QUEST_NPCS.aubury.approach]) { await probe('Aubury road',p,to);await probe('Aubury return',to,p);p=to; }
  await probe('Aubury direct first return leg',QUEST_NPCS.aubury.approach,EAST_ROAD[0]);
  console.log('PASS: quest source and all route endpoints. Live transitions and quest completion still require observation.');
}finally{clearTimeout(timeout);worker.terminate();}
