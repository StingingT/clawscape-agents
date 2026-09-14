import { TRAINING_LEADS } from '../training/guide-leads.ts';
import { motivatedPureTrial } from './ambitions.ts';
import type { Memory, Observation } from './types.ts';
import type { LiveState } from './world-model.ts';
import { BUILD_GUIDES, BUILD_SOURCES, GUIDE_DATE, PRAYER_CHOICES, buildGuide, type GuideBuildId } from './build-guides.ts';
import { hasBuildFeature, type BuildRules } from './build-rules.ts';

export type BuildId = 'open-development' | 'legacy-restricted' | 'strength-prayer-pure' | GuideBuildId;
export type Development = {
  version: 1 | 2; id: BuildId; chosenAt:number; focus:string[];
  /** XP frozen at a deliberately chosen boundary, never reset after an accidental gain. */
  protectedXp:Record<string,number>; reason:string; evidence:string[];
  history:Array<{at:number;from:BuildId;to:BuildId;reason:string;evidence:string[]}>;
  name?:string; sourceUrls?:string[]; researchedAt?:string; levelCaps?:Record<string,number>;
  milestones?:Record<string,number[]>; trainingLeadIds?:string[]; rulesSource?:string;
  alternatives?:Array<{id:string;score:number;eligible:boolean;reason:string}>;
  review?:{at:number;reason:string;evidence:string[];alternatives:string[]};
};
const skills=(s:LiveState)=>Object.fromEntries((s.skills??[]).map((k:any)=>[String(k.name).toLowerCase(),
  {level:Number(k.baseLevel??k.level),xp:Number(k.experience??k.xp)}]));
const availableSkills=(s:LiveState):string[]=>[...new Set<string>((s.combatStyle?.styles??[])
  .flatMap((r:any)=>r.trainsSkills??[]).map((k:any)=>String(k).toLowerCase()))];
const own=(s:LiveState)=>`own-build-observation:${s.player?.lifeId}:${s.tick}`;
const knownStat=(v:any)=>v&&Number.isFinite(v.xp)&&v.xp>=0&&Number.isInteger(v.level)&&v.level>=1;
const profileXpBlocked=(m:Memory,frozen:string[])=>m.active&&frozen.some(k=>m.active!.target.fact==='xp:'+k);

/** Prayer is selected separately. No unbounded Bury loop and no imported 2006 prayers. */
function prayerChoice(s:LiveState,rules?:BuildRules):number|undefined {
  const p=skills(s).prayer;
  if(!knownStat(p))return;
  const possible=PRAYER_CHOICES.filter(n=>n>=p.level);
  return possible.find(n=>n===p.level || hasBuildFeature(rules,`prayer-milestone:${n}`)
    && hasBuildFeature(rules,'prayer-executor') && !!rules?.xpThresholds.prayer?.[n+1]);
}

