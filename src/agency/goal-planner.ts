/** Bounded alternative search inside the Director. Projections are never observations or commands. */
import { createHash } from 'node:crypto';
import type { Facts, Memory, Method, Observation, Opportunity, Plan, Requirement } from './types.ts';

export const GOAL_PLANNING_VERSION = 'goal-prerequisites-20260922.3';
export type PlanningBlocker = {
  kind:'needs-training'|'needs-resource'|'needs-information'|'implementation-gap'|'prohibited'|'unavailable'|'cycle'|'search-limit'|'budget';
  fact?:string; methodId?:string; reason:string;
};
export type SkillForecast = { thresholds:Record<string,number>; evidence:string[]; confirmed:boolean };
export type PlanningContext = {
  version:1; profileId:string; skillModels:Record<string,SkillForecast>;
  /** Aliases are derived from physical stocks after every simulated action. */
  aliases?:Record<string,string[]>;
  maxExpansions?:number; maxSteps?:number; beamWidth?:number;
  /** Useful inventory outputs need an existing purpose. No invented resale prices. */
  useful?:Record<string,{quantity:number;value:number;evidence:string[]}>;
};
export type ApproachSummary = { id:string; methods:string[]; costGp:number; lossBoundGp:number; durationMs:number;
  score:number; training:Requirement[]; steps:number; };
export type PlanningTrace = { version:string; goalId:string; target:Requirement; status:'ready'|'needs-preparation'|'blocked';
  truncated:boolean; expansions:number; blockers:PlanningBlocker[]; compared:ApproachSummary[];
  selected?:string; optimal:false; notes:string[]; };
export type PlanAnalysis = {plan?:Plan;trace:PlanningTrace};
type SearchState = {facts:Facts;plan:Plan;penalty:number};
const val=(f:Facts,k:string)=>f[k]??0;
const met=(f:Facts,r:Requirement)=>f[r.fact]!==undefined&&f[r.fact]!>=r.minimum;
const finite=(x:number)=>Number.isFinite(x)&&x>=0;
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,20);
const clone=(x:SearchState):SearchState=>({facts:{...x.facts},plan:{...x.plan,steps:x.plan.steps.map(s=>({...s,lineage:s.lineage?.map(x=>({...x}))}))},penalty:x.penalty});
const uniqueReq=(xs:Requirement[]):Requirement[]=>[...xs.reduce((m,r)=>m.set(r.fact,Math.max(m.get(r.fact)??0,r.minimum)),new Map<string,number>())]
  .map(([fact,minimum])=>({fact,minimum}));

/** Upper bounds, not optimistic XP predictions, enforce an explicit level cap. */
export function respectsPlanningCaps(view:Observation,method:Method,facts:Facts=view.facts):boolean {
  if(!view.goalPlanning)return true;
  for(const [skill,cap] of Object.entries(view.strategy?.levelCaps??{})){
    if(!(method.effects['xp:'+skill]>0))continue;
    const next=view.goalPlanning.skillModels[skill]?.thresholds[String(cap+1)];
    const maximum=method.training?.maximumXp?.[skill],xp=facts['xp:'+skill];
    if(cap>=99)continue;
    if(next===undefined||maximum===undefined||xp===undefined||!finite(maximum)||xp+maximum>=next)return false;
  }
  return true;
}

