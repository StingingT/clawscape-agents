/** Guide-derived hypotheses, NOT the private server's mechanics or executable instructions.
 * Research details and retrieval limitations: docs/RESEARCHED_BUILDS_SPEC.md. */
export const GUIDE_DATE = '2026-09-14';
export const BUILD_SOURCES = {
  rangedMagic: 'https://oldschool.runescape.wiki/w/Ranged-magic_hybrid_%28free-to-play%29',
  melee: 'https://oldschool.runescape.wiki/w/Melee_pure_%28free-to-play%29',
  hybrid: 'https://oldschool.runescape.wiki/w/Free-to-play_combat_pure_guide',
  dragon: 'https://oldschool.runescape.wiki/w/One-defence_pure',
  quests: 'https://oldschool.runescape.wiki/w/One-defence_pure/Quests',
  protection: 'https://oldschool.runescape.wiki/w/Protect_from_Melee',
} as const;
export type GuideBuildId = 'ranged-magic-pure' | 'rune-melee-pure' | 'ranged-melee-pure' | 'dragon-weapon-pure';
export type BuildGuide = {
  id: GuideBuildId; name: string; sourceIds: Array<keyof typeof BUILD_SOURCES>;
  defenceCap: 1; attackCap?: number; focus: string[]; frozen: string[];
  requiredFeatures: string[]; trainingLeadIds: string[]; rationale: string; limitations: string[];
};
const early = ['lumbridge-chickens','lumbridge-cows','lumbridge-goblins','village-barbarians'];
export const BUILD_GUIDES: readonly BuildGuide[] = [
  {id:'ranged-magic-pure',name:'Ranged/Magic one-Defence hybrid',sourceIds:['rangedMagic'],defenceCap:1,
    focus:['ranged','magic'],frozen:['attack','strength','defence'],requiredFeatures:[],
    trainingLeadIds:[...early,'hill-giants','moss-giants'],
    rationale:'Compare available ranged and spell methods while retaining one Defence and low melee investment.',
    limitations:['Spell execution must be supported separately.','Prayer is a separate capped decision.','PvM results do not establish PvP competence.']},
  {id:'rune-melee-pure',name:'Rune-weapon melee pure',sourceIds:['melee'],defenceCap:1,attackCap:40,
    focus:['attack','strength'],frozen:['defence','ranged','magic'],requiredFeatures:[],
    trainingLeadIds:[...early,'monastery-monks'],
    rationale:'Develop Attack through validated weapon unlocks toward 40 and compare Strength-focused methods with one Defence.',
    limitations:['40 Attack is a guide milestone; validate actual item requirements.','Capped XP training needs a server-scoped effect bound.']},
  {id:'ranged-melee-pure',name:'Ranged/melee one-Defence hybrid',sourceIds:['hybrid'],defenceCap:1,attackCap:40,
    focus:['attack','strength','ranged'],frozen:['defence','magic'],requiredFeatures:[],
    trainingLeadIds:[...early,'hill-giants'],
    rationale:'Compare bow training with rune-weapon melee while preserving one Defence.',
    limitations:['Possessing both weapons does not implement combat switching.','Validate access and positioning before any safespot trial.']},
  {id:'dragon-weapon-pure',name:'60-Attack dragon-weapon one-Defence hybrid',sourceIds:['dragon','quests'],defenceCap:1,attackCap:60,
    focus:['attack','strength','ranged','magic'],frozen:['defence'],
    requiredFeatures:['dragon-weapon-requirements','lost-city-access','dragon-weapon-executor'],
    trainingLeadIds:[...early,'rock-crabs','hill-giants'],
    rationale:'Investigate a supported dragon dagger/longsword progression after verifying equipment and quest access.',
    limitations:['No assumed dragon scimitar or special attacks.','Content, personal access and executable actions are separate gates.']},
];
export const PRAYER_CHOICES = [1,13,31,43] as const;
export const EXCLUDED_DEFAULTS = [
  'Modern Strength-requirement warhammers: changed in 2021; not assumed for this server.',
  'Eagle Eye/Mystic Might: post-2004; not included without separate compatibility evidence.',
  'Granite maul, obsidian, Void, godswords and modern training locations: research only, not executable defaults.',
];
export const buildGuide = (id: string): BuildGuide | undefined => BUILD_GUIDES.find(g=>g.id===id);
