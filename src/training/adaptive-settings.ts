/** Independent controls for passive recording, ranking feedback and bounded carried-gear tests. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
export const ADAPTIVE_CONFIG='data/catalog/adaptive-combat.json';
export const ADAPTIVE_AGENTS=['clawscout','stinger','coincrafter','featherer'] as const;
export type AdaptiveSettings={version:1;recording:boolean;decisions:'shadow'|'on';experiments:'shadow'|'pilot';
 pilot?:{id:string;agent:string;expiresAt:number;maxEncounters:number;maxFood:number;maxSupplyDecrease:number;maxLevelStep:number}};
export const defaultAdaptiveSettings=():AdaptiveSettings=>({version:1,recording:true,decisions:'shadow',experiments:'shadow'});
export function readAdaptiveSettings(root?:string):AdaptiveSettings {
  if(!root)return {...defaultAdaptiveSettings(),recording:false};
  const path=resolve(root,ADAPTIVE_CONFIG);if(!existsSync(path))return {...defaultAdaptiveSettings(),recording:false};
  try {if(statSync(path).size>32768)throw new Error('oversized settings');const s=JSON.parse(readFileSync(path,'utf8'));
    if(s.version!==1||typeof s.recording!=='boolean'||!['shadow','on'].includes(s.decisions)||!['shadow','pilot'].includes(s.experiments))throw new Error('bad settings');
    if(s.experiments==='pilot'){
      const p=s.pilot;if(!p||typeof p.id!=='string'||!ADAPTIVE_AGENTS.includes(p.agent)||!Number.isFinite(p.expiresAt)||
        !Number.isInteger(p.maxEncounters)||p.maxEncounters<1||p.maxEncounters>12||!Number.isInteger(p.maxFood)||p.maxFood<0||p.maxFood>10||
        !Number.isInteger(p.maxSupplyDecrease)||p.maxSupplyDecrease<0||p.maxSupplyDecrease>120||!Number.isInteger(p.maxLevelStep)||p.maxLevelStep<1||p.maxLevelStep>10)throw new Error('bad pilot');
    }
    return s;
  }catch{return {version:1,recording:false,decisions:'shadow',experiments:'shadow'};}
}
