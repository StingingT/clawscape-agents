/** Optional local audited effect contracts. Web guides and chat cannot populate these.
 * No fallback XP curve, combat multiplier, price, quest access, or prayer benefit. */
import { existsSync, readFileSync } from 'node:fs';
import type { Identity } from './types.ts';
export type BuildRules = {
  version:1; world:string; revision:string; source:string;
  /** Index is the level; value is its minimum XP, from the matching server. */
  xpThresholds: Record<string, number[]>;
  /** Operation-wide upper bound, including delayed/automatic repeats until terminal. */
  effects: Record<string, {terminal:true; maximumXp:Record<string,number>}>;
  features: Record<string, {supported:boolean; evidence:string}>;
};
export function validateBuildRules(value: unknown, identity: Pick<Identity,'world'|'revision'>): BuildRules {
  const r=value as BuildRules;
  if(!r || r.version!==1 || r.world!==identity.world || r.revision!==identity.revision || !r.source?.trim()
    || !r.xpThresholds || !r.effects || !r.features)throw new Error('BUILD_RULES_IDENTITY_OR_SOURCE_INVALID');
  for(const [skill,levels] of Object.entries(r.xpThresholds)) {
    if(!/^[a-z]+$/.test(skill) || !Array.isArray(levels) || levels.length<3 || levels[1]!==0
      || levels.some((v,i)=>!Number.isFinite(v)||v<0||(i>1&&v<=levels[i-1]!)))throw new Error('BUILD_RULES_XP_TABLE_INVALID');
  }
  for(const [key,e] of Object.entries(r.effects))if(!/^(attack:\d+:[^:\r\n]+:\d+|bury:\d+|dialogue:\d+:\d+|spell:\d+)$/.test(key) || !e || e.terminal!==true || !e.maximumXp
    || !Object.keys(e.maximumXp).length || !Object.entries(e.maximumXp).every(([k,v])=>/^[a-z]+$/.test(k)&&Number.isFinite(v)&&v>=0))
    throw new Error('BUILD_RULES_EFFECT_INVALID');
  for(const f of Object.values(r.features))if(typeof f?.supported!=='boolean'||!f.evidence?.trim())throw new Error('BUILD_RULES_FEATURE_INVALID');
  return structuredClone(r);
}
export function loadBuildRules(file:string,identity:Pick<Identity,'world'|'revision'>):BuildRules|undefined {
  return existsSync(file)?validateBuildRules(JSON.parse(readFileSync(file,'utf8')),identity):undefined;
}
export const hasBuildFeature=(rules:BuildRules|undefined,id:string)=>rules?.features[id]?.supported===true && !!rules.features[id]?.evidence;