/** Compare guide hypotheses against own irreversible state, not a prescribed character name. */
export function chooseDevelopment(state:LiveState,memory:Memory,now:number,hint?:string,rules?:BuildRules):Development {
  const known=skills(state),can=availableSkills(state),prayer=prayerChoice(state,rules);
  const interest=motivatedPureTrial(memory); // A temporary combat dependency is not a build motive.
  const names=[...(state.inventory??[]),...(state.equipment??[])].map((i:any)=>String(i.name));
  const bow=names.some(n=>/bow/i.test(n)),melee=names.some(n=>/sword|scimitar|dagger|mace/i.test(n));
  const alternatives:NonNullable<Development['alternatives']>=BUILD_GUIDES.map(g=>{
    const frozen=g.frozen;
    let reason='Compatible observed starting state; remaining unlocks are hypotheses.';
    let eligible=interest && state.inGame!==false && state.player?.combat?.inCombat!==true && knownStat(known.defence) && known.defence.level===1 && prayer!==undefined
      && frozen.every(k=>knownStat(known[k])) && !profileXpBlocked(memory,[...frozen,...(prayer===1?['prayer']:[])])
      && (!g.attackCap || knownStat(known.attack)&&known.attack.level<=g.attackCap)
      && g.requiredFeatures.every(f=>hasBuildFeature(rules,f));
    const match=can.filter(k=>g.focus.includes(k));
    eligible=eligible&&match.length>0;
    if(g.id==='ranged-magic-pure' && !can.some(k=>['ranged','magic'].includes(k)))eligible=false;
    if(g.id==='rune-melee-pure' && !can.some(k=>['attack','strength'].includes(k)))eligible=false;
    if(g.id==='ranged-melee-pure' && !(bow&&melee))eligible=false;
    if(g.id==='dragon-weapon-pure' && !names.some(n=>/dragon (dagger|longsword)/i.test(n)))eligible=false;
    let score=match.length + (g.id==='ranged-melee-pure'&&bow&&melee?2:0);
    if(hint==='ranged-magic' && g.id==='ranged-magic-pure')score+=.25;
    if(hint==='melee' && g.id==='rune-melee-pure')score+=.25;
    if(g.id==='dragon-weapon-pure')score+=.5;
    if(!eligible)reason=!interest ? 'No deliberate, evidence-backed restricted-build experiment; ordinary training and support combat do not imply a pure.' : 'Incompatible XP/Prayer state, unavailable observed style/equipment, or unverified required content/access.';
    return {id:g.id,score,eligible,reason};
  });
  alternatives.push({id:'open-development',score:interest ? .5 : 4,eligible:true,reason:'Unrestricted combat development preserves every skill option and supports the personal ambition without pure caps.'});
  const best=alternatives.filter(a=>a.eligible).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id))[0];
  if(!best || best.id==='open-development')return {version:2,id:'open-development',name:'Unrestricted combat development',chosenAt:now,focus:can,protectedXp:{},history:[],
    reason:memory.ambition ? `Support ${memory.ambition.name.toLowerCase()} without imposing combat skill caps; a pure needs its own evidence-backed purpose.` : 'Develop useful skills without restrictions; pure templates do not outrank unrestricted progression just because they are compatible.',
    evidence:[own(state)],alternatives,sourceUrls:[...new Set(TRAINING_LEADS.map(l=>l.source))],trainingLeadIds:TRAINING_LEADS.map(l=>l.id)};
  const g=buildGuide(best.id)!;
  const caps:Record<string,number>={defence:1,prayer:prayer!};
  if(g.attackCap)caps.attack=g.attackCap;
  const frozen=[...g.frozen,...(prayer===known.prayer.level?['prayer']:[]),...(g.attackCap===known.attack?.level?['attack']:[])];
  return {version:2,id:g.id,name:g.name,chosenAt:now,focus:[...g.focus,...(prayer!>known.prayer.level?['prayer']:[])],
    protectedXp:Object.fromEntries([...new Set(frozen)].map(k=>[k,known[k].xp])),levelCaps:caps,
    milestones:{...(g.attackCap?{attack:[5,10,20,30,40,60].filter(n=>n<=g.attackCap!)}:{}),prayer:[prayer!]},
    researchedAt:GUIDE_DATE,sourceUrls:g.sourceIds.map(id=>BUILD_SOURCES[id]),trainingLeadIds:[...g.trainingLeadIds],
    reason:`Test ${g.name}: ${g.rationale} Selected from observed skills/equipment; guide advice is not verified server behavior. Prayer ceiling: ${prayer}.`,
    evidence:[own(state),`observed-training-options:${can.join(',')}`,...(memory.ambition?.evidence??[])],history:[],alternatives,rulesSource:rules?.source};
}

/** Existing saves retain their restrictions and history; a rename cannot authorize extra XP. */
export function migrateDevelopment(d:Development,state:LiveState,now:number):Development {
  if(d.version===2)return d;
  const g=buildGuide(d.id),known=skills(state);
  const id:BuildId=d.id==='open-development'?'open-development':d.id==='ranged-magic-pure'&&known.defence?.level===1?'ranged-magic-pure':'legacy-restricted';
  const reason='Versioned guide migration; retained all previous protected XP. Legacy restrictions are not silently converted to a different build.';
  return {...d,version:2,id,name:id==='legacy-restricted'?'Preserved legacy specialization':g?.name??'Open development',
    protectedXp:{...d.protectedXp,...(id!=='open-development'&&knownStat(known.prayer)?{prayer:Math.min(d.protectedXp.prayer??Infinity,known.prayer.xp)}:{})},
    levelCaps:id==='open-development'?{}:{defence:known.defence?.level??1,prayer:known.prayer?.level??1},
    sourceUrls:g?.sourceIds.map(s=>BUILD_SOURCES[s])??[],researchedAt:GUIDE_DATE,trainingLeadIds:g?.trainingLeadIds??[],
    history:[...d.history,{at:now,from:d.id,to:id,reason,evidence:[own(state)]}],reason};
}

