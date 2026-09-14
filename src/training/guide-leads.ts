/** Textual recommendations remain hypotheses. Only the local catalogue binds NPCs/coordinates. */
import { GUIDE_DATE } from '../agency/build-guides.ts';
export type GuideLead = {id:string;family:string;location:string;source:string;siteIds:string[];
  prerequisites:string[];hazards:string[];purpose:string;scope:string;reviewedAt:string};
const wiki='https://oldschool.runescape.wiki/w/';
const starter=(id:string,family:string,location:string,siteIds:string[]):GuideLead=>({id,family,location,siteIds,
  source:wiki+'Free-to-play_Ironman_guide',purpose:'Compare permitted combat XP and useful supplies over a complete trip.',
  prerequisites:[],hazards:['Verify food, ammunition, live target and a return route.'],scope:'Guide lead; server revision unknown',reviewedAt:GUIDE_DATE});
export const TRAINING_LEADS:readonly GuideLead[]=[
  starter('lumbridge-chickens','chicken','Lumbridge farms',['east-chickens','fred-chickens']),
  starter('lumbridge-cows','cow','Lumbridge cattle fields',['east-cows','windmill-cows']),
  starter('lumbridge-goblins','goblin','Lumbridge',['lumbridge-goblins','lumbridge-armed-goblins']),
  {...starter('village-barbarians','barbarian','Barbarian Village',['village-barbarians']),source:'repository:src/training/catalog.ts',hazards:['A higher monster level is not evidence of a better method.']},
  {...starter('monastery-monks','monk','Edgeville Monastery',[]),source:'https://oldschoolrunescape.fandom.com/wiki/Free-to-play_melee_training',prerequisites:['monastery-access','monk-healing-observed']},
  {...starter('hill-giants','hill giant','Edgeville Dungeon',[]),prerequisites:['dungeon-entry-exit','hill-giant-safespot'],hazards:['Validate access items and the actual firing position; no modern boss-key assumption.']},
  {...starter('moss-giants','moss giant','Varrock Sewers',[]),prerequisites:['sewer-entry-exit','moss-giant-safespot'],hazards:['Validate obstacles, return route and damage before extending a trial.']},
  {...starter('rock-crabs','rock crab','Coast north of Rellekka',[]),source:wiki+'Rock_Crab',prerequisites:['rock-crab-content','rellekka-route','rock-crab-activation'],hazards:['Introduced November 2004; not assumed present. No Waterbirth/Kourend substitution.']},
];
export function inspectTrainingLeads(ids:readonly string[],siteIds:readonly string[]) {
  return TRAINING_LEADS.filter(l=>ids.includes(l.id)).map(l=>({...l,
    status:l.siteIds.some(id=>siteIds.includes(id))?'local-content-bound':'investigation-required',
    personalAccess:'unverified',effectiveness:'unmeasured'}));
}
/** A modest prior that vanishes after three encounters; no guide can overrule a route/safety gate. */
export function guidePrior(ids:readonly string[],siteId:string,encounters:number):number {
  return TRAINING_LEADS.some(l=>ids.includes(l.id)&&!l.prerequisites.length&&l.siteIds.includes(siteId))
    ? 0.5*Math.max(0,1-Math.max(0,encounters)/3):0;
}
