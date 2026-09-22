/**
 * A read-only wait is useful only while the world already reports a live
 * activity (for example a chopping or fletching animation). Treating an idle
 * wait as a production action lets a goal look active while it produces no XP,
 * items, money, or exploration evidence.
 */
export type CandidateLike={type:string};

/** Select only one observed, low-risk collection verb from a resource dialog. */
export function safeResourceDialogOption(options:unknown):number|undefined {
  if(!Array.isArray(options))return;
  const safe=options.filter((option:any)=>Number.isInteger(option?.index)
    &&/^(?:mine|mine\s+ore|chop(?:\s+down)?|fish|harvest|gather|collect|continue)$/i.test(String(option.text??'')));
  return safe.length===1?Number(safe[0]!.index):undefined;
}
export function productiveProductionCandidates(state:any,candidates:CandidateLike[]):CandidateLike[] {
  const concrete=candidates.filter(action=>action.type!=='wait');
  if(concrete.length)return concrete;
  return Number(state?.player?.animId)>=0?candidates:[];
}

/** Some goals own their complete bank protocol: deciding which input/tool to
 * retain, withdraw, or sell depends on the currently committed method. A
 * generic clutter/coin pass must not replace that protocol just because the
 * interface happens to be open. */
export function taskOwnsBankExecutor(kind:string|undefined):boolean {
  // Only a task with an explicit input/output lifecycle may keep the bank
  // open. Exploration and survey work must close it: generic "tidy up"
  // transfers are not evidence toward a route or discovery goal.
  return kind==='production';
}

/** These methods have no bank-transfer phase. An inherited bank interface is
 * closed before execution instead of being treated as a reason to shuffle
 * coins or unrelated inventory. */
export function taskMustCloseInheritedBank(task:{kind?:string}):boolean {
  return ['exploration','discovery','combat','prayer'].includes(String(task.kind));
}

/** Match a discovery task to the same safe local transition predicate used by
 * catalogue generation. An adjacent door/gate can report collision-unreachable
 * because its footprint occupies the blocked tile; its observed Open action is
 * still safe to test from the adjacent player tile. */
export function observedDiscoveryTransition(state:any,taskId:string):any|undefined {
  const player=state?.player??{},level=Number(player.level??0),x=Number(player.worldX),z=Number(player.worldZ);
  return (state?.nearbyLocs??[]).find((loc:any)=>{
    if(!Number.isInteger(loc?.id)||!Number.isInteger(loc?.x)||!Number.isInteger(loc?.z))return false;
    const samePlane=Number(loc.level??level)===level;
    const adjacent=Math.max(Math.abs(x-Number(loc.x)),Math.abs(z-Number(loc.z)))<=1;
    if(!samePlane||!(loc.reachable===true||adjacent))return false;
    return (loc.optionsWithIndex??[]).some((option:any)=>taskId===`discover:discovered:interaction:${loc.id}:${loc.x}:${loc.z}:${loc.level??level}:${option.opIndex}`);
  });
}

/** A local interaction is only dispatchable while the fresh pre-dispatch
 * observation still exposes that exact object option. World objects can
 * despawn or change reachability between planning and the next state read. */
export function freshObservedLocAction(state:any,action:any):boolean {
  if(action?.type!=='interactLoc')return true;
  const f=action.fields??{},loc=(state?.nearbyLocs??[]).find((entry:any)=>entry.id===f.locId&&entry.x===f.x&&entry.z===f.z);
  const option=(loc?.optionsWithIndex??[]).find((entry:any)=>entry.opIndex===f.optionIndex);
  const player=state?.player??{},samePlane=Number(loc?.level??player.level??0)===Number(player.level??0);
  const adjacent=samePlane&&Math.max(Math.abs(Number(player.worldX)-Number(loc?.x)),Math.abs(Number(player.worldZ)-Number(loc?.z)))<=1;
  return !!loc&&!!option&&(loc.reachable===true||adjacent);
}
