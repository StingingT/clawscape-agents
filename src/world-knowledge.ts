export type Json = Record<string, unknown>;

export type GuideLead = {
  item: string;
  sources: string[];
  likelySources: string[];
  status: 'guide-lead';
};

// These are research leads, not private-server truth. The controller only
// acts on a lead after the matching NPC/location/item is visible in Clawscape.
export const RUNE_AND_AMMO_LEADS: GuideLead[] = [
  {
    item: 'Rune essence',
    likelySources: ['Rune essence mine via Aubury or Sedridor', 'some monster drop tables'],
    sources: ['https://oldschool.runescape.wiki/w/Rune_essence_mine', 'https://oldschool.runescape.wiki/w/Mining_f2p_guide'],
    status: 'guide-lead',
  },
  {
    item: 'Air and mind runes',
    likelySources: ['air/mind altars', 'low-level monster drops'],
    sources: ['https://oldschool.runescape.wiki/w/Transcript:Magic_combat_tutor'],
    status: 'guide-lead',
  },
  {
    item: 'Iron arrows',
    likelySources: ['Minotaurs and other early ranged-training monsters', 'shops'],
    sources: ['https://oldschool.runescape.wiki/w/Money_making_f2p_ironman'],
    status: 'guide-lead',
  },
  {
    item: 'Steel and rune arrows',
    likelySources: ['higher-level monster/rare drop tables', 'shops or fletching'],
    sources: ['https://oldschool.runescape.wiki/w/Drop_table'],
    status: 'guide-lead',
  },
];

export const GUIDE_DROP_MONSTERS: Record<string, string[]> = {
  'air and mind runes': ['imp', 'goblin'],
  'iron arrows': ['minotaur'],
  'steel and rune arrows': [],
  'rune essence': ['imp', 'minotaur', 'ankou', 'catablepon'],
};

export function guideDropMonsterNames(): string[] {
  return [...new Set(Object.values(GUIDE_DROP_MONSTERS).flat())];
}

export function knowledgeSummary(role: string, build: string, learning: Json | undefined): Json {
  const observedDrops = learning?.observedDrops;
  return {
    sourcePolicy: 'OSRS guide leads are hypotheses; require live Clawscape evidence before farming',
    runeEssence: role === 'economy' ? 'After Rune Mysteries, locate Aubury/Sedridor, use the teleport, identify the essence mine, and record the mining action.' : 'Maintain a rune/arrow supply plan and record observed combat drops.',
    rangedMagic: build === 'ranged-magic' ? 'Prefer a verified local monster that drops arrows/runes, while retaining shop and self-fletching fallbacks.' : undefined,
    observedDrops: observedDrops ?? {},
    leads: RUNE_AND_AMMO_LEADS.map((lead) => ({ item: lead.item, likelySources: lead.likelySources, status: lead.status })),
  };
}

function optionIndex(entity: Json | undefined, pattern: RegExp): number | undefined {
  const options = Array.isArray(entity?.optionsWithIndex) ? entity.optionsWithIndex as Json[] : [];
  const option = options.find((candidate) => pattern.test(String(candidate.text ?? '')));
  return typeof option?.opIndex === 'number' ? option.opIndex : undefined;
}

function distance(state: Json, point: { x: number; z: number }): number {
  const player = (state.player ?? {}) as Json;
  return Math.hypot(Number(player.worldX) - point.x, Number(player.worldZ) - point.z);
}

