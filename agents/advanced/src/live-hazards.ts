import type { Tile } from './contracts.ts';
// Conservative local route exclusions, not authoritative server safety zones.
// Jail guard hit observed at (3110,3228), tick2337 on 2026-09-07T22:09Z.
// Local m48_50 spawns + configured wander/maxrange corroborate the risk area.
export const LIVE_HAZARDS = [
  { name:'Draynor wizards', x0:3076,x1:3092,z0:3233,z1:3247 },
  { name:'Varrock wizards', x0:3218,x1:3234,z0:3358,z1:3378 },
  { name:'Draynor jail guards', x0:3093,x1:3143,z0:3221,z1:3265 },
] as const;
export const liveHazardAt=(p:Tile|null)=>p?.plane===0
  ? LIVE_HAZARDS.find(h=>p.x>=h.x0&&p.x<=h.x1&&p.z>=h.z0&&p.z<=h.z1):undefined;
