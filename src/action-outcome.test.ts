import { describe, expect, test } from 'bun:test';
import { verifyActionOutcome } from './action-outcome';

const state=(extra:any={})=>({tick:1,player:{worldX:1,worldZ:1,hp:10,combat:{inCombat:false}},inventory:[{id:1,count:1}],skills:[{name:'Mining',experience:0}],...extra});
describe('action-specific outcome contracts',()=>{
 test('tick advancement alone is not purchase verification',()=>{const v=verifyActionOutcome(state(),state({tick:2}),{id:'buy-ore',type:'shopBuy',fields:{slot:1}});expect(v.verified).toBe(false);expect(v.uncertain).toBe(true);});
 test('HP loss is not progress',()=>{const v=verifyActionOutcome(state(),state({player:{worldX:1,worldZ:1,hp:8,combat:{inCombat:false}}}),{id:'mine-ore',type:'interactLoc'});expect(v.verified).toBe(false);});
 test('a traversal experiment rejects an unrelated interface opening',()=>{
  const before=state({nearbyLocs:[{id:1,x:1,z:2,optionsWithIndex:[{opIndex:1,text:'Use'}]}]});
  const after=state({bank:{isOpen:true,items:[]}});
  const v=verifyActionOutcome(before,after,{id:'test-transition',type:'interactLoc',fields:{locId:1,x:1,z:2,optionIndex:1,expectedEffect:'world-transition'}});
  expect(v.interrupted).toBe(true);expect(v.verified).toBe(false);expect(v.uncertain).toBe(false);
 });
test('a fresh explicit server refusal settles a local interaction as rejected',()=>{
  const before=state({nearbyLocs:[{id:1,x:1,z:2,optionsWithIndex:[{opIndex:1,text:'Open'}]}],messages:[]});
  const after=state({messages:[{tick:2,type:0,text:"The gate is locked securely, it won't open!"}]});
  const v=verifyActionOutcome(before,after,{id:'open-gate',type:'interactLoc',fields:{locId:1,x:1,z:2,optionIndex:1}});
  expect(v.verified).toBe(false);expect(v.uncertain).toBe(false);expect(v.reason).toMatch(/refusal/);
 });
 test('a search experiment requires an observable clue rather than a click acknowledgement',()=>{
  const before=state({nearbyLocs:[{id:2,x:1,z:2,optionsWithIndex:[{opIndex:1,text:'Search'}]}]});
  const noClue=verifyActionOutcome(before,state({nearbyLocs:[{id:2,x:1,z:2,optionsWithIndex:[{opIndex:1,text:'Search'}]}]}),{type:'interactLoc',fields:{locId:2,x:1,z:2,optionIndex:1,expectedEffect:'access-clue'}});
  expect(noClue.verified).toBe(false);
  const clue=verifyActionOutcome(before,state({inventory:[{id:1,count:1},{id:2,count:1}],nearbyLocs:[{id:2,x:1,z:2,optionsWithIndex:[{opIndex:1,text:'Search'}]}]}),{type:'interactLoc',fields:{locId:2,x:1,z:2,optionIndex:1,expectedEffect:'access-clue'}});
  expect(clue.verified).toBe(true);
 });
 test('an unchanged opened obstruction is a rejected traversal result, not unknown',()=>{
  const before=state({nearbyLocs:[{id:3,x:1,z:2,optionsWithIndex:[{opIndex:1,text:'Open'}]}]});
  const after=state({nearbyLocs:[{id:3,x:1,z:2,optionsWithIndex:[{opIndex:1,text:'Open'}]}]});
  const v=verifyActionOutcome(before,after,{type:'interactLoc',fields:{locId:3,x:1,z:2,optionIndex:1,expectedEffect:'world-transition'}});
  expect(v.verified).toBe(false);expect(v.uncertain).toBe(false);
 });
 test('bank transfer requires both sides to change',()=>{const before=state({bank:{isOpen:true,items:[{id:2,slot:4,count:5}]},inventory:[{id:2,slot:0,count:1}]});const after=state({bank:{isOpen:true,items:[{id:2,slot:4,count:6}]},inventory:[]});const v=verifyActionOutcome(before,after,{id:'bank-deposit',type:'bankDeposit',fields:{slot:0,amount:1}});expect(v.verified).toBe(true);});
});
test('a fresh live gameMessages refusal settles a local interaction as rejected',()=>{
  const before=state({nearbyLocs:[{id:1,x:1,z:2,optionsWithIndex:[{opIndex:1,text:'Open'}]}],gameMessages:[]});
  const after=state({gameMessages:[{tick:2,type:0,text:"The gate is locked securely, it won't open!"}]});
  const v=verifyActionOutcome(before,after,{id:'open-gate',type:'interactLoc',fields:{locId:1,x:1,z:2,optionIndex:1}});
  expect(v.verified).toBe(false);expect(v.uncertain).toBe(false);expect(v.reason).toMatch(/refusal/);
});
