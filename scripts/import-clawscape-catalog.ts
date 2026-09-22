#!/usr/bin/env bun
/**
 * Import the source-backed catalog shipped with Joostrothweiler/clawscape.
 *
 * This consumes the server repository's generated wiki plus raw packed item
 * and map records. It deliberately keeps missing semantics visible: a wiki
 * page is evidence of a source record, not proof that a live character can
 * reach or execute the route.
 *
 * Usage:
 *   bun scripts/import-clawscape-catalog.ts --server C:/path/clawscape \
 *     --output data/catalog/clawscape-live --overwrite
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { AcquisitionRoute, CatalogItem, CatalogLocation, CatalogProfile, SourceReference } from '../src/catalog/types.ts';

type Config = { name?: string; category?: string; members?: string; stackable?: string; tradeable?: string; wearpos?: string; dummyitem?: string; iop1?: string; cost?: string };
type NpcDrop = { name: string; quantity?: number; range?: string; rarity: string; source: string };

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const server = resolve(arg('--server', resolve(process.cwd(), '../tmp/clawscape'))!);
const output = resolve(arg('--output', resolve(process.cwd(), 'data/catalog/clawscape-live'))!);
const overwrite = process.argv.includes('--overwrite');
const content = resolve(server, 'upstream/server/content');
const wiki = resolve(server, 'upstream/wiki');
if (!existsSync(content) || !existsSync(wiki)) throw new Error(`Expected server/upstream/server/content and server/upstream/wiki under ${server}`);
if (existsSync(output) && readdirSync(output).length && !overwrite) throw new Error(`Output exists and is non-empty: ${output}. Use --overwrite explicitly.`);
mkdirSync(output, { recursive: true });

const sluggify = (value: string): string => value.toLowerCase().replace(/[']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normalize = (value: string): string => value.toLowerCase().replace(/\(x[\d-]+\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const prettify = (value: string): string => value.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase()).trim();
const read = (path: string): string => readFileSync(path, 'utf8');
const relativeSource = (path: string): string => relative(server, path).replaceAll('\\', '/');
const gitCommit = execFileSync('git', ['-C', server, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceHash = createHash('sha256').update(read(join(content, 'pack', 'obj.pack'))).update(read(join(content, 'pack', 'npc.pack'))).digest('hex');

const provenance = new Map<string, SourceReference>();
const source = (kind: SourceReference['kind'], path: string, note?: string): string => {
  const uri = `file:${relativeSource(path)}`;
  const id = `p-${createHash('sha1').update(uri).digest('hex').slice(0, 12)}`;
  if (!provenance.has(id)) provenance.set(id, { id, kind, uri, revision: gitCommit, path: relativeSource(path), note });
  return id;
};

function parseConfigs(path: string): Map<string, Config> {
  const result = new Map<string, Config>();
  let symbol = '';
  let fields: Config = {};
  const flush = () => { if (symbol) result.set(symbol, { ...(result.get(symbol) ?? {}), ...fields }); };
  for (const raw of read(path).split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) { flush(); symbol = section[1]!; fields = {}; continue; }
    if (!symbol || !line || line.startsWith('//') || line.startsWith('/ ')) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1).trim();
    if (['name', 'category', 'members', 'stackable', 'tradeable', 'wearpos', 'dummyitem', 'iop1', 'cost'].includes(key)) fields[key as keyof Config] = value;
  }
  flush();
  return result;
}

const configs = new Map<string, Config>();
const allObj = join(content, 'scripts/_unpack/225/all.obj');
for (const [symbol, config] of parseConfigs(allObj)) configs.set(symbol, config);
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : path.endsWith('.obj') ? [path] : [];
});
for (const path of walk(join(content, 'scripts'))) {
  if (path.includes(`${join('scripts', '_unpack')}\\`) || path.includes('/_unpack/')) continue;
  for (const [symbol, config] of parseConfigs(path)) configs.set(symbol, { ...(configs.get(symbol) ?? {}), ...config });
}

const itemIds = new Map<string, number>();
for (const line of read(join(content, 'pack/obj.pack')).split(/\r?\n/)) {
  const match = /^(\d+)=(.+)$/.exec(line.trim());
  if (match) itemIds.set(match[2]!, Number(match[1]));
}

const npcIds = new Map<string, number>();
for (const line of read(join(content, 'pack/npc.pack')).split(/\r?\n/)) {
  const match = /^(\d+)=(.+)$/.exec(line.trim());
  if (match) npcIds.set(match[2]!, Number(match[1]));
}

const pageByName = new Map<string, { slug: string; path: string; content: string }>();
for (const file of readdirSync(join(wiki, 'items')).filter(name => name.endsWith('.md'))) {
  const path = join(wiki, 'items', file);
  const title = /^# (.+)$/m.exec(read(path))?.[1]?.trim();
  if (title) pageByName.set(normalize(title), { slug: file.slice(0, -3), path, content: read(path) });
}

const shopPages = new Map<string, { path: string; content: string }>();
for (const file of readdirSync(join(wiki, 'shops')).filter(name => name.endsWith('.md'))) shopPages.set(file.slice(0, -3), { path: join(wiki, 'shops', file), content: read(join(wiki, 'shops', file)) });

const npcPages = new Map<string, { path: string; content: string }>();
for (const file of readdirSync(join(wiki, 'npcs')).filter(name => name.endsWith('.md'))) npcPages.set(file.slice(0, -3), { path: join(wiki, 'npcs', file), content: read(join(wiki, 'npcs', file)) });

const itemsByName = new Map<string, number[]>();
const itemRows: CatalogItem[] = [];
const canonicalSymbols = new Set<string>();
for (const [symbol, id] of itemIds) {
  const config = configs.get(symbol) ?? {};
  const name = config.name || prettify(symbol);
  const classification = symbol.startsWith('cert_') || symbol.startsWith('note_')
    ? 'generated-variant'
    : symbol.startsWith('macro_') || symbol.startsWith('debug_') || symbol.startsWith('test_')
      ? 'admin-test'
      : config.dummyitem === 'inv_only'
        ? 'inactive'
        : config.name
          ? 'active'
          : 'unresolved';
  if (classification === 'active') canonicalSymbols.add(symbol);
  const page = pageByName.get(normalize(name));
  const provenanceIds = [source('repository', join(content, 'pack/obj.pack')), ...(page ? [source('repository', page.path, 'Generated item page from this server repository.')] : [])];
  const item: CatalogItem = {
    profileId: `clawscape-${gitCommit.slice(0, 12)}`,
    id,
    symbol,
    name,
    aliases: [symbol],
    classification,
    availabilityRationale: classification === 'active' ? 'Defined in the server item registry.' : `Registry entry classified as ${classification} from its symbol/config; normal-play acquisition is not assumed.`,
    properties: { members: config.members === 'yes', stackable: config.stackable === 'yes', tradeable: config.tradeable !== 'no', equipment: Boolean(config.wearpos), metadata: { category: config.category ?? null, baseCostGp: config.cost === undefined ? null : Number(config.cost), wearSlot: config.wearpos ?? null } },
    acquisitionRouteIds: [],
    provenance: provenanceIds,
    unresolved: page ? undefined : ['No generated item page exists for this registry entry; acquisition coverage is unresolved.'],
  };
  itemRows.push(item);
  const key = normalize(name);
  const ids = itemsByName.get(key) ?? [];
  ids.push(id); itemsByName.set(key, ids);
}
for (const [name, ids] of itemsByName) {
  if (ids.length > 1) {
    const canonical = ids.find(id => canonicalSymbols.has(itemRows.find(item => item.id === id)?.symbol ?? ''));
    if (canonical !== undefined) for (const item of itemRows.filter(item => item.id === canonical)) item.aliases = [...new Set([...(item.aliases ?? []), name])];
  }
}

const itemById = new Map(itemRows.map(item => [item.id, item]));
const routes: AcquisitionRoute[] = [];
const locations: CatalogLocation[] = [];
const locationIds = new Set<string>();
const profileId = `clawscape-${gitCommit.slice(0, 12)}`;
const addLocation = (location: CatalogLocation) => { if (!locationIds.has(location.id)) { locationIds.add(location.id); locations.push(location); } };
const addRoute = (route: AcquisitionRoute) => {
  routes.push(route);
  for (const output of route.outputs) itemById.get(output.itemId)?.acquisitionRouteIds.push(route.id);
};

// Exact ground-object records from the source maps, including plane and local
// coordinates. This is stronger evidence than a wiki area's prose label.
const maps = join(content, 'maps');
for (const file of readdirSync(maps).filter(name => /^m\d+_\d+\.jm2$/.test(name))) {
  const region = /^m(\d+)_(\d+)\.jm2$/.exec(file)!;
  const regionX = Number(region[1]), regionZ = Number(region[2]);
  const mapPath = join(maps, file), text = read(mapPath), section = text.split('==== OBJ ====')[1]?.split('====')[0] ?? '';
  for (const row of section.split(/\r?\n/)) {
    const match = /^(\d+)\s+(\d+)\s+(\d+):\s*(\d+)\s+(\d+)$/.exec(row.trim());
    if (!match) continue;
    const plane = Number(match[1]), localX = Number(match[2]), localZ = Number(match[3]), itemId = Number(match[4]), quantity = Number(match[5]);
    if (!itemById.has(itemId)) continue;
    const locationId = `ground:${itemId}:${file.slice(0, -4)}:${plane}:${localX}:${localZ}`;
    addLocation({ id: locationId, profileId, label: `${file.slice(0, -4)} ground object`, coordinates: { x: regionX * 64 + localX, z: regionZ * 64 + localZ, plane }, rawCoordinates: { regionX, regionZ, localX, localZ, plane }, anchorKind: 'ground-item', access: { status: 'unknown', notes: ['Source existence is not runtime reachability.'] }, provenance: [source('repository', mapPath)] });
    addRoute({ id: `ground:${itemId}:${file.slice(0, -4)}:${plane}:${localX}:${localZ}`, profileId, method: 'ground-spawn', outputs: [{ itemId, quantity }], locationIds: [locationId], interaction: { action: 'pickup' }, repeatability: 'unknown', evidenceStatus: 'source-verified', provenance: [source('repository', mapPath)], unresolved: ['Respawn timing, loaded-world state and live reachability require runtime verification.'] });
  }
}

const parseQuantity = (text: string): { quantity?: number; range?: string } => {
  const match = /\(x(\d+)(?:-(\d+))?\)/i.exec(text);
  if (!match) return { quantity: 1 };
  return match[2] ? { range: `${match[1]}-${match[2]}` } : { quantity: Number(match[1]) };
};

// Shop and NPC locations are kept by name/anchor when their generated page
// does not expose an explicit plane. The route remains discoverable, but the
// executor must verify the live NPC and path before dispatching.
for (const [name, page] of pageByName) {
  const ids = itemsByName.get(name)?.filter(id => canonicalSymbols.has(itemById.get(id)?.symbol ?? '')) ?? [];
  if (!ids.length) continue;
  const itemSlug = page.slug;
  for (const line of page.content.split(/\r?\n/)) {
    const sold = /^- Sold by: \[([^\]]+)\]\(\.\.\/shops\/([^/)]+)\.md\) for ([\d,]+) gp$/i.exec(line.trim());
    if (!sold) continue;
    const shopName = sold[1]!, shopSlug = sold[2]!, price = Number(sold[3]!.replaceAll(',', ''));
    const shop = shopPages.get(shopSlug);
    const locationId = `shop:${shopSlug}`;
    const coords = shop?.content.match(/^\| \*\*Coordinates\*\* \| \((\d+), (\d+)\) \|$/m);
    addLocation({ id: locationId, profileId, label: shopName, ...(coords ? {} : {}), anchorKind: 'shop', access: { status: 'unknown' }, provenance: [source('repository', shop?.path ?? join(wiki, 'shops', `${shopSlug}.md`))], unresolved: ['Shop page does not provide a plane; live NPC identity, door/access state and reachability require verification.'] });
    const stock = shop?.content.match(new RegExp(`^\\| \\[[^\\]]+\\]\\(\\.\\.\\/items\\/${itemSlug}\\.md\\) \\| (\\d+) \\|`, 'm'));
    for (const id of ids) addRoute({ id: `shop:${id}:${shopSlug}`, profileId, method: 'shop-purchase', outputs: [{ itemId: id, quantity: 1 }], actor: { name: shopName, symbol: shopSlug }, interaction: { action: 'trade', option: 'Trade' }, locationIds: [locationId], costGp: price, lifecycle: { stock: stock ? Number(stock[1]) : null }, repeatability: 'conditional', evidenceStatus: 'source-verified', provenance: [source('repository', page.path), source('repository', shop?.path ?? join(wiki, 'shops', `${shopSlug}.md`))], unresolved: ['Price is source-derived and must be reconciled with a fresh live shop view.', ...(stock ? [] : ['Current stock row was not found in the linked shop page.'])], notes: [`Generated source page lists a buy price of ${price} gp.`] });
  }
}

for (const [npcSlug, page] of npcPages) {
  const npcTitle = /^# (.+)$/m.exec(page.content)?.[1]?.trim() ?? prettify(npcSlug);
  const npcSymbol = npcSlug.replaceAll('-', '_');
  const npcId = npcIds.get(npcSymbol);
  const npcLocationIds: string[] = [];
  const locationSection = page.content.split('## Locations')[1]?.split('## ')[0] ?? '';
  let index = 0;
  for (const row of locationSection.split(/\r?\n/)) {
    const match = /^\| ([^|]+) \| ([^|]+) \| (.+) \|$/.exec(row.trim());
    if (!match || match[1] === 'Area' || match[3] === 'Coordinate samples') continue;
    const coordinates = [...match[3].matchAll(/\((\d+), (\d+)\)/g)];
    const locationId = `npc:${npcSlug}:${index++}`;
    addLocation({ id: locationId, profileId, label: `${npcTitle} at ${match[1].trim()}`, anchorKind: 'npc-anchor', access: { status: 'unknown' }, provenance: [source('repository', page.path)], unresolved: ['NPC page does not supply a plane for its coordinate samples.', ...(coordinates.length ? [] : ['No coordinate sample was supplied.'])] });
    npcLocationIds.push(locationId);
  }
  const drops: NpcDrop[] = [];
  for (const line of page.content.split(/\r?\n/)) {
    const always = /^Always drops: (.+?)(?:\s+\(x(\d+)\))?$/i.exec(line.trim());
    if (always) drops.push({ name: always[1]!, quantity: Number(always[2] ?? 1), rarity: 'Always', source: page.path });
    const row = /^\| (.+?) \| ([^|]+) \|$/.exec(line.trim());
    if (row && row[1] !== 'Item') {
      const itemText = row[1]!.trim(), quantity = parseQuantity(itemText);
      drops.push({ name: itemText.replace(/\s*\(x[\d-]+\)/i, '').trim(), quantity: quantity.quantity, range: quantity.range, rarity: row[2]!.trim(), source: page.path });
    }
  }
  for (const [dropIndex, drop] of drops.entries()) {
    const ids = itemsByName.get(normalize(drop.name))?.filter(id => canonicalSymbols.has(itemById.get(id)?.symbol ?? '')) ?? [];
    for (const itemId of ids) {
      const suffix = `${npcSlug}:${dropIndex}:${normalize(drop.name).replaceAll(' ', '-')}:${drop.quantity ?? drop.range ?? 'unknown'}`;
      addRoute({ id: `drop:${itemId}:${suffix}`, profileId, method: 'monster-drop', outputs: [{ itemId, ...(drop.quantity ? { quantity: drop.quantity } : {}) }], actor: { ...(npcId === undefined ? {} : { id: npcId }), symbol: npcSymbol, name: npcTitle }, interaction: { action: 'death-drop', handler: relativeSource(page.path) }, locationIds: npcLocationIds, repeatability: 'repeatable', evidenceStatus: 'source-verified', provenance: [source('repository', page.path), source('repository', join(content, 'pack/npc.pack'))], unresolved: ['Live encounter safety, ownership, NPC movement and path reachability require runtime verification.', ...(drop.range ? [`Drop quantity range ${drop.range} was preserved as an unresolved range.`] : [])], notes: [`Source rarity: ${drop.rarity}`] });
    }
  }
}

for (const item of itemRows) item.acquisitionRouteIds = [...new Set(item.acquisitionRouteIds)];
const profile: CatalogProfile = {
  id: profileId,
  repository: 'https://github.com/Joostrothweiler/clawscape',
  branch: 'main',
  commit: gitCommit,
  serverConfirmed: false,
  registryHash: sourceHash,
  completeness: { itemRegistry: 'complete', acquisitionCoverage: 'partial', runtimeValidatedRoutes: 0 },
  provenance: [source('repository', join(content, 'pack/obj.pack'), 'Authoritative item registry in the Clawscape server checkout.'), source('repository', join(wiki, 'generate-items.ts'), 'Server repository generator used to produce the item pages.')],
  unresolved: ['The running world must still be checked against this checkout and source profile.', 'Quest rewards, transformations, initial loadouts, dynamic services and some gathering semantics are not fully extracted from the generated wiki.', 'Generated wiki rows are source evidence; routes still require live observation and CLI verification.'],
};

const writeJsonl = (name: string, rows: unknown[]) => writeFileSync(join(output, name), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
writeFileSync(join(output, 'manifest.json'), JSON.stringify(profile, null, 2) + '\n', 'utf8');
writeJsonl('items.jsonl', itemRows);
writeJsonl('acquisition_routes.jsonl', routes);
writeJsonl('locations.jsonl', locations);
writeJsonl('recipes.jsonl', []);
writeJsonl('requirements.jsonl', []);
writeJsonl('provenance.jsonl', [...provenance.values()]);
writeJsonl('unresolved.jsonl', profile.unresolved.map((description, index) => ({ id: `profile-gap-${index + 1}`, kind: 'coverage', status: 'unresolved', description })));
writeFileSync(join(output, 'coverage_report.md'), `# Clawscape live-source catalog\n\n- Repository: ${profile.repository}\n- Commit: ${gitCommit}\n- Item registry records: ${itemRows.length}\n- Acquisition routes: ${routes.length}\n- Locations: ${locations.length}\n- Runtime-validated routes: 0\n- Status: partial; source-backed, not runtime-validated\n\nThe catalog includes exact ground-map object coordinates and source-derived shop/NPC routes. The absence of a route is not evidence that an item is unobtainable.\n`, 'utf8');
writeFileSync(join(output, 'overview.md'), `# Clawscape item acquisition overview\n\nThis profile is generated from the Clawscape checkout at commit ${gitCommit}. Search items.jsonl by item ID, symbol or name, then follow its acquisitionRouteIds. Route evidence and unresolved fields are in acquisition_routes.jsonl; never dispatch a route without fresh observation and reachability verification.\n\nRegistry records: ${itemRows.length}. Indexed routes: ${routes.length}. Runtime-validated routes: 0.\n`, 'utf8');
console.log(JSON.stringify({ output, repository: profile.repository, commit: gitCommit, items: itemRows.length, routes: routes.length, locations: locations.length, runtimeValidatedRoutes: 0, status: 'partial-source-backed' }, null, 2));
