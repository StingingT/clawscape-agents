import { upstreamRoot } from '../runtime-paths.ts';
// Reviewed guide memory. Guides propose families; local content supplies every
// type ID, level, HP and spawn. No guide coordinate or XP rate is executable.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Tile } from '../navigation/geometry';

export const GUIDE_REVIEW = {
  reviewedAt: '2026-09-07',
  sources: [
    { id: 'melee', url: 'https://oldschool.runescape.wiki/w/Free-to-play_melee_training', hint: 'Early Lumbridge chickens, cows and goblins; equipment and food matter.' },
    { id: 'ranged', url: 'https://www.osrsguide.com/osrs-ranged-guide/', hint: 'Lumbridge animals and goblins, then Barbarian Village and stronger local trials; treat level bands as trial hints.' },
  ],
  excluded: ['Minotaurs, flesh crawlers, ankou and Stronghold routes: absent from this 2004 content', 'Modern items, rates, banking, safespots and unlock assumptions are not imported', 'Giants and other floor/quest routes await verified transitions'],
};
export type Monster = { id: number; symbol: string; name: string; combatLevel: number; hp: number; respawnTicks: number; minSkill: number; source: string };
export type SiteHint = { id: string; name: string; monster: Monster; points: Tile[]; guideIds: string[]; source: string };
export type Catalog = { namespace: string; monsters: Monster[]; sites: SiteHint[]; evidence: string[] };
const definitions = [
  ['aggressive_black_knight',35],
  ['chicken', 1], ['cow', 1], ['goblin', 5], ['goblin_armed', 5], ['goblin_helmet', 5], ['barbarian', 20],
  // These are the first source-verified upgrades after the starter area for
  // Stinger's ranged build. The level is a readiness prerequisite, not a
  // claim that the guide's modern XP bands transfer to this server.
  ['guard1', 25], ['giantspider2', 35],
] as const;
const hints = [
  ['black-knights-fortress','Black Knights north of Dwarven Mine','aggressive_black_knight','m47_54'],
  ['east-chickens', 'Lumbridge east chicken enclosure', 'chicken', 'm50_51'],
  ['fred-chickens', 'Fred farm chickens', 'chicken', 'm49_51'],
  ['east-cows', 'Lumbridge east cattle field', 'cow', 'm50_51'],
  ['windmill-cows', 'Lumbridge west cattle field', 'cow', 'm49_51'],
  ['lumbridge-goblins', 'East Lumbridge goblins', 'goblin', 'm50_50'],
  ['lumbridge-armed-goblins', 'North Lumbridge armed goblins', 'goblin_armed', 'm50_51'],
  ['village-barbarians', 'Barbarian Village ground floor', 'barbarian', 'm48_53'],
  ['source-guards', 'Source-verified guards near Falador', 'guard1', 'm46_51'],
  ['source-giant-spiders', 'Source-verified giant spiders', 'giantspider2', 'm49_60'],
] as const;
// Map NPC entries prove that the monster exists. These are separately
// collision-checked approach tiles, so the navigator does not repeatedly aim
// at a blocked or occupied spawn tile.
const approaches: Record<string, Tile[]> = {
  'source-guards': [{ x: 3003, z: 3319, level: 0 }],
  'source-giant-spiders': [{ x: 3159, z: 3879, level: 0 }],
};
export function mapEntries(contents: string, mapName: string, section: 'NPC' | 'LOC') {
  const [, mx, mz] = /^m(\d+)_(\d+)$/.exec(mapName)!;
  const block = contents.split(`==== ${section} ====`)[1]?.split('====')[0] ?? '';
  return [...block.matchAll(/^(\d+) (\d+) (\d+): (\d+)(?: (\d+))?(?: (\d+))?/gm)].map(m => ({
    level: Number(m[1]), x: Number(mx) * 64 + Number(m[2]), z: Number(mz) * 64 + Number(m[3]),
    id: Number(m[4]), shape: Number(m[5] ?? 0), angle: Number(m[6] ?? 0),
  }));
}
export function loadCatalog(upstream = upstreamRoot()): Catalog {
  const evidence: string[] = [], hash = createHash('sha256');
  const read = (path: string) => { const data = readFileSync(resolve(upstream, path), 'utf8'); hash.update(path).update(data); evidence.push(path); return data; };
  const pack = read('server/content/pack/npc.pack');
  const configPath = 'server/content/scripts/_unpack/225/all.npc';
  const configs = read(configPath);
  const monsters = definitions.map(([symbol, minSkill]): Monster => {
    const id = Number(new RegExp(`^(\\d+)=${symbol}$`, 'm').exec(pack)?.[1]);
    const block = configs.split(`[${symbol}]`)[1]?.split('\n[')[0] ?? '';
    const field = (key: string) => new RegExp(`^${key}=(.+)$`, 'm').exec(block)?.[1]?.trim();
    const name = field('name'), combatLevel = Number(field('vislevel')), hp = Number(field('hitpoints'));
    if (!Number.isInteger(id) || !name || !/op\d=Attack/.test(block) || !(combatLevel > 0 && hp > 0)) throw new Error(`Unsupported catalog monster: ${symbol}`);
    return { id, symbol, name, combatLevel, hp, minSkill, respawnTicks: Number(field('respawnrate') ?? 100), source: `${configPath}#${symbol}` };
  });
  const maps = new Map<string, string>();
  const sites = hints.map(([id, name, symbol, mapName]): SiteHint => {
    const source = `server/content/maps/${mapName}.jm2`;
    if (!maps.has(mapName)) maps.set(mapName, read(source));
    const monster = monsters.find(m => m.symbol === symbol)!;
    const spawns = mapEntries(maps.get(mapName)!, mapName, 'NPC').filter(p => p.id === monster.id && p.level === 0)
      .map(({ x, z, level }) => ({ x, z, level }));
    if (!spawns.length) throw new Error(`Missing source spawns: ${id}`);
    const points = approaches[id] ?? spawns;
    return { id, name, monster, points, source, guideIds: symbol === 'barbarian' || symbol === 'guard1' || symbol === 'giantspider2' ? ['ranged'] : ['melee', 'ranged'] };
  });
  // Map and reviewed contracts scope persisted knowledge; changed content cannot
  // inherit old route/encounter confidence silently.
  read('sdk/collision-data.json');
  hash.update(JSON.stringify({ guides: GUIDE_REVIEW, definitions, hints }));
  return { namespace: `local-274-${hash.digest('hex')}`, monsters, sites, evidence };
}