/** Losses motivate reversible method investigations, not automatic irreversible Defence gains. */
export function reviewDevelopment(current:Development,state:LiveState,memory:Memory,now:number,rules?:BuildRules):Development {
  if(memory.pending || memory.active)return current;
  let d=migrateDevelopment(current,state,now),known=skills(state);
  if(d.id==='open-development') {
    const candidate=chooseDevelopment(state,memory,now,undefined,rules);
    if(candidate.id==='open-development')return {...candidate,chosenAt:d.chosenAt,history:d.history,protectedXp:d.protectedXp,levelCaps:d.levelCaps};
    return {...candidate,history:[...d.history,{at:now,from:d.id,to:candidate.id,
      reason:'A recorded comparative-build ambition and compatible own evidence justify this trial before starting another goal.',evidence:candidate.evidence}].slice(-32)};
  }
  for(const [k,cap] of Object.entries(d.levelCaps??{}))if(knownStat(known[k])&&known[k].level>=cap&&!Object.hasOwn(d.protectedXp,k))
    d={...d,protectedXp:{...d.protectedXp,[k]:known[k].xp},evidence:[...d.evidence,`milestone-review:${k}:${cap}:${own(state)}`]};
  const trials=memory.reviews.filter(r=>r.at>=d.chosenAt&&r.goal.strategyId===d.id&&r.goal.domain==='combat'&&r.evidence.length>0&&(r.goal.deaths>0||r.goal.lostGp>0));
  if(trials.length && (!d.review || d.review.at<trials.at(-1)!.at))d={...d,review:{at:now,
    reason:'Compare safer training sites, supplies, equipment and positioning within current caps before proposing an irreversible build change.',
    evidence:trials.slice(-5).map(r=>`attributed-trial:${r.at}:${r.goal.id}`),
    alternatives:['test a safer locally supported site','prepare better affordable supplies','investigate equipment/positioning','retain protected XP while evidence is incomplete']}};
  return d;
}
export function strategyView(d:Development|undefined):Observation['strategy'] {
  return d&&{id:d.id,protectedSkills:Object.keys(d.protectedXp)};
}
export function allowedTraining(d:Development|undefined,trained:string[],state?:LiveState):boolean {
  const observed=state?skills(state):{};
  return trained.length>0&&trained.every(k=>{
    k=k.toLowerCase();return !Object.hasOwn(d?.protectedXp??{},k)
      && (!state || d?.levelCaps?.[k]===undefined || knownStat(observed[k])&&observed[k].level<d.levelCaps[k]!);
  });
}
export function protectedXpChanged(d:Development|undefined,state:LiveState):boolean {
  const observed=skills(state);
  return Object.entries(d?.protectedXp??{}).some(([k,max])=>!Number.isFinite(observed[k]?.xp)||observed[k].xp>max)
    || Object.entries(d?.levelCaps??{}).some(([k,max])=>!knownStat(observed[k])||observed[k].level>max);
}
/** Minimum XP for the next guide review point; absent verified curve means no capped-XP trial. */
export function guideTrainingTarget(d:Development|undefined,state:LiveState,skill:string,rules?:BuildRules):number|undefined {
  if(!allowedTraining(d,[skill],state))return;
  const row=skills(state)[skill];if(!knownStat(row))return;
  const cap=d?.levelCaps?.[skill];
  if(cap===undefined)return Math.floor(row.xp/100)*100+100;
  const levels=rules?.xpThresholds[skill];
  if(!levels || !Number.isFinite(levels[cap+1]) || row.xp<levels[row.level]! || row.xp>=levels[row.level+1]!)return;
  const milestone=d?.milestones?.[skill]?.find(n=>n>row.level)??cap;
  return Math.min(Math.floor(row.xp/100)*100+100,levels[milestone]!);
}
function effectKey(state:LiveState,action:{type:string;fields?:Record<string,any>}):string|undefined {
  const f=action.fields??{}, id=(v:any)=>Number.isInteger(v)&&v>=0;
  if(action.type==='interactNpc') {
    const npc=(state.nearbyNpcs??[]).find((n:any)=>n.index===f.npcIndex),style=state.combatStyle;
    if(id(npc?.id)&&typeof style?.weaponName==='string'&&style.weaponName&&!/[:\r\n]/.test(style.weaponName)&&id(style.currentStyle))
      return `attack:${npc.id}:${style.weaponName}:${style.currentStyle}`;
  }
  if(action.type==='useInventoryItem') {
    const item=(state.inventory??[]).find((i:any)=>i.slot===f.slot);if(id(item?.id))return `bury:${item.id}`;
  }
  if(action.type==='clickDialogOption'&&id(state.dialog?.id)&&id(f.optionIndex))return `dialogue:${state.dialog.id}:${f.optionIndex}`;
  if(action.type==='castSpell'&&id(f.spellId))return `spell:${f.spellId}`;
}
/** Check the entire XP effect, including automatic/delayed repetitions, before dispatch. */
export function guardDevelopment(d:Development|undefined,state:LiveState,
  action:{type:string;fields?:Record<string,any>},intendedSkill?:string,rules?:BuildRules):void {
  if(!d)return;
  const f=action.fields??{},npc=(state.nearbyNpcs??[]).find((n:any)=>n.index===f.npcIndex);
  const option=npc?.optionsWithIndex?.find((o:any)=>o.opIndex===f.optionIndex)?.text;
  const attack=action.type==='interactNpc'&&/^attack$/i.test(String(option)),styleChange=action.type==='setCombatStyle';
  const item=(state.inventory??[]).find((i:any)=>i.slot===f.slot);
  const bury=action.type==='useInventoryItem'&&(item?.optionsWithIndex??[]).some((o:any)=>o.opIndex===f.optionIndex&&/^bury$/i.test(String(o.text)));
  const reward=action.type==='clickDialogOption'||action.type==='castSpell';
  if(!attack&&!styleChange&&!bury&&!reward)return;
  if(protectedXpChanged(d,state))throw new Error('PURE_BUILD_XP_BOUNDARY_CHANGED');
  const index=styleChange?f.style:state.combatStyle?.currentStyle;
  const style=(state.combatStyle?.styles??[]).find((s:any)=>s.index===index);
  const trained:string[]=bury?['prayer']:(attack||styleChange)?(style?.trainsSkills??[]).map((k:any)=>String(k).toLowerCase()):[];
  const contract=rules?.effects[effectKey(state,action)??''];
  if(reward) {
    if(d.id==='open-development')return;
    if(!contract)throw new Error('BUILD_REWARD_XP_CONTRACT_REQUIRED');
    trained.push(...Object.keys(contract.maximumXp).filter(k=>contract.maximumXp[k]!>0));
  }
  if(!reward&&!allowedTraining(d,trained,state))throw new Error('BUILD_STRATEGY_DISALLOWS_OR_CANNOT_VERIFY_STYLE_XP');
  if(intendedSkill&&(attack||styleChange||bury)&&!trained.includes(intendedSkill.toLowerCase()))throw new Error('STYLE_DOES_NOT_TRAIN_SELECTED_GOAL');
  if(styleChange&&state.player?.combat?.inCombat!==true)return; // no XP on an idle style selection
  const observed=skills(state),effects=contract?.maximumXp??{};
  const restricted=trained.some(k=>d.levelCaps?.[k]!==undefined)||reward;
  if(restricted && d.id!=='open-development' && !contract)throw new Error('BUILD_CAPPED_ACTION_XP_BOUND_REQUIRED');
  for(const k of new Set([...trained,...Object.keys(effects)])) {
    const delta=effects[k];
    if(Object.hasOwn(d.protectedXp,k)&&((delta??(trained.includes(k)?Infinity:0))>0))throw new Error('BUILD_STRATEGY_DISALLOWS_REWARD_XP');
    const cap=d.levelCaps?.[k];
    if(cap!==undefined&&((delta??(trained.includes(k)?Infinity:0))>0)) {
      const ceiling=rules?.xpThresholds[k]?.[cap+1];
      if(!Number.isFinite(delta)||!Number.isFinite(ceiling)||!knownStat(observed[k])||observed[k].xp+delta!>=ceiling!)
        throw new Error('BUILD_XP_CAP_WOULD_BE_EXCEEDED_OR_UNKNOWN');
    }
  }
}

/** Report why an advertised build component is still only a research lead. */
export function developmentReadiness(d:Development|undefined,state:LiveState,rules?:BuildRules) {
  return {rulesSource:rules?.source??null,combatLevelCost:'unknown; server formula not supplied',
    cappedTraining:Object.entries(d?.levelCaps??{}).map(([skill,cap])=>({skill,cap,
      state:Object.hasOwn(d?.protectedXp??{},skill)?'protected-at-current-xp':guideTrainingTarget(d,state,skill,rules)===undefined?'matching-server-xp-rules-required':'curve-available; action-specific-bound-still-required'}))};
}
