import test from 'node:test';import assert from 'node:assert/strict';
import {chooseIncidentalUse} from './incidental-use.ts';
const base=()=>({player:{combat:{inCombat:false}},inventory:[],bank:{isOpen:false},shop:{isOpen:false},dialog:{isOpen:false},modalOpen:false});
test('observed low-cost progression option can be used without naming an item',()=>{const s:any=base();s.inventory=[{id:99,name:'Observed resource',slot:4,optionsWithIndex:[{text:'Bury',opIndex:2}]}];const a=chooseIncidentalUse(s);assert.equal(a?.type,'useInventoryItem');assert.equal(a?.fields.slot,4);});
test('incidental use yields during combat and interfaces',()=>{const s:any=base();s.inventory=[{id:99,name:'Observed resource',slot:4,optionsWithIndex:[{text:'Bury',opIndex:2}]}];s.player.combat.inCombat=true;assert.equal(chooseIncidentalUse(s),undefined);s.player.combat.inCombat=false;s.bank.isOpen=true;assert.equal(chooseIncidentalUse(s),undefined);});
test('unrecognized item actions are not invented as progression',()=>{const s:any=base();s.inventory=[{id:99,name:'Observed resource',slot:4,optionsWithIndex:[{text:'Use',opIndex:2}]}];assert.equal(chooseIncidentalUse(s),undefined);});
