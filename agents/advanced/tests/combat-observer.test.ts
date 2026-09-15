import {test,expect} from 'bun:test';
import {projectSnapshot} from '../src/observer.ts';
test('observer keeps a fully identified kill without damage, and optional self index, but rejects anonymous kills',()=>{
 const now=Date.now();const raw={connected:true,state:{tick:2,player:{name:'astra',index:11,worldX:1,worldZ:1,level:0,hp:10,maxHp:10,lifeId:1,respawnCount:0,animId:-1,combat:{targetType:'none',targetIndex:-1}},
  inventory:[],equipment:[],skills:[],combatEvents:[{type:'kill',tick:2,sourceType:'player',sourceIndex:11,targetType:'npc',targetIndex:7},{type:'kill',tick:2,targetType:'npc',targetIndex:7}]}};
 const o=projectSnapshot(raw,{character:'astra',world:'test',session:'s',profile:'fixture',seq:2,now,freshAt:now,keep:[]});
 expect(o.own_player_index).toBe(11);expect(o.activity!.events).toHaveLength(1);expect(o.activity!.events![0]!.type).toBe('kill');
});
