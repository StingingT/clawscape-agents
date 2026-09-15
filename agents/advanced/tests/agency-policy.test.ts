import {test,expect} from 'bun:test';
import {LivePolicy} from '../src/live-policy.ts';
import type {Observation} from '../src/contracts.ts';

function observed():Observation {
  const at=Date.now();
  return {schema_version:'1.0',character:'astra',world:'test',world_epoch:'1',session_id:'session',profile_id:'test',seq:1,tick:1,
    observed_at:at,fresh_at:at,provenance:'cli-player-observation',connected:true,position:{x:3232,z:3230,plane:0},hp:10,max_hp:10,life_id:1,respawns:0,
    skills:['attack','strength','defence','fishing','cooking','woodcutting','firemaking'].map(name=>({name,current:60,base:60,xp:100_000})),
    capacity:28,inventory:Array.from({length:8},(_,slot)=>({slot,id:315,name:'Shrimps',count:1,protected:false,options:[{index:1,text:'Eat'}]})),
    equipment:[{slot:3,id:1277,name:'Bronze sword',count:1,protected:false,options:[]},{slot:5,id:1171,name:'Wooden shield',count:1,protected:false,options:[]}],
    bank:{open:false,items:null},shop_open:false,dialog:{open:false,waiting:false,text:'',options:[]},feedback:[],danger:{active:false,damage_margin:2},unavailable:[],
    entities:[{kind:'npc',ref:'goblin-7',index:7,content_id:100,name:'Goblin',position:{x:3233,z:3230,plane:0},reachable:true,
      options:[{index:2,text:'Attack'}],combat_level:2,hp:5,max_hp:5,in_combat:false}],
    activity:{animation:-1,target_index:-1,target_type:'none',last_damage_tick:-1,modal_open:false,modal_id:-1,style:0,
      styles:[{index:0,name:'Chop',skill:'attack'},{index:1,name:'Slash',skill:'strength'},{index:2,name:'Block',skill:'defence'}],design_open:false,events:[]}};
}
test('Astra executes the already selected exploration task instead of its legacy local training choice',()=>{
  const o=observed();const task={id:'survey:own-lead',kind:'exploration' as const,route:{id:'own-lead',x:3240,z:3240,level:0,evidence:'own observed exit'}};
  const d=new LivePolicy().next(o,task);expect(d.destination).toEqual({x:3240,z:3240,plane:0});expect(d.goal).toBe('survey:own-lead');
});
test('selected Defence trial does not terminate at the old 40/60/40 targets',()=>{
  const d=new LivePolicy().next(observed(),{id:'train-defence',kind:'combat',skill:'defence'});
  expect(d.blocked).toBeUndefined();expect(d.intent).toEqual({operation:'style',style_index:2});
});
test('urgent healing overrides an exploration task without selecting ordinary combat',()=>{
  const o=observed();o.hp=4;
  const d=new LivePolicy().next(o,{id:'survey',kind:'exploration',route:{id:'x',x:3240,z:3240,level:0,evidence:'own observation'}});
  expect(d.intent?.operation).toBe('eat');
});
test('unsupported task does not silently fall back to the old training policy',()=>{
  const d=new LivePolicy().next(observed(),{id:'craft',kind:'production'});expect(d.blocked).toBe('UNSUPPORTED_TASK_EXECUTOR');
});
test('a selected supply task cannot default to a monster when its supply is already satisfied',()=>{
  const d=new LivePolicy().next(observed(),{id:'food',kind:'food'});expect(d.wait).toBe(true);expect(d.intent).toBeUndefined();
});

test('Astra partial movement completes the action observation without losing its exploration task',()=>{
  const before=observed(),policy=new LivePolicy(),task={id:'survey:site',kind:'exploration' as const,route:{id:'site',x:3240,z:3240,level:0,evidence:'own observed site'}};
  const next=structuredClone(before);next.seq++;next.tick!++;next.observed_at+=600;next.fresh_at=next.observed_at;next.position!.x++;
  const decision=policy.next(before,task);decision.intent={operation:'move',destination:{x:3240,z:3240,plane:0}};
  policy.recordOutcome(before,next,decision,'SUCCEEDED');
  expect((policy.summary() as any).state.uncertain).toBeNull();expect(policy.next(next,task).goal).toBe(task.id);
});
test('standalone policy has no old 40/60/40 completion gate or reported fixed quotas',()=>{
 const policy=new LivePolicy();expect(policy.next(observed()).blocked).not.toBe('PROPOSED_TARGETS_REACHED');expect((policy.summary() as any).proposalTargets).toBeUndefined();
});

test('a delayed own kill event is attributed once without requiring a damage field',()=>{
 const policy=new LivePolicy(),before=observed();before.hp=10;before.own_player_index=11;
 before.activity!.target_type='npc';before.activity!.target_index=7;
 const after=structuredClone(before);after.seq++;after.tick!++;after.observed_at+=600;after.fresh_at=after.observed_at;
 after.skills[0]!.xp+=10;after.entities=[];after.activity!.target_type='none';after.activity!.target_index=-1;
 policy.observe(before,after);expect((policy.summary() as any).state.learning.active).not.toBeNull();
 const delayed=structuredClone(after);delayed.seq++;delayed.tick!++;delayed.observed_at+=600;delayed.fresh_at=delayed.observed_at;
 delayed.activity!.events=[{tick:after.tick!,type:'kill',source_type:'player',source_index:11,target_type:'npc',target_index:7,damage:0}];
 policy.observe(after,delayed);policy.observe(after,delayed);
 const summary=(policy.summary() as any).state;expect(summary.counters.encountersCompleted).toBe(1);expect(summary.learning.methods[0].confirmed).toBe(1);
});
test('XP, disappearance or a different player kill do not become a confirmed own kill',()=>{
 const policy=new LivePolicy(),before=observed();before.own_player_index=11;before.activity!.target_type='npc';before.activity!.target_index=7;
 const after=structuredClone(before);after.seq++;after.tick!++;after.observed_at+=600;after.fresh_at=after.observed_at;
 after.skills[0]!.xp+=10;after.entities=[];after.activity!.target_type='none';after.activity!.target_index=-1;
 after.activity!.events=[{tick:after.tick!,type:'kill',source_type:'player',source_index:12,target_type:'npc',target_index:7,damage:0}];
 policy.observe(before,after);const end=structuredClone(after);end.seq++;end.tick!+=4;end.observed_at+=3000;end.fresh_at=end.observed_at;
 policy.observe(after,end);const summary=(policy.summary() as any).state;
 expect(summary.learning.active).toBeNull();expect(summary.counters.encountersCompleted).toBe(0);expect(summary.learning.methods[0].xp).toBe(10);expect(summary.learning.methods[0].uncertain).toBe(1);
});
test('observed NPC index reuse or life change cannot receive old encounter credit',()=>{
 for(const lifeChange of [true,false]){
 const policy=new LivePolicy(),before=observed();before.own_player_index=11;before.activity!.target_type='npc';before.activity!.target_index=7;
 const after=structuredClone(before);after.seq++;after.tick!++;after.observed_at+=600;
 if(lifeChange)after.life_id=2;else after.entities[0]!.content_id=999;
 after.activity!.events=[{tick:after.tick!,type:'kill',source_type:'player',source_index:11,target_type:'npc',target_index:7,damage:0}];
 policy.observe(before,after);expect((policy.summary() as any).state.counters.encountersCompleted).toBe(0);
 }
});
