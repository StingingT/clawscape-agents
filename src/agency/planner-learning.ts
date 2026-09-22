import fs from 'node:fs';
import path from 'node:path';
type Gap={target:string;agent:string;context?:string;confirmations:number;suppressUntil:number;status:'active'|'resolved'};
type Store={version:1;gaps:Gap[]};
export type PlannerLearning={exhausted:Set<string>;noveltyPressure:boolean};
/** Capability-family check used by catalogue generation. This intentionally
 * leaves survey/walk exploration alone: only observed transition interactions
 * require the missing executor. */
export const transitionInteractionUnavailable=(learning:PlannerLearning)=>learning.exhausted.has('discovery:observed-transition-interaction');
export function plannerLearning(root:string,agent:string,now=Date.now(),context?:string):PlannerLearning{
  const exhausted=new Set<string>();
  try{const store=JSON.parse(fs.readFileSync(path.join(root,'data','team-control','capability-gaps.json'),'utf8').replace(/^\uFEFF/,'')) as Store;
    if(store?.version===1&&Array.isArray(store.gaps))for(const g of store.gaps)
      if(g?.agent===agent&&g.status==='active'&&Number(g.confirmations)>=2&&Number(g.suppressUntil)>now&&typeof g.target==='string'
        &&(context===undefined||g.context===undefined||g.context===context))exhausted.add(g.target.toLowerCase());
  }catch{}
  return {exhausted,noveltyPressure:exhausted.has('production-batch')&&exhausted.has('gathering-batch')};
}
