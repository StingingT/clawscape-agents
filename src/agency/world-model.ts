import type { Domain, Facts, Identity, Memory, Method, Observation, Opportunity } from './types.ts';

export type LiveState = Record<string, any>;
export type TaskKind = 'food' | 'ammunition' | 'equipment' | 'bank' | 'combat' | 'production' | 'gathering' | 'exploration';
export type Route = { id: string; x: number; z: number; level: number; evidence: string };
export type Task = { id: string; kind: TaskKind; skill?: string; route?: Route };
export type Policy = {
  reserveCoins: number; maxLossGp: number; maxDeaths: number; maxDurationMs: number;
  foodTarget: number; ammoTarget: number;
  /** Optional owner-audited replacement-loss ceiling for the carried kit. Missing is UNKNOWN, not zero. */
  combatLossBoundGp?: number;
};
export const defaultPolicy: Policy = {
  reserveCoins: 25, maxLossGp: 100, maxDeaths: 1, maxDurationMs: 30 * 60_000,
  foodTarget: 8, ammoTarget: 50,
};
export type Catalogue = { view: Observation; opportunities: Opportunity[]; methods: Method[]; tasks: Map<string, Task> };
export type Knowledge = { bank: any[]; bankCheckedAt: number; routes: Record<string, Route>; visited: Record<string, string> };
export const emptyKnowledge = (): Knowledge => ({ bank: [], bankCheckedAt: 0, routes: {}, visited: {} });
const quantity = (i: any) => Number(i.count ?? 1);
const edible = (i: any) => (i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(String(o.text)));
export const cash = (items: any[]) => items.filter(i => Number(i.id) === 995 || /^coins$/i.test(String(i.name)))
  .reduce((n, i) => n + quantity(i), 0);
export const food = (items: any[]) => items.filter(edible).reduce((n, i) => n + quantity(i), 0);
export const arrows = (items: any[]) => items.filter(i => /^(bronze|iron|steel|mithril|adamant|rune) arrows?$/i.test(String(i.name)))
  .reduce((n, i) => n + quantity(i), 0);
const XP = (state: LiveState, skill: string) => { const row=(state.skills??[]).find((s:any)=>String(s.name).toLowerCase()===skill); return Number(row?.experience??row?.xp??0); };
const base = (state: LiveState, skill: string) => Number((state.skills ?? []).find((s: any) => String(s.name).toLowerCase() === skill)?.baseLevel
  ?? (state.skills ?? []).find((s: any) => String(s.name).toLowerCase() === skill)?.level ?? 1);
const at = (state: LiveState, route: Route) => Number(state.player?.level) === route.level &&
  Math.max(Math.abs(Number(state.player?.worldX) - route.x), Math.abs(Number(state.player?.worldZ) - route.z)) <= 1;

/** Actual personal state only. Duplicate unstackable inventory entries are summed. */
export function observeFacts(state: LiveState, knowledge: Knowledge): Facts {
  const inv = state.inventory ?? [], equipped = state.equipment ?? [];
  const bank = state.bank?.isOpen === true ? state.bank.items ?? [] : knowledge.bank;
  const facts: Facts = { hp: Number(state.player?.hp ?? 0), food: food(inv), arrows: arrows([...inv, ...equipped]),
    coins: cash(inv), 'free-slots': Math.max(0, Number(state.capacity??28) - inv.length),
    weapon: Number(equipped.some((i:any) => /sword|scimitar|bow|staff|mace|dagger|warhammer|battleaxe/i.test(String(i.name)))),
    axe: Number([...inv,...equipped].some((i:any) => / axe$/i.test(String(i.name)) && !/pickaxe|battleaxe/i.test(String(i.name)))),
    'xp:production': ['smithing','fletching','crafting'].reduce((n,k) => n + XP(state,k), 0),
    'xp:gathering': ['woodcutting','mining','fishing'].reduce((n,k) => n + XP(state,k), 0) };
  for (const s of state.skills ?? []) {
    const key = String(s.name).toLowerCase();
    facts['xp:' + key] = Number(s.experience ?? s.xp ?? 0);
    facts['level:' + key] = Number(s.baseLevel ?? s.level ?? 1);
  }
  for (const i of [...inv,...equipped,...bank]) facts['owned:' + i.id] = (facts['owned:' + i.id] ?? 0) + quantity(i);
  for (const [id] of Object.entries(knowledge.visited)) facts['visited:' + id] = 1;
  return facts;
}

