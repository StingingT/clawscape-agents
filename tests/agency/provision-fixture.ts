import { writeFileSync } from 'node:fs';
import { createMemory } from '../../src/agency/director.ts';
import { emptyKnowledge } from '../../src/agency/world-model.ts';
import { tripKey } from '../../src/agency/trip-logistics.ts';
import type { Identity } from '../../src/agency/types.ts';
/** These tests exercise journal/funding mechanics with an explicitly measured food need.
 * The live default no longer supplies a universal eight-meal objective. */
export function seedProvisionHistory(file:string,identity:Identity,state:any,foodUsed=8,preferences={}):void {
  writeFileSync(file,JSON.stringify({version:2,memory:createMemory(identity,preferences),knowledge:emptyKnowledge(),lastCommands:[],
    trips:{samples:['exploration','gathering','production','combat'].map(activity=>({key:tripKey(state,activity),at:1,
      foodUsed,seconds:600,damage:0,escaped:false,died:false,returned:true,peakUsedSlots:25,capacity:28}))}}));
}
