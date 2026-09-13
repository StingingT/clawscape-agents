import {isThreatened} from './runtime-policy';
export type EscapeMemory = {active?: boolean; safeSince?: number};
export function mustEscape(s:any, m:EscapeMemory):boolean {
  if (isThreatened(s)) {m.active=true; delete m.safeSince;}
  if (!m.active) return false;
  const pursuing = s.nearbyNpcs?.some((n:any)=>n.inCombat && n.distance<=8 && n.optionsWithIndex?.some((o:any)=>/^attack$/i.test(o.text)));
  if(pursuing){delete m.safeSince;return true;}
  m.safeSince ??= s.tick;
  if(Number(s.tick)-Number(m.safeSince)>=10){m.active=false;delete m.safeSince;return false;}
  return true;
}
