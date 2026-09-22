/** Contextual combat evidence. No I/O, action dispatch, or inferred damage/kill authority. */
import { createHash, randomUUID } from 'node:crypto';
import { combatEvents, observedPlayerIndex } from '../combat-evidence.ts';

export const ADAPTIVE_VERSION = 'adaptive-combat-20260922.3';
const numeric=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
const observed=(x:unknown):number|null=>numeric(x)?x:null;
const integer=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
export function canonical(x:any):string {
  if(x===undefined||x===null)return 'null';
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  if(typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
  return JSON.stringify(x);
}
export const digest=(x:any)=>createHash('sha256').update(canonical(x)).digest('hex').slice(0,24);
export const COMBAT_SKILLS=['attack','strength','defence','ranged','magic','hitpoints','prayer'];
export type Context={profile:string;skills:Record<string,{base:number|null;effective:number|null}>;
  equipment:Array<{slot:number|null;id:number;bonuses:any}>;style:any;prayers:any;effects:any;environment:any;unknown:string[]};
export function captureContext(s:any,profile:string):Context {
  const skills:Context['skills']={},unknown:string[]=[];
  for(const name of COMBAT_SKILLS){const v=s.skills?.find((v:any)=>String(v.name).toLowerCase()===name);
    skills[name]={base:observed(v?.baseLevel??v?.level),effective:observed(v?.currentLevel??v?.level)};
    if(skills[name].base===null||skills[name].effective===null)unknown.push('skill:'+name);
  }
  const style=s.combatStyle?.styles?.find((v:any)=>v.index===s.combatStyle?.currentStyle);
  const active=style?{index:style.index,type:style.attackType??style.type??null,trains:style.trainsSkills??null}:null;
  if(!active)unknown.push('attack-style');
  if(!Array.isArray(s.equipment))unknown.push('equipment');
  const equipment=(s.equipment??[]).filter((v:any)=>integer(v.id)&&(v.count===undefined||v.count>0)).map((v:any)=>({slot:observed(v.slot),id:v.id,bonuses:v.bonuses??null}))
    .sort((a:any,b:any)=>(a.slot??-1)-(b.slot??-1)||a.id-b.id);
  if(equipment.some((v:any)=>v.slot===null))unknown.push('equipment-slots');
  const prayers=s.activePrayers??s.prayer?.active??null,effects=s.activeEffects??s.boosts??null;
  if(prayers===null)unknown.push('prayers');if(effects===null)unknown.push('temporary-effects');
  // Unknown is not the same as a verified empty list. Preserve it in comparisons.
  return {profile,skills,equipment,style:active,prayers,effects,environment:{plane:observed(s.player?.level),
    world:s.world??null,members:s.members??s.worldInfo?.members??null,multiCombat:s.multiCombat??s.player?.multiCombat??null},unknown};
}
// Current HP/prayer points are resource meters, not Attack/Strength-style level controls.
// Their exact observed values remain in snapshots; outcome changes must not invalidate every damaged encounter.
export const comparisonContext=(c:Context):Context=>({...c,skills:Object.fromEntries(Object.entries(c.skills).map(([k,v])=>
  [k,['hitpoints','prayer'].includes(k)?{...v,effective:null}:v]))});
export const contextDigest=(c:Context)=>digest(comparisonContext(c));
export const contextKey=(s:any,profile:string)=>contextDigest(captureContext(s,profile));
export const controlsKey=(c:Context)=>digest({...comparisonContext(c),equipment:[],unknown:c.unknown.filter(x=>!x.startsWith('equipment'))});
export const gearKey=(c:Context)=>digest(c.equipment.map(v=>[v.slot,v.id]));
export type Target={id:number;index:number;name:string;level:number|null;instance:any;siteId:string;location:any};
export type Metrics={ticks:number;damageDealt:number|null;damageTaken:number|null;otherDamage:number|null;hpDecreaseLowerBound:number|null;
  xp:Record<string,number>;netResourceDecrease:Record<string,number>;foodUsed:Record<string,number>;coinsNetDecrease:number|null;
  damageQuality:'observed-lower-bound';resourceQuality:'observed-net-change';hitRate:null};
export type EncounterRecord={id:string;agent:string;profile:string;session:string;life:number;self:number|null;startTick:number;endTick:number;
  startedAt:number;endedAt?:number;target:Target;start:Context;end:Context;startHp:number|null;endHp:number|null;
  changes:Array<{tick:number;from:string;to:string;kind:string[]}>;metrics:Metrics;quality:string[];events:string[];
  outcome:'pending'|'kill'|'retreat'|'death'|'interrupted'|'unresolved';lastTick:number;killObserved:boolean;experimentId?:string;arm?:'A'|'B';};
export type Experiment={id:string;status:'active'|'complete'|'aborted';reason:string;parent:string;skill:string;siteId:string;targetId:number;
  controls:string;baseline:Context;slot:number;a:number;b:number;startedAt:number;expiresAt:number;pilotId:string;life:number;
  sequence:Array<'A'|'B'>;cursor:number;completedIds:string[];attempts:number;foodUsed:number;ammoUsed:number;cooldownUntil?:number};
export type AdaptiveMemory={version:1;samples:EncounterRecord[];pending?:EncounterRecord;experiment?:Experiment;experiments:Experiment[];
  lastDecision?:any;lastProposal?:any;lastContext?:Context;lastUpdatedAt?:number;session?:string;pilotUsage?:{id:string;attempts:number;food:number;ammo:number};};
export const emptyAdaptive=():AdaptiveMemory=>({version:1,samples:[],experiments:[]});
const add=(value:number|null,n:number)=>(value??0)+n;
const quantities=(s:any)=>{const m:Record<string,number>={};for(const v of [...(s.inventory??[]),...(s.equipment??[])])
  if(integer(v.id)&&numeric(v.count)&&v.count>=0)m[v.id]=(m[v.id]??0)+v.count;return m;};
const XP=(s:any)=>Object.fromEntries((s.skills??[]).filter((v:any)=>COMBAT_SKILLS.includes(String(v.name).toLowerCase())&&numeric(v.experience))
  .map((v:any)=>[String(v.name).toLowerCase(),v.experience]));
function difference(a:Context,b:Context):string[]{a=comparisonContext(a);b=comparisonContext(b);return (['skills','equipment','style','prayers','effects','environment','profile'] as const).filter(k=>canonical(a[k])!==canonical(b[k]));}
export function beginEncounter(memory:AdaptiveMemory,s:any,target:any,siteId:string,agent:string,profile:string,session:string,now:number,
  experiment?:{id:string;arm:'A'|'B'}):EncounterRecord|undefined {
  if(!integer(s.tick)||!integer(s.player?.lifeId)||!integer(target?.id)||!integer(target?.index))return;
  if(memory.pending){if(memory.pending.startTick===s.tick&&memory.pending.target.index===target.index&&memory.pending.session===session)return memory.pending;
    finishEncounter(memory,'interrupted',now);}
  const c=captureContext(s,profile);
  const e:EncounterRecord={id:randomUUID(),agent,profile,session,life:s.player.lifeId,self:observedPlayerIndex(s.player.index),
    startTick:s.tick,endTick:s.tick,lastTick:s.tick,startedAt:now,target:{id:target.id,index:target.index,name:String(target.name??''),
      level:observed(target.combatLevel),instance:target.spawnId??target.uid??null,siteId,location:{x:target.tileX??target.x??null,z:target.tileZ??target.z??null,plane:s.player.level??null}},
    start:c,end:c,startHp:observed(s.player.hp),endHp:observed(s.player.hp),changes:[],
    metrics:{ticks:0,damageDealt:null,damageTaken:null,otherDamage:null,hpDecreaseLowerBound:null,xp:{},netResourceDecrease:{},foodUsed:{},coinsNetDecrease:null,
      damageQuality:'observed-lower-bound',resourceQuality:'observed-net-change',hitRate:null},quality:['event-stream-completeness-unverified','other-participants-not-fully-observable'],
    events:[],outcome:'pending',killObserved:false,experimentId:experiment?.id,arm:experiment?.arm};
  if(e.self===null)e.quality.push('own-player-index-unknown');if(e.target.instance===null)e.quality.push('spawn-instance-unavailable');
  memory.pending=e;memory.lastContext=c;return e;
}
function note(e:EncounterRecord,flag:string){if(!e.quality.includes(flag))e.quality.push(flag);}
export function observeEncounter(memory:AdaptiveMemory,before:any,after:any,action:any,now:number):void {
  const e=memory.pending;if(!e)return;
  if(!integer(after.tick)||!integer(before.tick)){note(e,'invalid-observation-tick');return;}
  if(after.player?.lifeId!==e.life||after.player?.isDead===true){e.endHp=observed(after.player?.hp);
    const death=after.player?.isDead===true||(numeric(after.player?.respawnCount)&&numeric(before.player?.respawnCount)&&after.player.respawnCount>before.player.respawnCount);
    finishEncounter(memory,death?'death':'interrupted',now);return;}
  if(after.tick<e.lastTick||after.tick<before.tick){finishEncounter(memory,'interrupted',now);return;}
  if(after.tick===e.lastTick)return;
  const current=after.nearbyNpcs?.find((v:any)=>v.index===e.target.index);
  if(current&&(current.id!==e.target.id||(e.target.instance!==null&&(current.spawnId??current.uid??null)!==e.target.instance))){
    note(e,'target-index-reused');finishEncounter(memory,'interrupted',now);return;
  }
  const self=observedPlayerIndex(after.player?.index);
  if(self!==null&&e.self!==null&&self!==e.self){note(e,'player-index-changed');finishEncounter(memory,'interrupted',now);return;}
  const b=captureContext(before,e.profile),a=captureContext(after,e.profile);
  if(contextDigest(e.end)!==contextDigest(b))note(e,'unobserved-context-gap');
  const changes=difference(b,a);if(changes.length)e.changes.push({tick:after.tick,from:contextDigest(b),to:contextDigest(a),kind:changes});
  if(changes.length)note(e,'changed-conditions');
  const contiguous=before.tick===e.lastTick;
  if(!contiguous)note(e,'observation-gap');
  e.metrics.ticks+=after.tick-e.lastTick;
  const events=combatEvents(after.combatEvents);
  if((after.combatEvents?.length??0)>=30)note(e,'event-window-may-be-truncated');
  for(const event of events){
    if(event.tick<=e.lastTick||event.tick>after.tick)continue;
    const key=canonical(event);if(e.events.includes(key)){note(e,'identical-event-collapsed');continue;}e.events.push(key);
    const own=e.self!==null&&event.source_type==='player'&&event.source_index===e.self;
    const target=event.target_type==='npc'&&event.target_index===e.target.index;
    if(target&&event.source_type==='player'&&!own)note(e,'other-attacker-observed');
    if(event.type==='damage_dealt'&&own&&target)e.metrics.damageDealt=add(e.metrics.damageDealt,event.damage);
    if(event.type==='damage_taken'&&e.self!==null&&event.target_type==='player'&&event.target_index===e.self){
      if(event.source_type==='npc'&&event.source_index===e.target.index)e.metrics.damageTaken=add(e.metrics.damageTaken,event.damage);
      else {e.metrics.otherDamage=add(e.metrics.otherDamage,event.damage);note(e,'other-damage-source');}
    }
    if(event.type==='kill'&&own&&target)e.killObserved=true;
  }
  e.events=e.events.slice(-256);
  if(contiguous){
    const x=XP(before),y=XP(after);for(const k of Object.keys(x)){if(!numeric(y[k])){note(e,'missing-xp-observation');continue;}
      if(y[k]<x[k])note(e,'xp-reset');else e.metrics.xp[k]=(e.metrics.xp[k]??0)+y[k]-x[k];}
    if(numeric(before.player?.hp)&&numeric(after.player?.hp))e.metrics.hpDecreaseLowerBound=add(e.metrics.hpDecreaseLowerBound,Math.max(0,before.player.hp-after.player.hp));
    if(Array.isArray(before.inventory)&&Array.isArray(after.inventory)&&Array.isArray(before.equipment)&&Array.isArray(after.equipment)){
      const q=quantities(before),r=quantities(after);
      for(const [id,n] of Object.entries(q)){const loss=Math.max(0,n-(r[id]??0));if(loss)e.metrics.netResourceDecrease[id]=(e.metrics.netResourceDecrease[id]??0)+loss;}
      e.metrics.coinsNetDecrease=add(e.metrics.coinsNetDecrease,Math.max(0,(q['995']??0)-(r['995']??0)));
      if(action.type==='useInventoryItem'){
        const i=before.inventory.find((i:any)=>i.slot===action.fields?.slot);
        if(i?.optionsWithIndex?.some((o:any)=>o.opIndex===action.fields?.optionIndex&&/^eat$/i.test(o.text))){
          const n=Math.max(0,(q[i.id]??0)-(r[i.id]??0));if(n)e.metrics.foodUsed[i.id]=(e.metrics.foodUsed[i.id]??0)+n;
        }
      }
    }else note(e,'missing-inventory-observation');
  }
  e.end=a;e.endHp=observed(after.player?.hp);e.endTick=after.tick;e.lastTick=after.tick;memory.lastContext=a;memory.lastUpdatedAt=now;
  if(action.type==='retreat')finishEncounter(memory,'retreat',now);
  else if(e.killObserved)finishEncounter(memory,'kill',now);
}
export function finishEncounter(m:AdaptiveMemory,result:EncounterRecord['outcome'],now:number):EncounterRecord|undefined {
  const e=m.pending;if(!e)return;
  e.outcome=result==='kill'&&!e.killObserved?'unresolved':result;e.endedAt=now;
  if(!m.samples.some(v=>v.id===e.id))m.samples.push(e);
  m.samples=m.samples.slice(-240);delete m.pending;m.lastUpdatedAt=now;
  const trial=m.experiment;
  if(trial?.status==='active'&&trial.id===e.experimentId&&!trial.completedIds.includes(e.id)){
    trial.completedIds.push(e.id);
    trial.foodUsed+=Object.values(e.metrics.foodUsed).reduce((a,b)=>a+b,0);
    // Count all non-food inventory decreases conservatively against supply budget.
    trial.ammoUsed+=Object.entries(e.metrics.netResourceDecrease).filter(([id])=>id!=='995'&&!e.metrics.foodUsed[id]).reduce((n,[,v])=>n+v,0);
    if(m.pilotUsage?.id===trial.pilotId){m.pilotUsage.food+=Object.values(e.metrics.foodUsed).reduce((a,b)=>a+b,0);
      m.pilotUsage.ammo+=Object.entries(e.metrics.netResourceDecrease).filter(([id])=>id!=='995'&&!e.metrics.foodUsed[id]).reduce((n,[,v])=>n+v,0);}
    if(e.outcome!=='kill'||e.changes.length||e.quality.some(v=>['other-attacker-observed','other-damage-source','unobserved-context-gap','observation-gap'].includes(v)))
      abortExperiment(m,'Trial interrupted, changed conditions, or confounded; no isolated equipment claim.',now);
    else {trial.cursor++;if(trial.cursor>=trial.sequence.length){trial.status='complete';trial.reason='Bounded matched-order batch completed; evidence remains provisional.';trial.cooldownUntil=now+600_000;}}
  }
  return e;
}
export function abortExperiment(m:AdaptiveMemory,reason:string,now:number){if(m.experiment?.status==='active'){
  m.experiment.status='aborted';m.experiment.reason=reason;m.experiment.cooldownUntil=now+600_000;}}
export function stableSample(e:EncounterRecord):boolean{return e.outcome==='kill'&&!e.changes.length&&contextDigest(e.start)===contextDigest(e.end)
  &&!e.quality.some(v=>['other-attacker-observed','other-damage-source','unobserved-context-gap','observation-gap','missing-xp-observation','xp-reset'].includes(v));}
const mean=(a:number[])=>a.length?a.reduce((s,n)=>s+n,0)/a.length:null;
const variance=(a:number[])=>a.length>1?a.reduce((n,v)=>n+(v-mean(a)!)**2,0)/(a.length-1):null;
export function summarize(samples:EncounterRecord[]){
  const kills=samples.filter(stableSample),values=(f:(e:EncounterRecord)=>number|null)=>kills.map(f).filter(numeric);
  const ticks=values(e=>e.metrics.ticks),dealt=values(e=>e.metrics.damageDealt),taken=values(e=>e.metrics.damageTaken);
  return {encounters:samples.length,comparableKills:kills.length,retreats:samples.filter(e=>e.outcome==='retreat').length,deaths:samples.filter(e=>e.outcome==='death').length,
    unresolved:samples.filter(e=>['interrupted','unresolved'].includes(e.outcome)).length,changedConditions:samples.filter(e=>e.changes.length).length,
    meanTicks:mean(ticks),tickVariance:variance(ticks),meanDamageDealtLowerBound:mean(dealt),meanDamageTakenLowerBound:mean(taken),
    meanFood:mean(values(e=>Object.values(e.metrics.foodUsed).reduce((a,b)=>a+b,0))),
    netResourceDecrease: kills.reduce((m,e)=>{for(const [id,n] of Object.entries(e.metrics.netResourceDecrease))m[id]=(m[id]??0)+n;return m;},{} as Record<string,number>),
    perSkillXp:kills.reduce((m,e)=>{for(const [id,n] of Object.entries(e.metrics.xp))m[id]=(m[id]??0)+n;return m;},{} as Record<string,number>),
    confidence:kills.length>=5?'repeated-observations-not-proof':kills.length?'provisional':'insufficient',hitRate:null,
    note:'Observed lower-bound damage and net inventory decreases, not complete hits/misses, causal proof, or shop-valued costs.'};
}
export function compareRecords(a:EncounterRecord[],b:EncounterRecord[]){
  const x=a[0],y=b[0];if(!x||!y)return {kind:'insufficient',reason:'Both configurations need observations.'};
  const compatible=x.profile===y.profile&&x.target.id===y.target.id&&x.target.siteId===y.target.siteId;
  if(!compatible)return {kind:'not-comparable',reason:'Different rules, target variant, or site.'};
  const uniform=(xs:EncounterRecord[],c:Context)=>xs.every(e=>contextDigest(e.start)===contextDigest(c)&&stableSample(e));
  const controlled=controlsKey(x.start)===controlsKey(y.start)&&gearKey(x.start)!==gearKey(y.start)&&uniform(a,x.start)&&uniform(b,y.start)&&a.every(e=>e.startHp===x.startHp)&&b.every(e=>e.startHp===x.startHp);
  const slots=[...new Set([...x.start.equipment,...y.start.equipment].map(v=>v.slot))].filter(slot=>
    canonical(x.start.equipment.filter(v=>v.slot===slot))!==canonical(y.start.equipment.filter(v=>v.slot===slot)));
  const linked=controlled&&x.experimentId&&x.experimentId===y.experimentId&&[...a,...b].every(e=>e.experimentId===x.experimentId);
  return {kind:controlled?(linked?'equipment-experiment':'equipment-observational-comparison'):'readiness-comparison',
    isolatedEquipmentEffect:controlled&&x.start.unknown.length===0&&y.start.unknown.length===0?'candidate-association-not-causal-proof':false,
    changedFactors:difference(x.start,y.start),changedSlots:slots,equipmentFactor:slots.length===1?'single-slot':'equipment-set',
    a:summarize(a),b:summarize(b),unknownControls:[...new Set([...x.start.unknown,...y.start.unknown])],
    interpretation:controlled?'Matched observed controls. Check sample size, variability and unobserved confounders; do not declare causation.':'Compare the overall configurations only; skill/equipment/context changes cannot be isolated.'};
}
export function comparisonReport(m:AdaptiveMemory){
  const groups=new Map<string,EncounterRecord[]>();for(const e of m.samples){const k=digest([e.profile,e.target.id,e.target.siteId,comparisonContext(e.start)]);groups.set(k,[...(groups.get(k)??[]),e]);}
  const entries=[...groups].slice(-24),comparisons:any[]=[];
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const a=entries[i][1],b=entries[j][1];if(a[0].target.id===b[0].target.id&&a[0].target.siteId===b[0].target.siteId)
      comparisons.push({from:entries[i][0],to:entries[j][0],...compareRecords(a,b)});
  }
  return {groups:entries.map(([key,s])=>({key,target:s[0].target,context:s[0].start,...summarize(s)})),comparisons:comparisons.slice(-32)};
}
/** Only personal, exact-context evidence can adjust existing site rankings. It never authorizes an action. */
export function readinessDecision(m:AdaptiveMemory,s:any,profile:string,targetId:number,siteId:string,skill:string){
  const c=captureContext(s,profile),samples=m.samples.filter(e=>e.agent===s.__adaptiveAgent&&e.profile===profile&&e.target.id===targetId&&e.target.siteId===siteId&&contextDigest(e.start)===contextDigest(c));
  const stable=samples.filter(stableSample),failed=samples.filter(e=>['retreat','death'].includes(e.outcome)),summary=summarize(samples);
  let score=0;const reasons:string[]=[];
  if(failed.length){score-=Math.min(8,failed.reduce((n,e)=>n+(e.outcome==='death'?6:2),0));reasons.push('Comparable costly/failed encounters lower preference; compare other targets, supplies, gear, or preparation.');}
  if(stable.length>=2){const utility=stable.map(e=>(e.metrics.xp[skill]??0)/Math.max(1,e.metrics.ticks)-
      Math.max(e.metrics.hpDecreaseLowerBound??0,e.metrics.damageTaken??0)*.15-Object.values(e.metrics.foodUsed).reduce((a,b)=>a+b,0)-
      Object.values(e.metrics.netResourceDecrease).reduce((a,b)=>a+b,0)*.03);
    score+=Math.max(-4,Math.min(2,mean(utility)!*.1));reasons.push('Measured XP, encounter duration, health cost and supply changes inform relative preference.');}
  if(!samples.length)reasons.push('No exact-context personal sample. Familiar target may be a useful retest after a change; no inherited readiness guarantee.');
  return {score,summary,reasons,context:contextDigest(c),authority:'ranking-only',suggestedReview:failed.length?['alternative-target','supplies','equipment','relevant-training','supported-cooperation']:samples.length?['continue-or-retest-if-useful']:['bounded-relevant-benchmark']};
}
export function progressiveTrialAllowed(m:AdaptiveMemory,c:Context,targetLevel:number,step:number,targetId?:number):{allowed:boolean;reason:string}{
  const familiar=m.samples.some(e=>e.profile===c.profile&&(targetId===undefined?e.target.level===targetLevel:e.target.id===targetId)&&stableSample(e));
  if(familiar)return {allowed:true,reason:'Familiar benchmark; changed configuration still requires ordinary safety checks.'};
  const levels=m.samples.filter(e=>e.profile===c.profile&&contextDigest(e.start)===contextDigest(c)&&stableSample(e)).map(e=>e.target.level).filter(numeric);
  if(!levels.length)return {allowed:false,reason:'No matching tested baseline; a permitted ordinary encounter is needed first.'};
  return {allowed:targetLevel<=Math.max(...levels)+Math.max(1,Math.min(10,step)),reason:'Unknown-opponent progression bound is only a search constraint, not combat authority.'};
}
