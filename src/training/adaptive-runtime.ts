/** Helper owned by TrainingDiscovery. Proposals only become existing actions through its validators. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { abortExperiment, captureContext, contextDigest, controlsKey, digest, gearKey, finishEncounter, summarize, comparisonReport, stableSample, progressiveTrialAllowed,
 type AdaptiveMemory, type Context, type Experiment } from './adaptive-combat.ts';
import { ADAPTIVE_AGENTS, readAdaptiveSettings, type AdaptiveSettings } from './adaptive-settings.ts';
export type GearOption={id:number;slot:number;allowed:boolean;name:string;reason:string};
export type AdaptiveOptions={root?:string;gearOptions?:(s:any,skill:string)=>GearOption[]};
export class AdaptiveRuntime {
  readonly session=randomUUID();private lastPublish=0;private peersAt=-Infinity;private peers:any[]=[];
  constructor(readonly memory:AdaptiveMemory,readonly agent:string,readonly profile:string,readonly options:AdaptiveOptions={},readonly now=Date.now){
    // A prior run's open window cannot be attributed to this process. Keep its observations as interrupted evidence.
    if(memory.pending)finishEncounter(memory,'interrupted',now());
    abortExperiment(memory,'Process restarted; old experimental authority is not resumed.',now());memory.session=this.session;
  }
  settings(){return readAdaptiveSettings(this.options.root);}
  private permitted(settings=this.settings()){
    const p=settings.pilot;return settings.recording&&settings.experiments==='pilot'&&p?.agent===this.agent&&p.expiresAt>this.now()?p:undefined;
  }
  private safeIdle(s:any){return s.inGame!==false&&s.player?.isDead!==true&&s.player?.combat?.inCombat!==true&&
    !(Number(s.player?.combat?.lastDamageTick)>=0&&Number(s.tick)-Number(s.player.combat.lastDamageTick)<=10)&&s.bank?.isOpen!==true&&s.shop?.isOpen!==true&&s.dialog?.isOpen!==true&&s.modalOpen!==true&&Number(s.player?.hp)>Number(s.player?.maxHp)*.8;}
  propose(s:any,target:any,siteId:string,skill:string,parent:string){
    const m=this.memory,c=captureContext(s,this.profile),now=this.now();
    if(m.experiment?.status==='active')return;
    if(m.experiment&&(m.experiment.cooldownUntil??0)>now)return;
    if(!this.settings().recording||!this.options.gearOptions)return;
    const known=m.samples.filter(e=>e.agent===this.agent&&e.profile===this.profile&&e.target.id===target.id&&e.target.siteId===siteId&&
      contextDigest(e.start)===contextDigest(c)&&stableSample(e));
    const recent=known.slice(-3);
    if(recent.length<2){m.lastProposal={kind:'readiness-benchmark',parent,siteId,targetId:target.id,dispatch:false,
      reason:'Need at least two recent matched personal completed encounters before testing another carried configuration.'};return;}
    // A minimum count is eligibility for an affordable test, never a declaration of safety.
    if(recent.some(e=>(e.metrics.hpDecreaseLowerBound??Infinity)>Number(s.player.maxHp)*.2||e.metrics.otherDamage!==null))return;
    const options=this.options.gearOptions(s,skill).filter(o=>o.allowed&&c.equipment.some(i=>i.slot===o.slot&&i.id!==o.id)&&
      s.inventory?.some((i:any)=>i.id===o.id&&i.count>0&&i.optionsWithIndex?.some((o:any)=>/^(wield|wear|equip)$/i.test(o.text))));
    const sorted=options.map(o=>({o,n:m.samples.filter(e=>e.target.id===target.id&&e.start.equipment.some(i=>i.slot===o.slot&&i.id===o.id)).length}))
      .sort((a,b)=>a.n-b.n||a.o.slot-b.o.slot||a.o.id-b.o.id);
    const selected=sorted.find(v=>v.n<4)?.o;
    if(!selected){m.lastProposal={kind:'equipment-experiment',parent,siteId,dispatch:false,reason:'No informative, carried, requirement-verified alternative; do not invent or buy gear for a test.'};return;}
    const a=c.equipment.find(i=>i.slot===selected.slot)!.id;
    m.lastProposal={kind:'equipment-experiment',parent,siteId,targetId:target.id,factor:{slot:selected.slot,a,b:selected.id},
      reason:'Compare a carried alternative against a relevant successful benchmark, including time, damage, XP and supplies.',
      unknownControls:c.unknown,dispatch:false};
    const p=this.permitted();if(!p||!this.safeIdle(s)||c.unknown.some(x=>x.startsWith('skill:')||['equipment','equipment-slots','attack-style'].includes(x)))return;
    if(m.pilotUsage?.id!==p.id)m.pilotUsage={id:p.id,attempts:0,food:0,ammo:0};
    if(m.pilotUsage.attempts>=p.maxEncounters||m.pilotUsage.food>p.maxFood||m.pilotUsage.ammo>p.maxSupplyDecrease)return;
    if(m.experiment)m.experiments=[...m.experiments,m.experiment].slice(-24);
    // Alternate counterbalanced blocks, not all A followed by all B. The last observation may be interrupted by levelling.
    const sequence:Array<'A'|'B'>=parseInt(digest([this.agent,now,selected.id]).slice(0,2),16)%2?['A','B','B','A']:['B','A','A','B'];
    m.experiment={id:randomUUID(),status:'active',reason:m.lastProposal.reason,parent,skill,siteId,targetId:target.id,controls:controlsKey(c),baseline:c,
      slot:selected.slot,a,b:selected.id,startedAt:now,expiresAt:Math.min(p.expiresAt,now+300_000),pilotId:p.id,life:s.player.lifeId,
      sequence,cursor:0,completedIds:[],attempts:0,foodUsed:0,ammoUsed:0};
  }
  check(s:any,skill:string):Experiment|undefined {
    const e=this.memory.experiment;if(!e||e.status!=='active')return;
    const p=this.permitted(),c=captureContext(s,this.profile),u=this.memory.pilotUsage;
    const changed=skill!==e.skill||controlsKey(c)!==e.controls||s.player?.lifeId!==e.life;
    const budget=!p||p.id!==e.pilotId||this.now()>=e.expiresAt||!u||u.id!==p.id||(u.attempts>=p.maxEncounters&&this.memory.pending?.experimentId!==e.id)||
      (p.maxFood>0?u.food>=p.maxFood:u.food>0)||(p.maxSupplyDecrease>0?u.ammo>=p.maxSupplyDecrease:u.ammo>0);
    if(changed||budget){abortExperiment(this.memory,changed?'Observed levels/style/conditions changed; keep separate readiness evidence.':'Experimental authorization expired, revoked, or budget exhausted.',this.now());return;}
    const expected=e.baseline.equipment.map(v=>v.slot===e.slot?{...v,id:e.a}:v);
    const baselineRest=expected.filter(v=>v.slot!==e.slot).map(v=>[v.slot,v.id]);
    if(digest(c.equipment.filter(v=>v.slot!==e.slot).map(v=>[v.slot,v.id]))!==digest(baselineRest)){
      abortExperiment(this.memory,'Uncontrolled equipment change; compare whole configuration only.',this.now());return;
    }
    if(!this.options.gearOptions?.(s,skill).some(o=>o.id===e.b&&o.slot===e.slot&&o.allowed)){
      abortExperiment(this.memory,'Candidate eligibility no longer verified.',this.now());return;
    }
    return e;
  }
  candidateReview(s:any,targetId:number,targetLevel:number){
    const settings=this.settings(),personal={...this.memory,samples:this.memory.samples.filter(e=>e.agent===this.agent)};
    const c=captureContext(s,this.profile),matched=personal.samples.filter(e=>e.profile===this.profile&&contextDigest(e.start)===contextDigest(c)&&stableSample(e));
    const step=settings.pilot?.maxLevelStep??10;
    const review=progressiveTrialAllowed(personal,c,targetLevel,step,targetId);
    // No new baseline is invented. Ordinary independently validated combat may establish one.
    const enforce=settings.decisions==='on'&&matched.length>=2;
    return {...review,enforced:enforce,eligible:!enforce||review.allowed,step,baselineSamples:matched.length,
      note:'Only a search restriction on unfamiliar upward progression; never permission to bypass readiness or navigation.'};
  }
  gearAction(s:any,skill:string):{holdEquipment:boolean;action?:any} {
    const e=this.check(s,skill);if(!e)return this.preferredGear(s,skill);
    if(!this.safeIdle(s)||this.memory.pending)return {holdEquipment:false};
    const id=e.sequence[e.cursor]==='A'?e.a:e.b;
    if(s.equipment?.some((i:any)=>i.slot===e.slot&&i.id===id&&i.count>0))return {holdEquipment:true};
    const item=s.inventory?.find((i:any)=>i.id===id&&i.count>0),option=item?.optionsWithIndex?.find((o:any)=>/^(wear|wield|equip)$/i.test(o.text));
    if(!item||!Number.isInteger(item.slot)||!Number.isInteger(option?.opIndex)){
      abortExperiment(this.memory,'Required variant is not carried with a fresh equip option; no acquisition forced.',this.now());return {holdEquipment:false};}
    return {holdEquipment:true,action:{id:'adaptive-equip-'+e.id+'-'+id,type:'useInventoryItem',fields:{slot:item.slot,optionIndex:option.opIndex,
      adaptiveExperiment:e.id,adaptiveItemId:id,adaptiveContext:digest(captureContext(s,this.profile)),trainingSite:e.siteId},waitTicks:2}};
  }
  validateGear(s:any,action:any,skill:string){
    if(action.fields?.adaptiveEvidence){
      if(this.settings().decisions!=='on'||!this.safeIdle(s)||this.memory.pending||digest(captureContext(s,this.profile))!==action.fields.adaptiveContext)return false;
      const current=this.preferredGear(s,skill).action;return !!current&&current.fields.slot===action.fields.slot&&current.fields.optionIndex===action.fields.optionIndex&&current.fields.adaptiveItemId===action.fields.adaptiveItemId;
    }
    const e=this.check(s,skill);if(!e||!this.safeIdle(s)||this.memory.pending||e.id!==action.fields?.adaptiveExperiment||
      digest(captureContext(s,this.profile))!==action.fields?.adaptiveContext)return false;
    const current=this.gearAction(s,skill).action;
    return !!current&&current.fields.slot===action.fields.slot&&current.fields.optionIndex===action.fields.optionIndex&&current.fields.adaptiveItemId===action.fields.adaptiveItemId;
  }
  attackTag(s:any,target:any,siteId:string,skill:string):{id:string;arm:'A'|'B'}|undefined {
    const e=this.check(s,skill);if(!e||e.targetId!==target.id||e.siteId!==siteId)return;
    const arm=e.sequence[e.cursor],id=arm==='A'?e.a:e.b;
    if(!s.equipment?.some((i:any)=>i.slot===e.slot&&i.id===id))return;
    e.attempts++;this.memory.pilotUsage!.attempts++;return {id:e.id,arm};
  }
  attackMatches(s:any,target:any,siteId:string,skill:string){
    const e=this.check(s,skill);if(!e)return true;
    const id=e.sequence[e.cursor]==='A'?e.a:e.b;
    return siteId===e.siteId&&target.id===e.targetId&&s.equipment?.some((v:any)=>v.slot===e.slot&&v.id===id);
  }
  private preferredGear(s:any,skill:string):{holdEquipment:boolean;action?:any} {
    const m=this.memory;if(this.settings().decisions!=='on'||!this.safeIdle(s)||m.pending||!this.options.gearOptions||!m.lastDecision?.siteId)return {holdEquipment:false};
    const c=captureContext(s,this.profile);
    if(!Array.isArray(c.style?.trains)||c.style.trains.length!==1||String(c.style.trains[0]).toLowerCase()!==skill)return {holdEquipment:false};
    const rows=m.samples.filter(e=>e.agent===this.agent&&e.profile===this.profile&&e.target.siteId===m.lastDecision.siteId&&(m.lastDecision.targetId===undefined||e.target.id===m.lastDecision.targetId)&&
      e.startHp===s.player.hp&&controlsKey(e.start)===controlsKey(c)&&stableSample(e));
    const groups=new Map<string,typeof rows>();for(const e of rows){const k=gearKey(e.start);groups.set(k,[...(groups.get(k)??[]),e]);}
    const value=(xs:typeof rows)=>xs.reduce((n,e)=>n+(e.metrics.xp[skill]??0)/Math.max(1,e.metrics.ticks)-
      Math.max(e.metrics.hpDecreaseLowerBound??0,e.metrics.damageTaken??0)*.15-Object.values(e.metrics.foodUsed).reduce((a,b)=>a+b,0)-
      Object.values(e.metrics.netResourceDecrease).reduce((a,b)=>a+b,0)*.03,0)/xs.length;
    const current=groups.get(gearKey(c));if(!current||current.length<2)return {holdEquipment:false};
    const ranked=[...groups.values()].filter(xs=>xs.length>=2).sort((a,b)=>value(b)-value(a));
    const best=ranked[0];if(!best)return {holdEquipment:false};
    // Retain a measured preference rather than immediately reversing it through a static item-tier heuristic.
    if(gearKey(best[0].start)===gearKey(c)){m.lastDecision.equipmentPreference={kind:'retain-measured-kit',sampleIds:best.map(e=>e.id),provisional:true};return {holdEquipment:true};}
    if(value(best)<value(current)+.25)return {holdEquipment:false};
    const wanted=best[0].start.equipment,changed=wanted.filter(v=>!c.equipment.some(i=>i.slot===v.slot&&i.id===v.id));
    // Atomic multi-piece outfit transactions are not provided. Learn their readiness effects, but do not silently replay a whole set.
    if(changed.length!==1||wanted.length!==c.equipment.length)return {holdEquipment:false};
    const item=changed[0],approved=this.options.gearOptions(s,skill).some(o=>o.id===item.id&&o.slot===item.slot&&o.allowed);
    const carried=s.inventory?.find((v:any)=>v.id===item.id&&v.count>0),op=carried?.optionsWithIndex?.find((o:any)=>/^(wear|wield|equip)$/i.test(o.text));
    if(!approved||!Number.isInteger(carried?.slot)||!Number.isInteger(op?.opIndex))return {holdEquipment:false};
    m.lastDecision.equipmentPreference={kind:'measured-carried-alternative',itemId:item.id,currentUtility:value(current),alternativeUtility:value(best),
      sampleIds:best.map(e=>e.id),provisional:true,reason:'Comparable throughput and resource costs, not a claim of isolated causal improvement.'};
    return {holdEquipment:true,action:{id:'adaptive-preferred-'+item.id,type:'useInventoryItem',fields:{slot:carried.slot,optionIndex:op.opIndex,
      adaptiveEvidence:true,adaptiveItemId:item.id,adaptiveContext:digest(c),trainingSite:m.lastDecision.siteId},waitTicks:2}};
  }
  sharedHints(targetId:number,siteId:string){
    const root=this.options.root;if(!root)return [];
    if(this.now()-this.peersAt>=30000){this.peers=[];this.peersAt=this.now();for(const agent of ADAPTIVE_AGENTS){if(agent===this.agent)continue;
      const path=resolve(root,'data/shared/combat-evidence',agent+'.json');try{
        if(!existsSync(path)||statSync(path).size>4*1024*1024)continue;const d=JSON.parse(readFileSync(path,'utf8'));
        if(d.version!==1||d.agent!==agent||d.profile!==this.profile||!Array.isArray(d.samples)||!Number.isFinite(d.at)||d.at>this.now()||this.now()-d.at>86400000)continue;
        for(const e of d.samples.slice(-80))if(e.agent===agent&&e.profile===this.profile&&e.target&&e.start&&e.metrics)this.peers.push(e);
      }catch{}}
    }
    return this.peers.filter(e=>e.target.id===targetId&&e.target.siteId===siteId).slice(-8).map(e=>({agent:e.agent,id:e.id,context:e.start,outcome:e.outcome,
      evidenceOnly:true,reason:"Another character's contextual observation can suggest a benchmark; it is not personal readiness or action authority."}));
  }
  publish(){
    if(!this.options.root||!ADAPTIVE_AGENTS.includes(this.agent as any)||!this.settings().recording||this.now()-this.lastPublish<5000)return;
    const file=resolve(this.options.root,'data/shared/combat-evidence',this.agent+'.json');
    const data={version:1,agent:this.agent,profile:this.profile,at:this.now(),samples:this.memory.samples.slice(-80),
      note:'Attributable observations. Another agent must not inherit personal readiness or experimental authority.'};
    const tmp=file+'.'+this.session+'.tmp';try{mkdirSync(dirname(file),{recursive:true});writeFileSync(tmp,JSON.stringify(data));renameSync(tmp,file);this.lastPublish=this.now();}catch{/* Failure to publish cannot authorize an action. Local memory remains authoritative. */}
  }
  report(){return {settings:this.settings(),at:this.memory.lastUpdatedAt??null,counts:summarize(this.memory.samples),
    pending:this.memory.pending,lastProposal:this.memory.lastProposal,lastDecision:this.memory.lastDecision,experiment:this.memory.experiment,
    ...comparisonReport(this.memory)};}
}
export function readAdaptiveReport(root:string,agent:string,folder:string){
  const path=resolve(root,'data',folder,'training-knowledge.json');
  try{if(!existsSync(path))return {agent,available:false,reason:'No training memory.'};if(statSync(path).size>16*1024*1024)throw new Error('training memory exceeds read limit');
    const d=JSON.parse(readFileSync(path,'utf8'));if(d.character!==agent||d.version!==1)throw new Error('training identity/version mismatch');
    return {agent,available:true,savedAt:statSync(path).mtime.toISOString(),profiles:Object.entries(d.worlds??{}).map(([profile,k]:any)=>({profile,
      legacyStatsPreserved:true,activeSite:k.commitment?.siteId,trainingStatus:k.status,
      learning:k.adaptive?{updatedAt:k.adaptive.lastUpdatedAt,samples:k.adaptive.samples?.length??0,pending:k.adaptive.pending,
        experiment:k.adaptive.experiment,lastProposal:k.adaptive.lastProposal,lastDecision:k.adaptive.lastDecision,
        ...comparisonReport(k.adaptive),recentEncounters:k.adaptive.samples?.slice(-12)}:{reason:'No new adaptive observations in this profile yet.'}}))};
  }catch(error){return {agent,available:false,reason:String(error)};}
}
