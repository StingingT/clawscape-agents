import fs from 'node:fs';
import path from 'node:path';
export type LearnedGap={target:string;agent:string;context?:string;firstSeenAt:number;lastSeenAt:number;confirmations:number;progressAt:number|null;suppressUntil:number;status:'active'|'resolved';evidence:string[]};
type Store={version:1;updatedAt:number;gaps:LearnedGap[]};
const clean=(s:string)=>s.trim().toLowerCase();
/** Learning a distinct coordinate after every unavailable interaction recreates
 * the very loop the diagnostic layer is meant to stop.  Preserve the observed
 * object IDs in evidence, but learn the missing executor at its capability
 * boundary so other agents can choose a different available capability. */
const target=(value:string)=>{
 const id=clean(value);
 return /^discover:discovered:interaction:/.test(id)?'discovery:observed-transition-interaction':id;
};
export class DiagnosticLearning{
 readonly file:string;private store:Store={version:1,updatedAt:0,gaps:[]};
 constructor(root:string){this.file=path.join(root,'data','team-control','capability-gaps.json');try{const x=JSON.parse(fs.readFileSync(this.file,'utf8').replace(/^\uFEFF/,''));if(x?.version===1&&Array.isArray(x.gaps)){this.store=x;if(this.migrateTargets())this.save()}}catch{}}
 private save(){this.store.updatedAt=Date.now();fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file,JSON.stringify(this.store,null,2)+'\n')}
 private migrateTargets(){
  const groups=new Map<string,LearnedGap>();let changed=false;
  for(const gap of this.store.gaps){const normalized=target(gap.target);if(normalized!==gap.target)changed=true;
   const key=[gap.agent,normalized,gap.status,gap.progressAt,gap.context??'legacy'].join('\0'),prior=groups.get(key);
   if(!prior){groups.set(key,{...gap,target:normalized,evidence:[...new Set(gap.evidence??[])]});continue}
   changed=true;prior.firstSeenAt=Math.min(prior.firstSeenAt,gap.firstSeenAt);prior.lastSeenAt=Math.max(prior.lastSeenAt,gap.lastSeenAt);
   prior.confirmations+=gap.confirmations;prior.suppressUntil=Math.max(prior.suppressUntil,gap.suppressUntil);prior.evidence=[...new Set([...prior.evidence,...(gap.evidence??[])])];
  }
  if(changed)this.store.gaps=[...groups.values()];return changed;
 }
 private targets(facts:any[]){const out=new Set<string>();for(const f of facts??[]){const s=String(f?.statement??''),m=s.match(/no feasible current executor step:\s*([^\s"]+)/i);if(m)out.add(target(m[1]));if(/gathering-batch/i.test(s))out.add('gathering-batch');if(/production-batch/i.test(s))out.add('production-batch')}return [...out]}
 learn(agent:string,d:any,facts:any[],progressAt:number|null,context?:string|number,now=Date.now()){if(typeof context==='number'){now=context;context=undefined}if(d?.kind!=='capability-gap'||d?.focus!=='executor'||d?.recheck!=='needs-implementation')return [];const learned:LearnedGap[]=[];for(const target of this.targets(facts)){let g=this.store.gaps.find(x=>x.agent===agent&&x.target===target&&x.status==='active'&&x.progressAt===progressAt&&x.context===context);if(g){g.confirmations++;g.lastSeenAt=now;g.suppressUntil=now+15*60_000;g.evidence=[...new Set([...g.evidence,...(d.evidenceIds??[])])]}else{g={target,agent,context,firstSeenAt:now,lastSeenAt:now,confirmations:1,progressAt,suppressUntil:now+15*60_000,status:'active',evidence:d.evidenceIds??[]};this.store.gaps.push(g)}learned.push(g)}if(learned.length)this.save();return learned}
 resolveOnProgress(agent:string,p:number|null){let changed=false;for(const g of this.store.gaps)if(g.agent===agent&&g.status==='active'&&g.progressAt!==p){g.status='resolved';changed=true}if(changed)this.save()}
 suppresses(agent:string,c:any,now=Date.now()){const id=clean(String(c?.id??'')),family=clean(String(c?.plan?.family??''));return this.store.gaps.some(g=>g.agent===agent&&g.status==='active'&&g.confirmations>=2&&g.suppressUntil>now&&(
   id===g.target||family===g.target||(g.target==='discovery:observed-transition-interaction'&&/^discover:discovered:interaction:/.test(id))))}
 view(){return this.store}
}
