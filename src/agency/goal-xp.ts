/** Server-specific facts in an overlay; generic planner remains item and location agnostic. */
import { SOURCE_XP_DATA } from './goal-xp-data.ts';
import type { Method, Observation } from './types.ts';
import type { LiveState } from './world-model.ts';
import type { SourceRecipe, SourceCatalogue } from '../catalog/source-catalogue.ts';
import type { SourceSettings } from './source-methods.ts';
import type { PlanningContext } from './goal-planner.ts';

export type PreparationOptions={xpRate?:number; profileId:string};
const normalize=(s:string)=>s.toLowerCase()==='runecrafting'?'runecraft':s.toLowerCase();
const xpRows=SOURCE_XP_DATA.recipes as Record<string,{skill:string;rawXpTenths:number;notes:string}>;
export function recipeTrainingSkill(recipe:SourceRecipe):string|undefined{return xpRows[recipe.id]?.skill;}
export function recipeXp(method:Method,recipe:SourceRecipe,batch:number,options:PreparationOptions):void {
  if(options.profileId!==SOURCE_XP_DATA.profileId||options.xpRate===undefined)return;
  const entry=xpRows[recipe.id];if(!entry)return;
  // Client packets round down cumulative tenths; floor each forecast action is a conservative bound.
  const xp=Math.floor(entry.rawXpTenths*batch*options.xpRate/10);if(!Number.isSafeInteger(xp)||xp<=0)return;
  method.effects['xp:'+entry.skill]=xp;
  method.training={profileId:options.profileId,xp:{[entry.skill]:xp},maximumXp:{[entry.skill]:Math.ceil(entry.rawXpTenths*batch*options.xpRate/10*(recipe.id==='recipe:smelt:gold_bar'?2.5:1))},evidence:[...recipe.provenance,'xp-overlay:'+recipe.id,
    'operator-confirmed-xp-rate:'+options.xpRate,'client-XP-floor-lower-bound']};
}
const levelForXp=(xp:number)=>Object.entries(SOURCE_XP_DATA.thresholds).filter(([,threshold])=>xp>=threshold).reduce((n,[level])=>Math.max(n,Number(level)),1);
export function preparationContext(source:SourceCatalogue,state:LiveState,view:Observation,options:PreparationOptions):PlanningContext {
  const ctx:PlanningContext={version:1,profileId:source.data.profile.id,skillModels:{},aliases:{},maxExpansions:1024,maxSteps:96,beamWidth:3};
  if(source.data.profile.id!==SOURCE_XP_DATA.profileId)return ctx;
  for(const row of state.skills??[]){
    const skill=normalize(String(row.name??'')),xp=Number(row.experience??row.xp),base=Number(row.baseLevel??row.level),current=Number(row.currentLevel??row.level??row.baseLevel);
    if(row.currentLevel!==undefined&&row.level!==undefined&&Number(row.currentLevel)!==Number(row.level))continue;
    if(!Number.isSafeInteger(xp)||xp<0||!Number.isSafeInteger(base)||base<1||base>99||current!==base||levelForXp(xp)!==base)continue;
    view.facts['xp:'+skill]=xp;view.facts['level:'+skill]=base;
    ctx.skillModels[skill]={thresholds:{...SOURCE_XP_DATA.thresholds},confirmed:options.xpRate!==undefined,
      evidence:['source-profile:'+source.data.profile.id,'own-skill-snapshot:'+state.tick,'source-XP-thresholds',...(options.xpRate!==undefined?['operator-confirmed-xp-rate:'+options.xpRate]:[])]};
  }
  const byName=new Map<string,string[]>();
  for(const item of source.data.items){const physical='carried:'+item.id;if(!Object.hasOwn(view.facts,physical))continue;
    const key='carried:name:'+item.name.trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');const names=byName.get(key)??[];names.push(physical);byName.set(key,names);
  }
  for(const [alias,components] of byName)ctx.aliases![alias]=components;
  return ctx;
}
export { SOURCE_XP_DATA };
