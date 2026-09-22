import {test} from 'node:test';
import assert from 'node:assert/strict';
import { emptyAdaptive, captureContext, contextKey, beginEncounter, observeEncounter, finishEncounter, summarize, compareRecords, comparisonReport, readinessDecision, progressiveTrialAllowed, stableSample, type EncounterRecord } from '../../src/training/adaptive-combat.ts';
import { state, target, event, record } from './fixtures.ts';
test('exact Attack levels and armour/ammunition differ inside the same legacy band',()=>{
 const a=state(),b=state();b.skills[0].baseLevel=41;assert.notEqual(contextKey(a,'p'),contextKey(b,'p'));
 for(const slot of [3,4,13]){const c=state();c.equipment.find((x:any)=>x.slot===slot).id++;assert.notEqual(contextKey(a,'p'),contextKey(c,'p'));}
});
test('ammunition quantity and XP gain do not fragment a configuration',()=>{
 const a=state(),b=state();b.equipment[2].count--;b.skills[0].experience++;assert.equal(contextKey(a,'p'),contextKey(b,'p'));
});
test('resource meters HP/prayer are retained but do not masquerade as combat-level changes',()=>{
 const a=state(),b=state();b.skills[5].currentLevel--;b.skills[6].currentLevel--;assert.equal(contextKey(a,'p'),contextKey(b,'p'));
 assert.notDeepEqual(captureContext(a,'p').skills,captureContext(b,'p').skills);
});
test('profile/style/prayer differences prevent exact-match reuse',()=>{
 const a=state(),b=state({activePrayers:['attack']});assert.notEqual(contextKey(a,'p'),contextKey(b,'p'));
 assert.notEqual(contextKey(a,'p'),contextKey(a,'q'));b.combatStyle.currentStyle=4;assert.notEqual(contextKey(a,'p'),contextKey(b,'p'));
});
test('equipment amounts do not change context but missing fields remain unknown',()=>{
 const a=state();delete a.activePrayers;delete a.activeEffects;delete a.skills;const c=captureContext(a,'p');assert.ok(c.unknown.includes('prayers'));assert.ok(c.unknown.includes('skill:attack'));
});
test('same pending start and repeated observed event windows are not extra encounters',()=>{
 const m=emptyAdaptive(),b=state();const a=beginEncounter(m,b,target(),'site','stinger','profile','session',1);
 assert.equal(beginEncounter(m,b,target(),'site','stinger','profile','session',1)?.id,a?.id);
 const end=state({tick:5,combatEvents:[event('damage_dealt',10),event()]});observeEncounter(m,b,end,{type:'wait'},2);observeEncounter(m,b,end,{type:'wait'},3);
 assert.equal(m.samples.length,1);assert.equal(m.samples[0].metrics.damageDealt,10);
});
test('incoming and outgoing damage only use exact observed identities',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);
 const a=state({tick:5,combatEvents:[event('damage_dealt',10),event('damage_dealt',50,{sourceIndex:8}),event('damage_taken',4,{sourceType:'npc',sourceIndex:9,targetType:'player',targetIndex:7}),event('damage_taken',99,{sourceType:'npc',sourceIndex:9,targetType:'player',targetIndex:8}),event()]});
 observeEncounter(m,b,a,{type:'wait'},2);assert.equal(m.samples[0].metrics.damageDealt,10);assert.equal(m.samples[0].metrics.damageTaken,4);
 assert.ok(m.samples[0].quality.includes('other-attacker-observed'));assert.equal(stableSample(m.samples[0]),false);
});
test('missing events are unknown damage, not zero or misses',()=>{
 const e=record({},'unresolved');assert.equal(e.metrics.damageTaken,null);assert.equal(e.metrics.damageDealt,null);assert.equal(e.metrics.hitRate,null);assert.equal(e.outcome,'unresolved');
});
test('HP decrease remains a distinct lower bound, not exact incoming damage',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5});a.player.hp=35;
 observeEncounter(m,b,a,{type:'wait'},2);assert.equal(m.pending?.metrics.damageTaken,null);assert.equal(m.pending?.metrics.hpDecreaseLowerBound,5);
});
test('unknown own-player identity never infers a kill from XP or someone else',()=>{
 const m=emptyAdaptive(),b=state();delete b.player.index;beginEncounter(m,b,target(),'site','stinger','p','s',1);
 const a=structuredClone(b);a.tick=5;a.combatEvents=[event()];a.skills[1].experience+=30;observeEncounter(m,b,a,{type:'wait'},2);
 assert.equal(m.pending?.killObserved,false);
});
test('NPC index reused for another type interrupts before accepting kill events',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5,combatEvents:[event()]});a.nearbyNpcs[0].id=2;
 observeEncounter(m,b,a,{type:'wait'},2);assert.equal(m.samples[0].outcome,'interrupted');assert.equal(m.samples[0].killObserved,false);
});
test('same NPC type with changed spawn identity is also rejected',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5,combatEvents:[event()]});a.nearbyNpcs[0].spawnId='new';
 observeEncounter(m,b,a,{type:'wait'},2);assert.equal(m.samples[0].outcome,'interrupted');
});
test('tick reset and reconnect-like life change are interruptions, not invented deaths',()=>{
 for(const reason of ['tick','life']){const m=emptyAdaptive(),b=state({tick:10});beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:11});
 if(reason==='tick')a.tick=1;else a.player.lifeId=2;observeEncounter(m,b,a,{type:'wait'},2);assert.equal(m.samples[0].outcome,'interrupted');}
});
test('a direct death observation is retained',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5});a.player.isDead=true;observeEncounter(m,b,a,{type:'wait'},2);assert.equal(m.samples[0].outcome,'death');
});
test('retreat measurements do not become a completed kill time',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5,combatEvents:[event('damage_dealt',5)]});observeEncounter(m,b,a,{type:'retreat'},2);
 assert.equal(m.samples[0].metrics.ticks,4);assert.equal(m.samples[0].outcome,'retreat');assert.equal(summarize(m.samples).meanTicks,null);
});
test('mid-encounter level increase is explicitly marked and excluded from controlled aggregation',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5,combatEvents:[event()]});a.skills[0].baseLevel++;
 observeEncounter(m,b,a,{type:'wait'},2);assert.deepEqual(m.samples[0].changes[0].kind,['skills']);assert.equal(summarize(m.samples).comparableKills,0);
});
test('changes of boost, style, armour and ammunition are each retained',()=>{
 for(const k of ['boost','style','armour','ammo']){const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5,combatEvents:[event()]});
 if(k==='boost')a.skills[1].currentLevel++;if(k==='style')a.combatStyle.styles[0].trainsSkills=['attack'];if(k==='armour')a.equipment[1].id++;if(k==='ammo')a.equipment[2].id++;
 observeEncounter(m,b,a,{type:'wait'},2);assert.equal(m.samples[0].changes.length,1);assert.equal(stableSample(m.samples[0]),false);}
});
test('overlapping observation intervals cannot double count XP, resources or events',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5,combatEvents:[event('damage_dealt',10)]});a.skills[1].experience+=20;
 observeEncounter(m,b,a,{type:'wait'},2);const c=structuredClone(a);c.tick=6;c.combatEvents.push(event('damage_dealt',3,{tick:6}));observeEncounter(m,b,c,{type:'wait'},3);
 assert.equal(m.pending?.metrics.damageDealt,13);assert.equal(m.pending?.metrics.xp.strength,20);assert.ok(m.pending?.quality.includes('observation-gap'));
});
test('food and resource accounting preserve per-item quantities and provenance',()=>{
 const m=emptyAdaptive(),b=state();beginEncounter(m,b,target(),'site','stinger','p','s',1);const a=state({tick:5,combatEvents:[event()]});a.inventory[0].count--;a.equipment[2].count-=2;
 observeEncounter(m,b,a,{type:'useInventoryItem',fields:{slot:0,optionIndex:1}},2);const e=m.samples[0];assert.equal(e.metrics.foodUsed[100],1);assert.equal(e.metrics.netResourceDecrease[301],2);assert.equal(e.metrics.resourceQuality,'observed-net-change');
});
test('a simultaneous equipment and skill upgrade is readiness, never an isolated gear effect',()=>{
 const a=record(),s=state();s.equipment[0].id=999;s.skills[0].baseLevel=50;s.skills[1].baseLevel=99;const b=record(s);
 const result=compareRecords([a],[b]);assert.equal(result.kind,'readiness-comparison');assert.equal(result.isolatedEquipmentEffect,false);
});
test('same recorded controls and changed ammo are an observational equipment comparison',()=>{
 const a=record(),s=state();s.equipment[2].id=302;const b=record(s);const r=compareRecords([a],[b]);assert.equal(r.kind,'equipment-observational-comparison');assert.deepEqual(r.changedSlots,[13]);
});
test('matched explicitly linked arms are equipment experiments, not causal proof',()=>{
 const a=record(),s=state();s.equipment[0].id=102;const b=record(s);a.experimentId=b.experimentId='experiment';a.arm='A';b.arm='B';
 const r=compareRecords([a],[b]);assert.equal(r.kind,'equipment-experiment');assert.match(r.interpretation!,/do not declare causation/);
});
test('multiple armour slots are labelled an equipment-set comparison',()=>{
 const a=record(),s=state();s.equipment[0].id=102;s.equipment[1].id=202;const b=record(s);assert.equal(compareRecords([a],[b]).equipmentFactor,'equipment-set');
});
test('unknown prayers/effects remain caveats rather than verified inactive controls',()=>{
 const a=record({activePrayers:undefined}),b=record({activePrayers:undefined});b.start.equipment[0].id=102;b.end=structuredClone(b.start);
 const r=compareRecords([a],[b]);assert.ok(r.unknownControls?.includes('prayers'));assert.equal(r.isolatedEquipmentEffect,false);
});
test('different starting health downgrades equipment claims',()=>{
 const a=record(),s=state();s.equipment[0].id=102;const b=record(s);b.startHp=30;assert.equal(compareRecords([a],[b]).kind,'readiness-comparison');
});
test('rules profiles, sites and NPC variants cannot be pooled',()=>{
 const a=record(),b=record();b.profile='different';assert.equal(compareRecords([a],[b]).kind,'not-comparable');
});
test('ranking uses exact own conditions and explicit failure/cost feedback',()=>{
 const m=emptyAdaptive(),a=record({},'retreat');m.samples=[a];const s=state({__adaptiveAgent:'stinger'});
 const d=readinessDecision(m,s,'profile',1,'site','strength');assert.ok(d.score<0);assert.ok(d.suggestedReview.includes('equipment'));
 s.skills[0].baseLevel++;assert.equal(readinessDecision(m,s,'profile',1,'site','strength').score,0);
 s.skills[0].baseLevel--;s.__adaptiveAgent='featherer';assert.equal(readinessDecision(m,s,'profile',1,'site','strength').score,0);
});
test('progressive proposals allow <=10 from tested baseline, never equate levels with safety',()=>{
 const m=emptyAdaptive();m.samples=[record()];const c=captureContext(state(),'profile');assert.equal(progressiveTrialAllowed(m,c,15,10).allowed,true);assert.equal(progressiveTrialAllowed(m,c,16,10).allowed,false);
});
test('comparison report retains separate configuration groups and bounded samples',()=>{
 const m=emptyAdaptive();m.samples=[record()];const b=record();b.start.skills.attack.base=55;b.end=structuredClone(b.start);m.samples.push(b);
 assert.equal(comparisonReport(m).groups.length,2);assert.equal(comparisonReport(m).comparisons[0].kind,'readiness-comparison');
});
