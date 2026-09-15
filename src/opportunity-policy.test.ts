import {describe,expect,test} from 'bun:test';
import {incidentalOpportunity,bankableIncidentalEquipment} from './opportunity-policy';
const base=()=>({capacity:28,player:{combat:{inCombat:false}},inventory:[] as any[],equipment:[] as any[],groundItems:[] as any[]});
describe('incidental opportunities',()=>{
 test('collects a useful incidental resource without replacing the primary trip',()=>{const s=base();s.groundItems=[{id:1,name:'Raw trout',x:1,z:1,distance:1,reachable:true}];expect(incidentalOpportunity(s,'combat')?.type).toBe('pickupItem');});
 test('collects non-upgrade equipment when spare space exists',()=>{const s=base();s.equipment=[{id:2,name:'Steel sword'}];s.groundItems=[{id:3,name:'Bronze sword',x:1,z:1,distance:1,reachable:true}];expect(incidentalOpportunity(s,'combat')?.type).toBe('pickupItem');});
 test('does not sacrifice gathering cargo margin for nonstacking side loot',()=>{const s=base();s.inventory=Array.from({length:25},(_,i)=>({id:100+i,name:'Logs'}));s.groundItems=[{id:3,name:'Bronze sword',x:1,z:1,distance:1,reachable:true}];expect(incidentalOpportunity(s,'gathering')).toBeUndefined();});
 test('allows cheap immediate progression from an observed item action',()=>{const s=base();s.inventory=[{id:5,name:'Mysterious remains',slot:7,optionsWithIndex:[{text:'Bury',opIndex:2}]}];expect(incidentalOpportunity(s,'exploration')?.type).toBe('useInventoryItem');});
 test('does not chase a useful item beyond bounded incidental distance',()=>{const s=base();s.groundItems=[{id:1,name:'Rune platebody',x:8,z:8,distance:8,reachable:true}];expect(incidentalOpportunity(s,'combat')).toBeUndefined();});
 test('recognizes incidental equipment as bankable collection material',()=>expect(bankableIncidentalEquipment({name:'Iron kiteshield'})).toBe(true));
});
