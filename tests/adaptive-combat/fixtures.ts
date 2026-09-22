import { emptyAdaptive, beginEncounter, observeEncounter, finishEncounter, type EncounterRecord } from '../../src/training/adaptive-combat.ts';
export const state=(patch:any={}):any=>({inGame:true,tick:1,world:'local',members:true,multiCombat:false,activePrayers:[],activeEffects:[],
 player:{index:7,lifeId:1,hp:40,maxHp:40,level:0,worldX:3200,worldZ:3200,isDead:false,respawnCount:0,combat:{inCombat:false,targetType:'none',lastDamageTick:-1}},
 skills:['attack','strength','defence','ranged','magic','hitpoints','prayer'].map(name=>({name,baseLevel:40,currentLevel:40,experience:1000})),
 inventory:[{id:100,name:'Meal',count:3,slot:0,optionsWithIndex:[{text:'Eat',opIndex:1}]},{id:102,name:'Other sword',count:1,slot:1,optionsWithIndex:[{text:'Wield',opIndex:2}]}],
 equipment:[{id:101,name:'Sword',count:1,slot:3},{id:201,name:'Body',count:1,slot:4},{id:301,name:'Arrow',count:30,slot:13}],
 combatStyle:{weaponName:'Iron scimitar',currentStyle:0,styles:[{index:0,trainsSkills:['strength'],type:'slash'}]},
 nearbyNpcs:[target()],combatEvents:[],bank:{isOpen:false},shop:{isOpen:false},dialog:{isOpen:false},...patch});
export const target=()=>({index:9,id:1,name:'Test opponent',combatLevel:5,spawnId:'spawn',hp:10,reachable:true,inCombat:false,distance:1,x:3201,z:3200,optionsWithIndex:[{text:'Attack',opIndex:2}]});
export const event=(type='kill',damage?:number,patch:any={})=>({tick:5,type,damage,sourceType:'player',sourceIndex:7,targetType:'npc',targetIndex:9,...patch});
export function record(patch:any={},outcome='kill'):EncounterRecord{
 const m=emptyAdaptive(),b=state(patch);beginEncounter(m,b,target(),'site','stinger','profile','session',100);
 const a=structuredClone(b);a.tick=5;a.combatEvents=outcome==='kill'?[event('damage_dealt',10),event()]:[];a.skills[1].experience+=20;
 observeEncounter(m,b,a,{type:'wait'},200);if(m.pending)finishEncounter(m,outcome as any,200);return m.samples[0];
}
