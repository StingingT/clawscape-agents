// Read live observations and update the persistent plans; no game actions.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { callSkill } from '../src/skill-cli';
import { loadGearCatalog } from '../src/goals/catalog';
import { EquipmentGoals } from '../src/goals/planner';
const root=resolve(import.meta.dir,'..');
for(const profile of ['online','stinger','coincrafter']) {
  let lock:any;try{lock=JSON.parse(readFileSync(resolve(root,'data',profile,'controller.lock'),'utf8'));}catch{}
  if(lock?.pid) {try{process.kill(lock.pid,0);}catch{continue;}throw new Error('Stop the controller before updating its plan offline: '+profile);}
}
for(const [character,profile,role,ranged] of [['clawscout','online','brawler',false],['stinger','stinger','brawler',true],['coincrafter','coincrafter','economy',false]] as const) {
  const {state}=await callSkill(character,['state'],resolve(root,'data/online-home'));
  if(!state?.player)throw new Error('No live state for '+character);
  const catalog=loadGearCatalog();
  const work=JSON.parse(readFileSync(resolve(root,'data',profile,'work-state.json'),'utf8'));
  const planner=new EquipmentGoals(resolve(root,'data',profile,'equipment-goals.json'),catalog,role,ranged);
  planner.seedBank(work.economy?.bankItems??work.bankItems??[]);
  const result=planner.plan(state);
  console.log(JSON.stringify({character,target:result.target,method:result.goal?.method,cash:result.cash,
    longTerm:result.longTerm,alternatives:result.alternatives.filter((a:any)=>a.item===result.target||a.item===result.longTerm[0]?.name)}));
}
