/** Runtime bridge for the planning skill. Shadow diagnostics do not mutate goal memory. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzePlan } from './director.ts';
import { GOAL_PLANNING_VERSION, type PlanningBlocker } from './goal-planner.ts';
import { preparationContext, SOURCE_XP_DATA } from './goal-xp.ts';
import { applyIntentPolicy, intentionReviewSafe } from './goal-intents.ts';
import { buildSourceMethods, compatibleSourceArrows, sourceCount, sourceFlags, type SourceSettings } from './source-methods.ts';
import type { SourceCatalogue } from '../catalog/source-catalogue.ts';
import type { Catalogue, Knowledge, LiveState, Policy } from './world-model.ts';
import type { AcquisitionMemory } from './acquisition.ts';
import type { Memory, Opportunity } from './types.ts';
export const GOAL_SETTINGS_PATH='data/catalog/goal-planning.json';
export type GoalPlanningSettings={version:1;mode:'shadow'|'pilot';intentMode?:'shadow'|'enforce';xpRate?:number;confirmedProfileId?:string};
export function readGoalSettings(root:string):GoalPlanningSettings|undefined {
  const file=resolve(root,GOAL_SETTINGS_PATH);if(!existsSync(file))return;
  const cfg=JSON.parse(readFileSync(file,'utf8')) as GoalPlanningSettings;
  if(cfg.version!==1||!['shadow','pilot'].includes(cfg.mode)||cfg.intentMode!==undefined&&!['shadow','enforce'].includes(cfg.intentMode)||cfg.xpRate!==undefined&&(!Number.isSafeInteger(cfg.xpRate)||cfg.xpRate<1||cfg.xpRate>1000)
    ||cfg.confirmedProfileId!==undefined&&typeof cfg.confirmedProfileId!=='string')throw new Error('INVALID_GOAL_PLANNING_SETTINGS');
  if(cfg.mode==='pilot'&&(cfg.xpRate===undefined||!cfg.confirmedProfileId))throw new Error('GOAL_PILOT_REQUIRES_CONFIRMED_PROFILE_AND_XP_RATE');
  return cfg;
}
export function classifyBlocker(id:string,reason:string,state:LiveState,cfg:SourceSettings):PlanningBlocker {
  if(/executor not integrated|adapter is not enabled|not dispatched|ordering\/UI|interface adapter|production interface|conditional consumption|stochastic smelting/.test(reason))
    return {kind:'implementation-gap',methodId:id,reason};
  if(reason.includes('world.members'))return {kind:sourceFlags(state,cfg)['world.members']===false?'prohibited':'needs-information',methodId:id,reason};
  if(/^Missing (?:carried|bank) item:/.test(reason))return {kind:'needs-resource',methodId:id,reason};
  const level=/^(\w+) requires (\d+), observed (\d+)/.exec(reason);
  if(level)return {kind:'needs-training',methodId:id,fact:'level:'+level[1],reason};
  if(/unknown|Unknown|Unverified|unresolved|Unmapped|not currently observed|no matching resource placement|must first be personally observed|must first|not observed/.test(reason))
    return {kind:'needs-information',methodId:id,reason};
  return {kind:'unavailable',methodId:id,reason};
}
const copyCatalogue=(c:Catalogue):Catalogue=>({...c,view:{...c.view,facts:{...c.view.facts},capabilities:[...c.view.capabilities]},
  methods:c.methods.map(m=>structuredClone(m)),opportunities:structuredClone(c.opportunities),tasks:new Map(c.tasks)});
export function buildGoalReadiness(source:SourceCatalogue,base:Catalogue,state:LiveState,k:Knowledge,acquisition:AcquisitionMemory|undefined,
  policy:Policy,memory:Memory,sourceSettings:SourceSettings,settings:GoalPlanningSettings,now:number,sourceGate:boolean){
  const c=copyCatalogue(base),confirmed=settings.confirmedProfileId===source.data.profile.id&&settings.xpRate!==undefined;
  const preparation={profileId:source.data.profile.id,xpRate:confirmed?settings.xpRate:undefined};
  const sourceReport=buildSourceMethods(source,c,state,k,acquisition,policy,memory,sourceSettings,now,preparation);
  c.view.goalPlanning=preparationContext(source,state,c.view,preparation);
  const aliases=c.view.goalPlanning.aliases!,arrowIds=compatibleSourceArrows(source,state);
  if(arrowIds.length){aliases.arrows=[];for(const id of arrowIds){
    c.view.facts['carried:'+id]=sourceCount(state.inventory,id);c.view.facts['equipped:'+id]=sourceCount(state.equipment,id);
    aliases.arrows.push('carried:'+id,'equipped:'+id);
  }}
  if(Object.hasOwn(c.view.facts,'carried:995'))aliases.coins=['carried:995'];
  // Audit candidates separately. New action planning and live intention filtering have independent controls.
  const audit=copyCatalogue(c),retired=applyIntentPolicy(audit,k,memory,now);
  const intentEnabled=settings.intentMode==='enforce';
  if(intentEnabled){applyIntentPolicy(c,k,memory,now);c.intentPolicyEnabled=true;}
  const selected:Opportunity[]=[];
  if(memory.active&&!retired.includes(memory.active.id))selected.push(memory.active);
  selected.push(...c.opportunities.filter(g=>g.id.startsWith('source-')),...c.opportunities);
  const seen=new Set<string>();const goals=selected.filter(g=>{if(seen.has(g.id))return false;seen.add(g.id);return true;}).slice(0,6);
  const forecasts=goals.map(goal=>{
    const remaining=memory.active?.id===goal.id?{...c.view,budget:{
      spendableGp:Math.min(c.view.budget.spendableGp,Math.max(0,memory.active.budget.spendableGp-memory.active.spentGp)),
      maxLossGp:Math.min(c.view.budget.maxLossGp,Math.max(0,memory.active.budget.maxLossGp-memory.active.lostGp)),
      maxDeaths:Math.min(c.view.budget.maxDeaths,Math.max(0,memory.active.budget.maxDeaths-memory.active.deaths)),
      maxDurationMs:Math.min(c.view.budget.maxDurationMs,Math.max(0,memory.active.budget.maxDurationMs-(now-memory.active.startedAt)))}}:c.view;
    const result=analyzePlan(memory,remaining,goal,c.methods);
    return {...result.trace,next:result.plan?.steps[0],subgoals:result.plan?.steps[0]?.lineage??[],
      budget:remaining.budget,parentPurpose:goal.reason,evidence:goal.evidence};
  });
  const enabled=settings.mode==='pilot'&&sourceGate&&confirmed;
  const report={version:GOAL_PLANNING_VERSION,agent:memory.agent,at:now,tick:state.tick,profileId:source.data.profile.id,
    mode:settings.mode,enabled,
    intentionPolicy:{mode:settings.intentMode??'shadow',enabled:intentEnabled,
      observationEligible:intentEnabled&&intentionReviewSafe(state),directorPending:!!memory.pending,
      retirementRequires:'Living, out-of-combat own observation and no task/safety receipt or Director pending command.',
      scope:'Unjustified legacy seed intentions only; no location blacklist, no new action authorization.'},
    forecastIsNotDispatch:true,
    observation:{tick:state.tick,inGame:state.inGame===true,world:state.world??null,
      position:state.player?{x:state.player.worldX,z:state.player.worldZ,level:state.player.level}:null,
      health:state.player?{hp:state.player.hp,maxHp:state.player.maxHp,inCombat:state.player.combat?.inCombat===true}:null,
      members:typeof sourceFlags(state,sourceSettings)['world.members']==='boolean'?sourceFlags(state,sourceSettings)['world.members']:null,
      skills:(state.skills??[]).map((s:any)=>({name:s.name,baseLevel:s.baseLevel??s.level,currentLevel:s.currentLevel??s.level,experience:s.experience??s.xp})),
      inventorySlots:Array.isArray(state.inventory)?state.inventory.length:null},
    methodCounts:{legacy:base.methods.length,source:sourceReport.registeredMethods,total:c.methods.length,
      numericTraining:c.methods.filter(m=>m.training).length},
    reason:enabled?'Bounded source pilot and prerequisite policy both enabled; every next leaf still requires fresh executor checks.':
      intentEnabled?'Enhanced action planning is not active. Independent intention review filters unjustified seed goals; it authorizes no new source/training action.':
      'Shadow evaluation only. Neither goal intentions nor new actions are changed by this report.',
    xp:{confirmedRate:confirmed?settings.xpRate:null,sourceDefaultRate:SOURCE_XP_DATA.sourceDefaultXpRate,
      sourceDefaultIsNotLiveConfirmation:true,compatibleObservedSkills:Object.keys(c.view.goalPlanning.skillModels),
      note:'Integer client XP. Per-action forecasts round down; boosted/drained or inconsistent XP/level observations cannot create a training forecast.'},
    needs:sourceReport.needs,registeredMethods:sourceReport.registeredMethods,trainingMethods:c.methods.filter(m=>m.training).length,
    retiredIntentCandidates:retired,archivedIntentions:memory.intentPolicy?.archived??[],forecasts,
    requirementAlternatives:sourceReport.requirementAlternatives??[],
    sourceBlockers:sourceReport.blockers.map(b=>classifyBlocker(b.id,b.reason,state,sourceSettings)),
    searchCoverage:sourceReport.truncated?'partial: dependency/training limits reached':'bounded catalogue subset',
    limitations:['No new remote-shop, anvil, loot-farming or party executor is supplied in this patch.',
      'A missing executor remains an implementation gap even if the character could train the required skill.',
      'Astra uses a separate executor and is not integrated.'],
    skillDocument:'skills/goal-prerequisite-planning/SKILL.md'};
  return {catalogue:c,report,enabled};
}
