import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AcquisitionRoute, CatalogItem, CatalogLocation, CatalogProfile, ItemCatalog, Recipe } from './types.ts';

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const readJsonl = <T>(path: string): T[] => readFileSync(path, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as T);

export function loadCatalog(directory: string): ItemCatalog {
  const root = resolve(directory);
  return {
    profile: readJson<CatalogProfile>(resolve(root, 'manifest.json')),
    items: readJsonl<CatalogItem>(resolve(root, 'items.jsonl')),
    routes: readJsonl<AcquisitionRoute>(resolve(root, 'acquisition_routes.jsonl')),
    locations: readJsonl<CatalogLocation>(resolve(root, 'locations.jsonl')),
    recipes: readJsonl<Recipe>(resolve(root, 'recipes.jsonl')),
  };
}

export type CatalogValidation = { errors: string[]; warnings: string[] };

export function validateCatalog(catalog: ItemCatalog): CatalogValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unique = (values: string[], label: string) => {
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) errors.push(`duplicate ${label}: ${value}`);
      seen.add(value);
    }
  };
  unique(catalog.items.map(item => `${item.profileId}:${item.id}`), 'item');
  unique(catalog.routes.map(route => `${route.profileId}:${route.id}`), 'route');
  unique(catalog.locations.map(location => `${location.profileId}:${location.id}`), 'location');
  for (const item of catalog.items) {
    if (!item.provenance.length) errors.push(`item ${item.id} has no provenance`);
    for (const routeId of item.acquisitionRouteIds) if (!catalog.routes.some(route => route.id === routeId)) errors.push(`item ${item.id} references missing route ${routeId}`);
  }
  for (const route of catalog.routes) {
    if (!route.outputs.length) errors.push(`route ${route.id} has no outputs`);
    for (const output of route.outputs) if (!catalog.items.some(item => item.id === output.itemId)) errors.push(`route ${route.id} references missing item ${output.itemId}`);
    for (const locationId of route.locationIds ?? []) if (!catalog.locations.some(location => location.id === locationId)) errors.push(`route ${route.id} references missing location ${locationId}`);
    if (route.evidenceStatus === 'unresolved' && !(route.unresolved?.length)) warnings.push(`unresolved route ${route.id} has no gap explanation`);
  }
  if (catalog.profile.serverConfirmed !== true) warnings.push('catalog profile is not confirmed to match the running server');
  if (catalog.profile.completeness.acquisitionCoverage !== 'complete') warnings.push('acquisition coverage is partial or unknown; agents must not treat absent routes as unobtainable');
  return { errors, warnings };
}

