import { describe, expect, test } from 'bun:test';
import { dropLearningCandidates, recordObservedDrops, runeDiscoveryCandidates } from './world-knowledge';

describe('world knowledge', () => {
  test('does not automate an unobserved essence interaction', () => {
    const actions = runeDiscoveryCandidates({ player: { worldX: 3253, worldZ: 3402 }, nearbyNpcs: [], nearbyLocs: [], inventory: [] }, { x: 3253, z: 3402 }, true, true);
    expect(actions[0]?.id).toBe('rune-learning-scan');
  });

  test('uses an observed mine option', () => {
    const actions = runeDiscoveryCandidates({ player: { worldX: 3253, worldZ: 3402 }, nearbyNpcs: [], nearbyLocs: [{ id: 77, name: 'Rune essence', x: 3254, z: 3402, reachable: true, optionsWithIndex: [{ text: 'Mine', opIndex: 2 }] }], inventory: [] }, { x: 3253, z: 3402 }, true, true);
    expect(actions[0]?.type).toBe('interactLoc');
    expect(actions[0]?.fields?.optionIndex).toBe(2);
  });

  test('only targets guide-listed local monsters and picks up verified drops', () => {
    const target = dropLearningCandidates({ player: { combatLevel: 20 }, nearbyNpcs: [{ index: 3, name: 'Imp', combatLevel: 2, reachable: true, inCombat: false, optionsWithIndex: [{ text: 'Attack', opIndex: 1 }] }] }, 'ranged-magic',true);
    expect(target[0]?.fields?.npcIndex).toBe(3);
    const pickup = dropLearningCandidates({ player:{worldX:1,worldZ:1},groundItems: [{ id: 99, name: 'Iron arrow', x: 1, z: 2, reachable: true }] }, 'ranged-magic');
    expect(pickup[0]?.type).toBe('pickupItem');
  });

  test('ordinary training never emits an imp attack merely because one is visible',()=>{
    const s={player:{worldX:3230,worldZ:3500,combatLevel:51},nearbyNpcs:[{index:5,name:'Imp',combatLevel:2,reachable:true,inCombat:false,optionsWithIndex:[{text:'Attack',opIndex:2}]}]};
    expect(dropLearningCandidates(s,'ranged-magic')).toEqual([]);
    expect(dropLearningCandidates(s,'ranged-magic',true)[0]?.fields?.npcIndex).toBe(5);
  });
  test('drop pickups do not pull a training trip across the scene',()=>{
    const s={player:{worldX:3235,worldZ:3560},groundItems:[{id:559,name:'Body rune',x:3229,z:3566,reachable:true}]};
    expect(dropLearningCandidates(s,'ranged-magic')).toEqual([]);
    s.groundItems[0]!.x=3235;s.groundItems[0]!.z=3561;
    expect(dropLearningCandidates(s,'ranged-magic')[0]?.type).toBe('pickupItem');
  });

  test('records newly observed rune or arrow inventory', () => {
    const memory: Record<string, unknown> = {};
    recordObservedDrops(memory, { inventory: [{ name: 'Iron arrow', count: 2 }] }, { inventory: [{ name: 'Iron arrow', count: 7 }] });
    expect((memory.observedDrops as Record<string, number>)['Iron arrow']).toBe(5);
  });
});
