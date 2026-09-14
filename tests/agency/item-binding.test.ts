import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindItemAction, validateItemBinding } from '../../src/agency/item-binding.ts';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';
const action={type:'useItemOnItem',fields:{sourceSlot:5,targetSlot:3}};
const state=()=>({inGame:true,tick:1,capacity:28,player:{lifeId:1,hp:30,worldX:1,worldZ:1,level:0},
  inventory:[{slot:5,id:946,name:'Knife',count:1},{slot:3,id:1511,name:'Logs',count:1}],equipment:[],skills:[]});
test('a missing saved target is not a validated crafting input',()=>{
  const s=state();s.inventory=s.inventory.filter(i=>i.slot!==3);assert.throws(()=>bindItemAction(action,s),/TARGET_MISSING/);
});
test('slot reuse after a fresh observation invalidates the original item binding',()=>{
  const s=state(),b=bindItemAction(action,s);s.inventory[1]!.id=995;
  assert.throws(()=>validateItemBinding(action,s,b),/IDENTITY_CHANGED/);
});
test('swapped, negative, duplicate, empty or conflicting item slots are refused',()=>{
  for(const slots of [{sourceSlot:5,targetSlot:5},{sourceSlot:-1,targetSlot:3},{sourceSlot:5,itemSlot:4,targetSlot:3}])
    assert.throws(()=>bindItemAction({type:'useItemOnItem',fields:slots},state()));
  const s=state();s.inventory.push({...s.inventory[1]!});assert.throws(()=>bindItemAction(action,s),/MISSING_OR_INVALID/);
});
test('a valid fresh item pair keeps its identities and does not require an action-name whitelist',()=>{
  const s=state(),b=bindItemAction(action,s);validateItemBinding({...action},s,b);
  assert.deepEqual(b,[{slot:5,itemId:946},{slot:3,itemId:1511}]);
});
test('invalid item targets are refused before a persistent pending command is created',t=>{
  const dir=mkdtempSync(join(tmpdir(),'binding-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const a=new LiveAgency(join(dir,'state.json'),{agent:'fixture',world:'test',revision:'v1'},{supported:['production']}),s=state();s.inventory=s.inventory.slice(0,1);
  const p=a.plan(s);assert.ok(isSelection(p));assert.throws(()=>a.begin(p,{...action,id:'stale-item'},s,'command'),/TARGET_MISSING/);
  assert.equal(a.pending(),undefined);assert.equal(a.director.memory.pending,undefined);
});