// Deliberately observation-driven: no action is emitted for an unverified
// altar/mine/NPC. The route is only a survey route and must be followed by a
// fresh observation before an interaction is attempted.
export function runeDiscoveryCandidates(state: Json, route: { x: number; z: number }, complete: boolean, probeDue: boolean): Json[] {
  if (!complete || !probeDue || (Array.isArray(state.inventory) && state.inventory.length >= 28) || state.bank && (state.bank as Json).isOpen === true || state.shop && (state.shop as Json).isOpen === true) return [];
  const npcs = Array.isArray(state.nearbyNpcs) ? state.nearbyNpcs as Json[] : [];
  const locs = Array.isArray(state.nearbyLocs) ? state.nearbyLocs as Json[] : [];
  const aubury = npcs.find((npc) => npc.reachable === true && /aubury|sedridor/i.test(String(npc.name ?? '')));
  const teleport = optionIndex(aubury, /teleport|essence mine/i);
  if (aubury && typeof aubury.index === 'number' && teleport !== undefined) {
    return [{ id: `rune-learning-teleport-${aubury.index}`, type: 'interactNpc', fields: { npcIndex: aubury.index, optionIndex: teleport, reason: 'verify the guide route to the Rune Essence Mine' }, waitTicks: 4 }];
  }
  const essenceMine = locs.find((loc) => loc.reachable === true && /essence|rune rock/i.test(String(loc.name ?? '')));
  const mine = optionIndex(essenceMine, /mine/i);
  if (essenceMine && mine !== undefined && typeof essenceMine.x === 'number' && typeof essenceMine.z === 'number' && typeof essenceMine.id === 'number') {
    return [{ id: `rune-learning-mine-${essenceMine.id}-${essenceMine.x}-${essenceMine.z}`, type: 'interactLoc', fields: { x: essenceMine.x, z: essenceMine.z, locId: essenceMine.id, optionIndex: mine, reason: 'learn and verify rune essence mining' }, waitTicks: 5 }];
  }
  const altar = locs.find((loc) => loc.reachable === true && /altar/i.test(String(loc.name ?? '')));
  const craft = optionIndex(altar, /craft|enter/i);
  const essence = (Array.isArray(state.inventory) ? state.inventory as Json[] : []).some((item) => /rune essence/i.test(String(item.name ?? '')));
  if (essence && altar && craft !== undefined && typeof altar.x === 'number' && typeof altar.z === 'number' && typeof altar.id === 'number') {
    return [{ id: `rune-learning-altar-${altar.id}-${altar.x}-${altar.z}`, type: 'interactLoc', fields: { x: altar.x, z: altar.z, locId: altar.id, optionIndex: craft, reason: 'verify rune crafting at an observed altar' }, waitTicks: 5 }];
  }
  if (distance(state, route) > 10) {
    return [{ id: 'rune-learning-travel-aubury', type: 'walkTo', fields: { ...route, running: true, reason: 'survey the guide-recommended essence route' }, waitTicks: 4 }];
  }
  return [{ id: 'rune-learning-scan', type: 'scanNearbyLocs', fields: { radius: 30, reason: 'refresh evidence for mine/altar discovery' }, waitTicks: 3 }];
}

export function dropLearningCandidates(state: Json, build: string, allowCombatProbe=false): Json[] {
  if (build !== 'ranged-magic') return [];
  const ground = Array.isArray(state.groundItems) ? state.groundItems as Json[] : [];
  const pickup = ground.find((item) => item.reachable === true && /rune|arrow/i.test(String(item.name ?? '')) && typeof item.x === 'number' && typeof item.z === 'number' && typeof item.id === 'number' && distance(state,{x:item.x,z:item.z})<=2);
  if (pickup) return [{ id: `learn-drop-pickup-${pickup.id}-${pickup.x}-${pickup.z}`, type: 'pickupItem', fields: { x: pickup.x, z: pickup.z, itemId: pickup.id, reason: 'collect and record a verified rune/arrow drop' }, waitTicks: 2 }];
  // A local guide lead is not a standing order to abandon a training trip.
  // The controller explicitly grants a bounded probe only at a goal boundary.
  if(!allowCombatProbe)return [];
  const player = (state.player ?? {}) as Json;
  const combatLevel = Number(player.combatLevel ?? 1);
  const names = guideDropMonsterNames();
  const target = (Array.isArray(state.nearbyNpcs) ? state.nearbyNpcs as Json[] : []).find((npc) =>
    npc.reachable === true && npc.inCombat !== true && typeof npc.index === 'number' &&
    Number(npc.combatLevel ?? 1) <= combatLevel + 8 && names.some((name) => new RegExp(`^${name}$`, 'i').test(String(npc.name ?? ''))));
  const attack = optionIndex(target, /attack/i);
  if (target && attack !== undefined) return [{ id: `learn-drop-target-${target.index}`, type: 'interactNpc', fields: { npcIndex: target.index, optionIndex: attack, reason: 'trial a guide-listed local rune/arrow drop source and measure it' }, waitTicks: 4 }];
  return [];
}

export function recordObservedDrops(learning: Json, before: Json, after: Json, actionId = 'unknown'): void {
  const beforeItems = Array.isArray(before.inventory) ? before.inventory as Json[] : [];
  const afterItems = Array.isArray(after.inventory) ? after.inventory as Json[] : [];
  const beforeCounts = new Map(beforeItems.map((item) => [String(item.name ?? ''), Number(item.count ?? 1)]));
  const observed = (learning.observedDrops ??= {}) as Json;
  const acquisitions = (learning.acquisitions ??= []) as Json[];
  const source = /^learn-drop-pickup-/.test(actionId) ? 'ground-pickup' :
    /^buy-/.test(actionId) ? 'purchase' : /^bank-/.test(actionId) ? 'withdrawal-or-bank' :
    /^fletch-|^craft-|^smith-/.test(actionId) ? 'crafted' : 'unknown';
  for (const item of afterItems) {
    const name = String(item.name ?? '');
    const count = Number(item.count ?? 1);
    if (/rune|arrow/i.test(name) && count > (beforeCounts.get(name) ?? 0)) {
      const delta = count - (beforeCounts.get(name) ?? 0);
      observed[name] = Number(observed[name] ?? 0) + delta;
      acquisitions.push({ item: name, count: delta, source, actionId, at: Date.now() });
    }
  }
}