/** Caller passes only the Director's currently permitted/available methods. */
export function searchApproaches(memory:Memory,view:Observation,goal:Opportunity,methods:Method[],scoreMethod:(m:Method)=>number):PlanAnalysis {
  const context=view.goalPlanning!;
  const trace:PlanningTrace={version:GOAL_PLANNING_VERSION,goalId:goal.id,target:{...goal.target},status:'blocked',truncated:false,
    expansions:0,blockers:[],compared:[],optimal:false,notes:['Bounded comparison of registered methods; totals are forecasts, not guaranteed outcomes.']};
  if(!context||context.version!==1)return {trace};
  const maxNodes=Math.min(4096,Math.max(64,context.maxExpansions??1024));
  const maxSteps=Math.min(256,Math.max(1,context.maxSteps??96));
  const beam=Math.min(6,Math.max(1,context.beamWidth??3));
  const blocked=(b:PlanningBlocker)=>{if(trace.blockers.length<40&&!trace.blockers.some(x=>x.kind===b.kind&&x.fact===b.fact&&x.methodId===b.methodId&&x.reason===b.reason))trace.blockers.push(b);};
  const limit=(reason:string)=>{trace.truncated=true;blocked({kind:'search-limit',reason});};
  const aliases=context.aliases??{};
  const derive=(facts:Facts)=>{for(const [alias,components] of Object.entries(aliases))facts[alias]=components.reduce((n,k)=>n+val(facts,k),0);};
  const skillLevel=(facts:Facts,skill:string)=>{
    const model=context.skillModels[skill],xp=facts['xp:'+skill];if(!model||!model.confirmed||xp===undefined)return;
    let level=1;for(const [key,threshold] of Object.entries(model.thresholds))if(Number(key)>=1&&finite(threshold)&&xp>=threshold)level=Math.max(level,Number(key));
    return level;
  };
  const syncLevel=(facts:Facts,m:Method)=>{
    for(const skill of Object.keys(m.training?.xp??{})){
      const level=skillLevel(facts,skill);if(level!==undefined)facts['level:'+skill]=Math.max(val(facts,'level:'+skill),level);
    }
  };
  const fits=(s:SearchState)=>s.plan.costGp<=view.budget.spendableGp&&s.plan.lossBoundGp<=view.budget.maxLossGp&&s.plan.durationMs<=view.budget.maxDurationMs;
  const score=(s:SearchState)=>{
    const cost=s.plan.costGp+3*s.plan.lossBoundGp+s.plan.durationMs/1000+s.penalty;
    let useful=0;
    for(const [fact,u] of Object.entries(context.useful??{}))if(u.evidence.length&&finite(u.value)&&finite(u.quantity))
      useful+=Math.min(u.quantity,Math.max(0,val(s.facts,fact)-val(view.facts,fact)))*u.value;
    // Speculative output utility cannot overrule risk/budget, nor make training free.
    return cost-Math.min(cost*.15,useful);
  };
  const prune=(states:SearchState[])=>{
    const seen=new Set<string>();return states.sort((a,b)=>score(a)-score(b)||a.plan.steps.map(s=>s.methodId).join('|').localeCompare(b.plan.steps.map(s=>s.methodId).join('|')))
      .filter(s=>{const key=hash([s.facts,s.plan.steps.map(x=>x.methodId)]);if(seen.has(key))return false;seen.add(key);return true;}).slice(0,beam);
  };
  const usable=methods.filter(m=>{
    if(m.prerequisites.some(r=>!finite(r.minimum))||Object.values(m.effects).some(x=>!finite(x)))return false;
    // Unqualified XP activity markers remain legitimate old goals, but cannot forecast a skill unlock.
    return true;
  });
  const inputReq=(m:Method)=>uniqueReq([...m.prerequisites,...Object.entries(m.consumes??{}).map(([fact,minimum])=>({fact,minimum}))])
    .sort((a,b)=>Number(b.fact.startsWith('level:'))-Number(a.fact.startsWith('level:')));
  const solve=(req:Requirement,initial:SearchState,stack:Set<string>,ancestors:Requirement[],trainingOnly=false):SearchState[]=>{
    if(++trace.expansions>maxNodes){limit('Dependency expansion budget exhausted; unsearched alternatives may exist.');return [];}
    if(met(initial.facts,req))return [initial];
    if(stack.has(req.fact)){blocked({kind:'cycle',fact:req.fact,reason:'Dependency requires itself before a usable bootstrap method was found.'});return [];}
    if(stack.size>=12||initial.plan.steps.length>=maxSteps){limit('Depth or executable-step forecast horizon reached.');return [];}
    const path=new Set([...stack,req.fact]);
    if(req.fact.startsWith('level:')){
      const skill=req.fact.slice(6),model=context.skillModels[skill],xpFact='xp:'+skill,threshold=model?.thresholds[String(req.minimum)];
      if(view.strategy?.protectedSkills.includes(skill)||(view.strategy?.levelCaps?.[skill]!==undefined&&req.minimum>view.strategy.levelCaps[skill]!)){blocked({kind:'prohibited',fact:req.fact,reason:'The current build explicitly protects this skill.'});return [];}
      if(!model?.confirmed||!model.evidence.length||threshold===undefined||!finite(threshold)||initial.facts[xpFact]===undefined||initial.facts[req.fact]===undefined){
        blocked({kind:'needs-information',fact:req.fact,reason:'An observed skill/XP value, matching level model and confirmed live XP rate are required.'});return [];}
      blocked({kind:'needs-training',fact:req.fact,reason:`Compare currently supported XP activities to threshold ${threshold}; do not assume a level-up command.`});
      return solve({fact:xpFact,minimum:threshold},initial,path,[...ancestors,req],true).filter(s=>met(s.facts,req));
    }
    let options=usable.filter(m=>(m.effects[req.fact]??0)>0);
    if(trainingOnly)options=options.filter(m=>m.training?.evidence.length&&m.training.profileId===context.profileId
      &&m.training.xp[req.fact.slice(3)]===m.effects[req.fact]&&m.prerequisites.filter(x=>x.fact.startsWith('level:')).every(r=>met(initial.facts,r)));
    const readyNow=(m:Method)=>inputReq(m).every(r=>met(initial.facts,r));
    options.sort((a,b)=>Number(readyNow(b))-Number(readyNow(a))||scoreMethod(a)/(a.effects[req.fact]||1)-scoreMethod(b)/(b.effects[req.fact]||1)||a.id.localeCompare(b.id));
    if(options.length>12){limit('Method branch limit reached; comparison is not exhaustive.');options=options.slice(0,12);}
    if(!options.length){blocked({kind:'unavailable',fact:req.fact,reason:trainingOnly?'No currently trainable activity with source-backed numeric XP and an enabled executor.':'No registered method supplies this prerequisite in the current scene.'});return [];}
    const completed:SearchState[]=[];
    for(const m of options){
      let frontier=[clone(initial)],round=0;
      // Repetition is forecast only. The runtime dispatches ONE leaf, then obtains a new observation.
      while(frontier.length&&round++<maxSteps){
        const finished=frontier.filter(s=>met(s.facts,req));completed.push(...finished);
        frontier=frontier.filter(s=>!met(s.facts,req));if(!frontier.length)break;
        let next:SearchState[]=[];
        for(const s of frontier){
          if(++trace.expansions>maxNodes){limit('Dependency expansion budget exhausted.');break;}
          let ready=[s];
          for(const pre of inputReq(m)){
            ready=prune(ready.flatMap(r=>solve(pre,r,path,[...ancestors,req])));if(!ready.length)break;
          }
          for(const r0 of ready){
            if(r0.plan.steps.length>=maxSteps){limit('Executable-step forecast horizon reached.');continue;}
            if(!respectsPlanningCaps(view,m,r0.facts))continue;
            if(!m.prerequisites.every(x=>met(r0.facts,x))||!Object.entries(m.consumes??{}).every(([f,n])=>val(r0.facts,f)>=n))continue;
            // If resolving inputs already delivered the desired item, do not spend them needlessly.
            if(met(r0.facts,req)){next.push(r0);continue;}
            const r=clone(r0);
            for(const [f,n] of Object.entries(m.consumes??{})){
              if(aliases[f]){ // Never treat two aliases as two physical stacks.
                if(aliases[f]!.length!==1){blocked({kind:'needs-information',methodId:m.id,reason:'Consumable alias needs an explicit physical-item allocation.'});ready=[];break;}
                r.facts[aliases[f]![0]!]=val(r.facts,aliases[f]![0]!)-n;
              }else r.facts[f]=val(r.facts,f)-n;
            }
            if(!ready.length)continue;
            for(const [f,n] of Object.entries(m.effects))if(!aliases[f]){
              if(f.startsWith('xp:')&&context.skillModels[f.slice(3)]&&m.training?.xp[f.slice(3)]!==n)continue;
              r.facts[f]=val(r.facts,f)+n;
            }
            derive(r.facts);syncLevel(r.facts,m);
            if(Object.values(r.facts).some(x=>!finite(x)))continue;
            r.plan.steps.push({methodId:m.id,capability:m.capability,prerequisites:structuredClone(m.prerequisites),lineage:structuredClone([...ancestors,req])});
            r.plan.costGp+=m.costGp;r.plan.lossBoundGp+=m.lossBoundGp;r.plan.durationMs+=m.durationMs;
            const base=m.costGp+3*m.lossBoundGp+m.durationMs/1000;
            const role=Math.max(-.1,Math.min(.1,(memory.preferences[m.domain]??0)*.02));
            r.penalty+=Math.max(0,scoreMethod(m)-base)-base*role;
            if(!fits(r)){blocked({kind:'budget',methodId:m.id,reason:'Preparation plus execution exceeds the remaining parent budget.'});continue;}
            next.push(r);
          }
        }
        frontier=prune(next);
        if(trace.expansions>maxNodes)break;
      }
      completed.push(...frontier.filter(s=>met(s.facts,req)));
      if(round>maxSteps&&frontier.some(s=>!met(s.facts,req)))limit('Repeated training or acquisition exceeded the bounded forecast horizon.');
      if(trace.expansions>maxNodes)break;
    }
    return prune(completed);
  };
  const start:SearchState={facts:{...view.facts},plan:{steps:[],costGp:0,lossBoundGp:0,durationMs:0},penalty:0};derive(start.facts);
  const outcomes=solve(goal.target,start,new Set(),[]).filter(fits);
  const describe=(s:SearchState):ApproachSummary=>{
    const root=s.plan.steps.filter(x=>x.lineage?.at(-1)?.fact===goal.target.fact).map(x=>x.methodId);
    return {id:hash([...new Set(root)]),methods:[...new Set(s.plan.steps.map(x=>x.methodId))],costGp:s.plan.costGp,lossBoundGp:s.plan.lossBoundGp,durationMs:s.plan.durationMs,
      score:score(s),training:uniqueReq(s.plan.steps.flatMap(x=>(x.lineage??[]).filter(r=>r.fact.startsWith('level:')))),steps:s.plan.steps.length};
  };
  trace.compared=outcomes.map(describe);
  let selected=outcomes[0];
  const previous=memory.active?.id===goal.id?memory.active.plan?.approachId:undefined;
  const sticky=previous?outcomes.find(s=>describe(s).id===previous):undefined;
  if(selected&&sticky&&score(sticky)<=score(selected)*1.1+1){selected=sticky;trace.notes.push('Retained a feasible approach within the 10% + 1 score hysteresis band.');}
  if(!selected)return {trace};
  const summary=describe(selected);trace.selected=summary.id;trace.status=summary.training.length||selected.plan.steps.length>1?'needs-preparation':'ready';
  selected.plan.approachId=summary.id;selected.plan.planningTrace=trace;
  return {plan:selected.plan,trace};
}
