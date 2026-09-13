import {test,expect} from 'bun:test';
import {basicKit,canDefend,unsafeMiningNeighbour} from './defence';
const enemy={name:'Mugger',combatLevel:6,hp:5,distance:3,optionsWithIndex:[{text:'Attack'}]};
function state(){return {player:{hp:20,maxHp:20,combatLevel:12},equipment:[{name:'Iron sword'},{name:'Iron sq shield'},{name:'Iron platebody'}],inventory:[],nearbyNpcs:[enemy]};}
test('a pickaxe is not a defensive kit',()=>{const s=state();s.equipment=[{name:'Adamant pickaxe'}];expect(basicKit(s)).toBe(false);expect(canDefend(s,enemy)).toBe(false);});
test('prepared miner can hold a weak opponent but not at near-death HP',()=>{const s=state();expect(canDefend(s,enemy)).toBe(true);s.player.hp=2;expect(canDefend(s,enemy)).toBe(false);});
test('higher ore does not override nearby monster safety',()=>{const s=state();s.nearbyNpcs=[{...enemy,combatLevel:50}];expect(unsafeMiningNeighbour(s)).toBe(true);s.nearbyNpcs=[];expect(unsafeMiningNeighbour(s)).toBe(false);});
