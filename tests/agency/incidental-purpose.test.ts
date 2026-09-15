import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogue, emptyKnowledge, defaultPolicy } from '../../src/agency/world-model.ts';
import { createMemory } from '../../src/agency/director.ts';

const identity={agent:'tester',world:'w',revision:'r'};
const base=()=>({inGame:true,tick:1,capacity:28,player:{lifeId:1,hp:10,maxHp:10,worldX:10,worldZ:10,level:0,combat:{}},inventory:[],equipment:[],skills:[{name:'Prayer',experience:0,baseLevel:1},{name:'Cooking',experience:0,baseLevel:1}],nearbyLocs:[],nearbyNpcs:[]});

test('an incidental carried resource with a live skill-use option can create generic progress',()=>{
  const s:any=base();s.inventory=[{id:77,name:'Incidental resource',slot:0,count:1,optionsWithIndex:[{opIndex:3,text:'Bury'}]}];
  const c=buildCatalogue(identity,s,emptyKnowledge(),defaultPolicy,['prayer'],createMemory(identity),Date.now());
  assert.ok(c.opportunities.some(o=>o.id==='train-prayer'));assert.ok(c.methods.some(m=>m.id==='train-prayer'));
});

test('a generic raw incidental resource beside observed heat can become a processing opportunity',()=>{
  const s:any=base();s.inventory=[{id:88,name:'Raw provision',slot:0,count:1}];s.nearbyLocs=[{id:9,name:'Range',x:11,z:10,level:0,reachable:true}];
  const c=buildCatalogue(identity,s,emptyKnowledge(),defaultPolicy,['production'],createMemory(identity),Date.now());
  assert.ok(c.opportunities.some(o=>o.id==='incidental-process'));
});

test('discovery is generated from a fresh local transition, never from a seeded coordinate',()=>{
  const s:any=base();s.nearbyLocs=[{id:44,name:'Unnamed object',x:11,z:10,level:0,reachable:true,distance:1,
    optionsWithIndex:[{opIndex:7,text:'Open'}]}];
  const c=buildCatalogue(identity,s,emptyKnowledge(),defaultPolicy,['discovery'],createMemory(identity),Date.now());
  assert.equal(c.opportunities.length,1);assert.match(c.opportunities[0]!.id,/discovered:interaction:44:11:10:0:7/);
  assert.equal(c.tasks.get(c.opportunities[0]!.id)?.kind,'discovery');
});