/** Moving by a tile or consuming food must not reset learned method performance. */
export function capabilityContext(state: LiveState): string {
  return JSON.stringify([
    (state.skills ?? []).map((s:any) => [String(s.name).toLowerCase(), Math.floor(Number(s.baseLevel ?? s.level ?? 1) / 10)]).sort(),
    (state.equipment ?? []).map((i:any) => [Number(i.slot ?? -1), Number(i.id)]).sort((a:number[], b:number[]) => a[0]! - b[0]!),
    [...new Set([...(state.inventory??[]),...(state.equipment??[])].filter((i:any)=>/axe$|pickaxe$|fishing net|knife|tinderbox|hammer/i.test(String(i.name))).map((i:any)=>Number(i.id)))].sort(),
    Number(state.player?.level ?? 0),
  ]);
}

export function observeKnowledge(state: LiveState, k: Knowledge, now: number, seedRoutes: Route[] = []): void {
  if (state.bank?.isOpen === true && Array.isArray(state.bank.items)) { k.bank = structuredClone(state.bank.items); k.bankCheckedAt = now; }
  for (const r of seedRoutes) if (Number.isInteger(r.x) && Number.isInteger(r.z) && Number.isInteger(r.level)) k.routes[r.id] ??= r;
  for (const r of Object.values(k.routes)) if (at(state, r)) k.visited[r.id] = `own-position:${state.player?.lifeId}:${state.tick}`;
  // Frontier service/resource locations are recorded individually, never copied from another character's save.
  for (const loc of state.nearbyLocs ?? []) {
    if (!Number.isInteger(loc.x) || !Number.isInteger(loc.z) || loc.reachable !== true) continue;
    const plane = Number(loc.level ?? state.player?.level ?? 0), id = `observed:${loc.id}:${loc.x}:${loc.z}:${plane}`;
    if (Object.keys(k.routes).length >= 1024 && !k.routes[id]) continue;
    k.routes[id] ??= { id, x:loc.x, z:loc.z, level:plane, evidence:`own-object:${state.player?.lifeId}:${state.tick}:${loc.name}` };
  }
}

