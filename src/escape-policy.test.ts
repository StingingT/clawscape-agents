import {test,expect} from 'bun:test';
import {mustEscape, type EscapeMemory} from './escape-policy';
test('empty outgoing target does not release a mugger escape between hits or after restart',()=>{
 const m:EscapeMemory={}; const s:any={tick:100,player:{combat:{inCombat:true,targetIndex:-1,lastDamageTick:100}},nearbyNpcs:[]};
 expect(mustEscape(s,m)).toBe(true);
 s.tick=108;expect(mustEscape(s,m)).toBe(true);
 const resumed=JSON.parse(JSON.stringify(m));s.tick=111;expect(mustEscape(s,resumed)).toBe(true);
 s.tick=121;expect(mustEscape(s,resumed)).toBe(false);
});
