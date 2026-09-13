// Source/map and observed encounter hints for the non-combat quest runner.
// They are not a complete world danger model. Live threat interrupts still win.
export const QUEST_DANGER_ZONES = [
  {name:'eastern swamp bear',minX:3158,maxX:3194,minZ:3205,maxZ:3241},
  {name:'western swamp bear',minX:3141,maxX:3177,minZ:3215,maxZ:3251},
  // Young/bearded wizard source spawns, wander 3 + ranged attack/hunt 5.
  {name:'Varrock dark wizards',minX:3213,maxX:3242,minZ:3353,maxZ:3384},
  // Encounter street near source Mugger (3249,3391), not its entire possible
  // roaming range. Approach the rune shop from the north; recheck live threats.
  {name:'Varrock mugger street',minX:3241,maxX:3257,minZ:3383,maxZ:3395},
] as const;
export const inQuestDanger = (t:{x:number,z:number,level:number}) => t.level===0
  && QUEST_DANGER_ZONES.some(h=>t.x>=h.minX&&t.x<=h.maxX&&t.z>=h.minZ&&t.z<=h.maxZ);
