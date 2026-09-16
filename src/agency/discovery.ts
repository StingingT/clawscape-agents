/** Local experiments are hypotheses; only fresh observations and the executor's
 * collision/risk checks authorize their actions. No named route or agent is seeded. */
export type LocalTile = {x:number;z:number;level:number};
export const localCell = (p:LocalTile) => `${p.level}:${Math.floor(p.x/8)}:${Math.floor(p.z/8)}`;
export const localCellFact = (p:LocalTile) => 'observed:local-cell:'+localCell(p);
export const normalOption = (s:unknown) => String(s??'').trim().toLowerCase().replace(/[-_\s]+/g,' ');
/** Exclude reward/choice surfaces; generic Use/Enter is not safe merely by name. */
export function transitionOption(loc:any):{opIndex:number;text:string}|undefined {
  if(!loc || /chest|coffin|altar|lever|toll|locked|wilderness/i.test(String(loc.name??'')))return;
  return (loc.optionsWithIndex??[]).find((o:any)=>Number.isInteger(o.opIndex)&&
    /^(open|close|climb|climb up|climb down)$/.test(normalOption(o.text)));
}
export function localFrontiers(state:any, visited:Record<string,string>):LocalTile[] {
  const p=state.player, at={x:p?.worldX,z:p?.worldZ,level:p?.level};
  if(state.inGame!==true||![at.x,at.z,at.level,state.tick].every(Number.isInteger)
    ||at.level<0||at.level>3||!(p.hp>0)||p.isDead||p.combat?.inCombat===true
    ||p.combat?.targetType==='player'||state.danger?.active===true)return [];
  const result:LocalTile[]=[], cells=new Set<string>([localCell(at)]);
  // Relative probe geometry is not a route claim. Every endpoint still requires
  // full, current collision coverage and the normal hazard/dispatch guards.
  for(const radius of [6,12])for(const [dx,dz] of [[0,1],[1,0],[0,-1],[-1,0],[1,1],[-1,1],[1,-1],[-1,-1]]) {
    const to={x:at.x+dx!*radius,z:at.z+dz!*radius,level:at.level}, key=localCell(to);
    if(to.x<0||to.z<0||to.x>16383||to.z>16383||visited[key]||cells.has(key))continue;
    cells.add(key);result.push(to);
  }
  return result.slice(0,12);
}
/** A menu option plus walking up to its object is not proof of using a transition. */
export function transitionEvidence(before:any,after:any,action:any):string[] {
  if(action.type!=='interactLoc')return [];
  const a=before?.player,b=after?.player,f=action.fields??{};
  if(!a||!b||before.inGame!==true||after.inGame!==true||a.isDead||b.isDead||!(a.hp>0)||!(b.hp>0)||a.lifeId!==b.lifeId||a.respawnCount!==b.respawnCount
    ||![a.worldX,a.worldZ,a.level,b.worldX,b.worldZ,b.level,before.tick,after.tick].every(Number.isFinite)
    ||after.tick<=before.tick||after.tick-before.tick>100)return [];
  for(const field of ['character','world','worldEpoch','profileId','sessionId'])
    if(before[field]!==undefined&&before[field]!==after[field])return [];
  const loc=(before.nearbyLocs??[]).find((l:any)=>l.id===f.locId&&l.x===f.x&&l.z===f.z
    &&Number(l.level??a.level)===a.level);
  const op=transitionOption(loc);
  if(loc?.reachable!==true||!op||op.opIndex!==f.optionIndex
    ||Math.max(Math.abs(a.worldX-loc.x),Math.abs(a.worldZ-loc.z))>5)return [];
  const verb=normalOption(op.text);
  if(verb.startsWith('climb')) {
    // Dungeon transitions can change coordinates rather than plane. The source
    // is the exact observed interaction; the destination is learned afterwards.
    if(b.level!==a.level||Math.max(Math.abs(a.worldX-b.worldX),Math.abs(a.worldZ-b.worldZ))>8)
      return [`observed-transition:${loc.id}:${a.worldX},${a.worldZ},${a.level}->${b.worldX},${b.worldZ},${b.level}`];
    return [];
  }
  if(a.level!==b.level||!Array.isArray(after.nearbyLocs))return [];
  const opposite=verb==='open'?'close':verb==='close'?'open':undefined;
  if(!opposite)return [];
  // Two neighboring doors may have opposite states already. Neither observing
  // that neighbor nor losing sight of the requested door proves our effect.
  if(after.nearbyLocs.some((l:any)=>l.id===loc.id&&l.x===loc.x&&l.z===loc.z
    &&Number(l.level??b.level)===b.level&&(l.optionsWithIndex??[]).some((o:any)=>normalOption(o.text)===verb)))return [];
  const changed=after.nearbyLocs.find((l:any)=>Number(l.level??b.level)===b.level
    &&String(l.name).toLowerCase()===String(loc.name).toLowerCase()
    &&Math.max(Math.abs(l.x-loc.x),Math.abs(l.z-loc.z))<=1
    &&(l.optionsWithIndex??[]).some((o:any)=>normalOption(o.text)===opposite)
    &&!before.nearbyLocs.some((old:any)=>old.id===l.id&&old.x===l.x&&old.z===l.z
      &&Number(old.level??a.level)===a.level&&(old.optionsWithIndex??[]).some((o:any)=>normalOption(o.text)===opposite)));
  return changed?[`observed-obstruction-state:${loc.id}:${verb}->${opposite}`]:[];
}