/** Goals are built from needs and observations BEFORE a low-level candidate is requested. */
export function buildCatalogue(identity: Identity, state: LiveState, k: Knowledge, policy: Policy,
  supported: TaskKind[], memory: Memory, now = Date.now()): Catalogue {
  const facts = observeFacts(state, k), tasks = new Map<string, Task>(), methods: Method[] = [], opportunities: Opportunity[] = [];
  const evidence = [`own-state:${state.player?.lifeId}:${state.tick}`];
  const add = (task: Task, domain: Domain, fact: string, target: number, delta: number,
    reason: string, source: Opportunity['source'], prerequisites: Method['prerequisites'] = [], risk: Method['risk'] = 'safe') => {
    if (!supported.includes(task.kind)) return;
    tasks.set(task.id, task);
    const samples=memory.reviews.filter(r=>r.result==='success'&&r.goal.id===task.id&&r.goal.context===capabilityContext(state)).slice(-5);
    const measuredSpend=samples.length?samples.reduce((n,r)=>n+r.goal.spentGp,0)/samples.length:0;
    // Before a completed trip exists, zero means no PRE-AUTHORIZED purchase;
    // each actual purchase must still be quoted and charged at dispatch.
    methods.push({ id:task.id, capability:task.kind, domain, effects:{[fact]:delta}, prerequisites,
      costGp:measuredSpend, lossBoundGp:risk === 'bounded' ? policy.combatLossBoundGp ?? 0 : 0,
      durationMs:task.kind === 'exploration' && task.route ? Math.max(2_000,(Math.abs(Number(state.player?.worldX)-task.route.x)+Math.abs(Number(state.player?.worldZ)-task.route.z))*600) : 30_000, risk });
    if ((facts[fact] ?? 0) < target) opportunities.push({ id:task.id, domain, target:{fact,minimum:target}, reason,
      evidence:task.route ? [task.route.evidence] : evidence, source });
  };
  add({id:'supply-food',kind:'food'}, 'gathering', 'food', policy.foodTarget, policy.foodTarget,
    'Replenish cooked food for sustainable trips; bank and cooking actions are preparation, not the goal.', 'need');
  if (/bow/i.test(String(state.combatStyle?.weaponName)) || arrows(state.inventory ?? []) > 0)
    add({id:'supply-ammunition',kind:'ammunition'},'crafting','arrows',policy.ammoTarget,policy.ammoTarget,
      'Maintain a compatible ammunition reserve before another ranged trial.', 'need');
  add({id:'equip-usable-weapon',kind:'equipment'},'combat','weapon',1,1,
    'Equip a personally owned usable weapon before attempting combat.', 'need');
  add({id:'free-inventory-space',kind:'bank'},'gathering','free-slots',4,24,
    'Store surplus while retaining tools and essential supplies.', 'need');
  // Different skills are intentional opportunities with reasons. No permanent role-based level cap.
  const observedStyles=(state.combatStyle?.styles??[]).flatMap((s:any)=>s.trainsSkills??[]).map((n:any)=>String(n).toLowerCase());
  const skills = [...new Set<string>(observedStyles.filter((n:string)=>['attack','strength','defence','ranged','magic'].includes(n)))];
  for (const skill of skills) if (base(state,skill) < 99) {
    const current = facts['xp:'+skill] ?? 0;
    const reason = skill === 'defence'
      ? 'Develop Defence to support longer, safer encounters rather than remain permanently locked to the initial role.'
      : `Improve ${skill} through a bounded encounter trial and compare its observed costs.`;
    add({id:'train-'+skill,kind:'combat',skill},'combat','xp:'+skill,Math.floor(current/100)*100+100,100,reason,'collection',
      [{fact:'food',minimum:Math.min(3,policy.foodTarget)},{fact:'weapon',minimum:1},
       ...(/bow/i.test(String(state.combatStyle?.weaponName)) ? [{fact:'arrows',minimum:15}] : [])],
      policy.combatLossBoundGp === undefined ? 'unknown' : 'bounded');
  }
  add({id:'production-batch',kind:'production'},'crafting','xp:production',Math.floor(facts['xp:production']!/100)*100+100,100,
    'Complete a bounded production batch, obtaining the inputs through the supported production routine.', 'collection');
  add({id:'gathering-batch',kind:'gathering'},'gathering','xp:gathering',Math.floor(facts['xp:gathering']!/100)*100+100,100,
    'Measure a complete gathering batch as an alternative to my previous activities.', 'collection', [{fact:'free-slots',minimum:2}]);
  for (const route of Object.values(k.routes).filter(r => r.level === Number(state.player?.level ?? 0) && !k.visited[r.id]).slice(0,64))
    add({id:'survey:'+route.id,kind:'exploration',route},'exploration','visited:'+route.id,1,1,
      'Visit a sourced lead and verify it personally; path assessment and arrival are required.', 'frontier');
  const completed=memory.reviews.filter(r=>r.result==='success').slice(-5);
  if(completed.length===5 && !completed.some(r=>r.goal.domain==='exploration') && facts.food!>=Math.min(3,policy.foodTarget)) {
    // A bounded survey periodically competes with training. It still needs a
    // sourced destination, a safe route and a complete affordable plan.
    for(const g of opportunities)if(g.source==='frontier')g.source='unlock';
  }
  const view: Observation = { ...identity, at:now, facts, context:capabilityContext(state),
    budget:{spendableGp:Math.max(0,cash(state.inventory??[])-policy.reserveCoins),maxLossGp:policy.maxLossGp,
      maxDeaths:policy.maxDeaths,maxDurationMs:policy.maxDurationMs}, capabilities:[...new Set(methods.map(m=>m.capability))] };
  // Completed/poor trials affect later choices through the Director's method memory and cooldowns.
  return {view,opportunities,methods,tasks};
}
