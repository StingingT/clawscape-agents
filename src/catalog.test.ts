import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { loadCatalog, validateCatalog } from './catalog/io.ts';
import { expandRecipeDependencies, findItem, getAcquisitionOptions, getCatalogCoverage, getNearestReachableSource, reportObservation } from './catalog/query.ts';
import type { ItemCatalog } from './catalog/types.ts';

const catalog = loadCatalog(fileURLToPath(new URL('../data/catalog', import.meta.url)));

describe('item acquisition catalog', () => {
  test('loads the source-backed bootstrap and keeps its partial status visible', () => {
    const item = findItem(catalog, 'bronze_pickaxe');
    expect(item?.id).toBe(1265);
    expect(catalog.profile.serverConfirmed).toBe(false);
    expect(getCatalogCoverage(catalog).acquisitionCoverage).toBe('partial');
  });

  test('does not make a source lead executable without evidence and prerequisites', () => {
    const options = getAcquisitionOptions(catalog, 1265, { carriedCoins: 500, skills: { mining: 1 } }, 1, { maxRisk: 'safe' });
    expect(options.some(option => option.route.id === 'ground-bronze-pickaxe-3229-3215-0')).toBe(true);
    expect(options.find(option => option.route.id === 'shop-bronze-pickaxe-axeshop')?.feasible).toBe(false);
    expect(options.find(option => option.route.id === 'shop-bronze-pickaxe-axeshop')?.reason).toMatch(/evidence status|unknown|missing/);
  });

  test('requires explicit reachability instead of trusting coordinates', () => {
    const unknown = getNearestReachableSource(catalog, 'ground-bronze-pickaxe-3229-3215-0', { x: 3220, z: 3215, plane: 0 }, {});
    expect(unknown.status).toBe('unknown');
    const reachable = getNearestReachableSource(catalog, 'ground-bronze-pickaxe-3229-3215-0', { x: 3220, z: 3215, plane: 0 }, { reachableRouteIds: ['ground-bronze-pickaxe-3229-3215-0'] });
    expect(reachable.status).toBe('reachable');
  });

  test('recipe expansion distinguishes inventory, bank and unresolved sources', () => {
    const fixture: ItemCatalog = {
      ...catalog,
      items: [...catalog.items, { profileId: catalog.profile.id, id: 9999, symbol: 'test_product', name: 'Test product', classification: 'active', availabilityRationale: 'test', acquisitionRouteIds: [], provenance: ['test'] }],
      recipes: [{ id: 'test-recipe', profileId: catalog.profile.id, productItemId: 9999, outputQuantity: 1, inputs: [{ itemId: 314, quantity: 2 }], evidenceStatus: 'source-verified', provenance: ['test'] }],
    };
    const deps = expandRecipeDependencies(fixture, 9999, 1, { bank: [{ id: 314, name: 'Feather', count: 1 }] });
    expect(deps.source).toBe('recipe');
    expect(deps.children?.[0]?.missing).toBe(1);
  });

  test('learning observations are returned as separate evidence records', () => {
    const observation = reportObservation({ profileId: catalog.profile.id, routeId: 'ground-bronze-pickaxe-3229-3215-0', at: 10, context: 'plane-0', outcome: 'failure', evidence: ['no pickup after verified arrival'] });
    expect(observation.id).toContain('ground-bronze-pickaxe-3229-3215-0');
    expect(catalog.routes.find(route => route.id === observation.routeId)?.evidenceStatus).toBe('source-verified');
  });

  test('bootstrap records pass structural validation', () => {
    const result = validateCatalog(catalog);
    expect(result.errors).toEqual([]);
  });
});
