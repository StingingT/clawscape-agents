import { describe, expect, test } from 'bun:test';
import { verifyActionOutcome } from './action-outcome';

const state=(extra:any={})=>({tick:1,player:{worldX:1,worldZ:1,hp:10,combat:{inCombat:false}},inventory:[{id:1,count:1}],skills:[{name:'Mining',experience:0}],...extra});
describe('action-specific outcome contracts',()=>{
 test('tick advancement alone is not purchase verification',()=>{const v=verifyActionOutcome(state(),state({tick:2}),{id:'buy-ore',type:'shopBuy',fields:{slot:1}});expect(v.verified).toBe(false);expect(v.uncertain).toBe(true);});
 test('HP loss is not progress',()=>{const v=verifyActionOutcome(state(),state({player:{worldX:1,worldZ:1,hp:8,combat:{inCombat:false}}}),{id:'mine-ore',type:'interactLoc'});expect(v.verified).toBe(false);});
 test('bank transfer requires both sides to change',()=>{const before=state({bank:{isOpen:true,items:[{id:2,slot:4,count:5}]},inventory:[{id:2,slot:0,count:1}]});const after=state({bank:{isOpen:true,items:[{id:2,slot:4,count:6}]},inventory:[]});const v=verifyActionOutcome(before,after,{id:'bank-deposit',type:'bankDeposit',fields:{slot:0}});expect(v.verified).toBe(true);});
});
