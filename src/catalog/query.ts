import type {
  AcquisitionOption,
  AcquisitionRoute,
  AgentInventoryRow,
  AgentState,
  CatalogItem,
  CatalogObservation,
  DependencyNode,
  ItemCatalog,
  ReachabilityContext,
  ReachableSource,
  Requirement,
  RequirementExplanation,
  RoutePolicy,
} from './types.ts';

const normalize = (value: unknown): string => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/s$/, '');

const itemCount = (rows: AgentInventoryRow[] | undefined, item: CatalogItem): number =>
  (rows ?? []).filter(row => row.id === item.id || normalize(row.name) === normalize(item.name) || (item.aliases ?? []).some(alias => normalize(row.name) === normalize(alias)))
    .reduce((total, row) => total + Math.max(0, Number(row.count ?? 0)), 0);

const hasContainerItem = (state: AgentState, item: CatalogItem, quantity: number, container: 'inventory' | 'bank' | 'either' = 'inventory'): boolean => {
  const inventory = itemCount(state.inventory, item);
  const bank = itemCount(state.bank, item);
  if (container === 'bank') return bank >= quantity;
  if (container === 'either') return inventory + bank >= quantity;
  return inventory >= quantity;
};

const valueForFact = (state: AgentState, fact: string): number | string | boolean | undefined =>
  state.facts?.[fact] ?? state.flags?.[fact] ?? state.skills?.[fact];

function explainRequirement(requirement: Requirement | undefined, state: AgentState, catalog: ItemCatalog): RequirementExplanation {
  if (!requirement) return { satisfied: true, missing: [], unknown: [] };
  if ('all' in requirement) {
    const parts = requirement.all.map(part => explainRequirement(part, state, catalog));
    return { satisfied: parts.every(part => part.satisfied), missing: parts.flatMap(part => part.missing), unknown: parts.flatMap(part => part.unknown) };
  }
  if ('any' in requirement) {
    const parts = requirement.any.map(part => explainRequirement(part, state, catalog));
    const satisfied = parts.find(part => part.satisfied);
    if (satisfied) return satisfied;
    return { satisfied: false, missing: parts.flatMap(part => part.missing), unknown: parts.flatMap(part => part.unknown) };
  }
  if ('skill' in requirement) {
    const current = state.skills?.[requirement.skill];
    if (current === undefined) return { satisfied: false, missing: [], unknown: [`skill ${requirement.skill} >= ${requirement.level}`] };
    return current >= requirement.level
      ? { satisfied: true, missing: [], unknown: [] }
      : { satisfied: false, missing: [`skill ${requirement.skill} >= ${requirement.level} (current ${current})`], unknown: [] };
  }
  if ('itemId' in requirement || 'itemName' in requirement) {
    const item = 'itemId' in requirement
      ? catalog.items.find(candidate => candidate.id === requirement.itemId)
      : catalog.items.find(candidate => normalize(candidate.name) === normalize(requirement.itemName) || (candidate.aliases ?? []).some(alias => normalize(alias) === normalize(requirement.itemName)));
    if (!item) return { satisfied: false, missing: [], unknown: [`item definition ${'itemId' in requirement ? requirement.itemId : requirement.itemName}`] };
    const container = requirement.container ?? 'inventory';
    return hasContainerItem(state, item, requirement.quantity, container)
      ? { satisfied: true, missing: [], unknown: [] }
      : { satisfied: false, missing: [`${requirement.quantity} x ${item.name} in ${container}`], unknown: [] };
  }
  if ('coins' in requirement) {
    const total = (requirement.container === 'bank' ? state.bankCoins : requirement.container === 'either' ? (state.carriedCoins ?? 0) + (state.bankCoins ?? 0) : state.carriedCoins) ?? 0;
    if (state.carriedCoins === undefined && state.bankCoins === undefined) return { satisfied: false, missing: [], unknown: [`${requirement.coins} coins`] };
    return total >= requirement.coins
      ? { satisfied: true, missing: [], unknown: [] }
      : { satisfied: false, missing: [`${requirement.coins} coins (current ${total})`], unknown: [] };
  }
  if ('quest' in requirement) {
    const value = state.quests?.[requirement.quest];
    if (value === undefined) return { satisfied: false, missing: [], unknown: [`quest ${requirement.quest}${requirement.stage === undefined ? '' : ` stage ${requirement.stage}`}`] };
    const ok = requirement.stage === undefined ? value === true || Number(value) > 0 : Number(value) >= requirement.stage;
    return ok ? { satisfied: true, missing: [], unknown: [] } : { satisfied: false, missing: [`quest ${requirement.quest}${requirement.stage === undefined ? '' : ` stage ${requirement.stage}`}`], unknown: [] };
  }
  if ('flag' in requirement) {
    const value = state.flags?.[requirement.flag];
    if (value === undefined) return { satisfied: false, missing: [], unknown: [`flag ${requirement.flag}`] };
    const ok = requirement.value === undefined || value === requirement.value;
    return ok ? { satisfied: true, missing: [], unknown: [] } : { satisfied: false, missing: [`flag ${requirement.flag}=${String(requirement.value)}`], unknown: [] };
  }
  if ('fact' in requirement) {
    const value = valueForFact(state, requirement.fact);
    if (value === undefined) return { satisfied: false, missing: [], unknown: [`fact ${requirement.fact}`] };
    const minimumOk = requirement.minimum === undefined || Number(value) >= requirement.minimum;
    const equalsOk = requirement.equals === undefined || value === requirement.equals;
    return minimumOk && equalsOk
      ? { satisfied: true, missing: [], unknown: [] }
      : { satisfied: false, missing: [`fact ${requirement.fact}`], unknown: [] };
  }
  return { satisfied: false, missing: [], unknown: ['unsupported requirement shape'] };
}

const methodRisk = (route: AcquisitionRoute): 'safe' | 'bounded' | 'unknown' => {
  if (route.method === 'monster-drop' || route.method === 'thieving') return 'unknown';
  if (route.failureOutcomes?.length) return 'bounded';
  return 'safe';
};

const evidenceAllowed = (route: AcquisitionRoute, policy: RoutePolicy): boolean =>
  route.evidenceStatus === 'source-verified' || route.evidenceStatus === 'runtime-verified' || policy.includeUnverified === true;

const riskAllowed = (route: AcquisitionRoute, policy: RoutePolicy): boolean => {
  const maxRisk = policy.maxRisk ?? 'unknown';
  const rank = { safe: 0, bounded: 1, unknown: 2 } as const;
  return rank[methodRisk(route)] <= rank[maxRisk];
};

/** Find by stable ID or exact name/alias. No fuzzy match is used for actions. */
export function findItem(catalog: ItemCatalog, idOrName: number | string): CatalogItem | undefined {
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName).trim())) {
    const id = Number(idOrName);
    return catalog.items.find(item => item.id === id);
  }
  const wanted = normalize(idOrName);
  return catalog.items.find(item => normalize(item.name) === wanted || (item.aliases ?? []).some(alias => normalize(alias) === wanted));
}

/**
 * Return all known routes and rank the currently usable ones first. A source
 * record is never treated as executable merely because it has coordinates.
 */
export function getAcquisitionOptions(catalog: ItemCatalog, itemId: number, state: AgentState, quantity = 1, policy: RoutePolicy = {}): AcquisitionOption[] {
  const routes = catalog.routes.filter(route => route.profileId === catalog.profile.id && route.outputs.some(output => output.itemId === itemId));
  return routes.map(route => {
    const requirements = explainRequirement(route.requirements, state, catalog);
    const unresolved = route.unresolved ?? [];
    const evidenceUsable = evidenceAllowed(route, policy);
    const unknownRequirements = requirements.unknown.length > 0;
    const feasible = evidenceUsable && riskAllowed(route, policy) && requirements.satisfied && (!unknownRequirements || policy.allowUnknownRequirements === true);
    const output = route.outputs.find(candidate => candidate.itemId === itemId);
    const expected = output?.quantity ?? output?.quantityDistribution?.map(option => option.quantity).reduce((sum, value) => sum + value, 0) ?? 1;
    const repeats = Math.max(1, Math.ceil(quantity / Math.max(1, expected)));
    const score = feasible ? repeats + (route.locationIds?.length ?? 0) * 0.01 + unresolved.length * 0.1 + (route.costGp ?? 0) / 100000 : null;
    const reason = feasible
      ? `feasible ${route.method}; estimated repetitions ${repeats}`
      : !evidenceUsable
        ? `evidence status ${route.evidenceStatus} is not executable`
        : !riskAllowed(route, policy)
          ? `risk ${methodRisk(route)} exceeds policy`
          : requirements.unknown.length
            ? `unknown requirements: ${requirements.unknown.join('; ')}`
            : requirements.missing.length
              ? `missing requirements: ${requirements.missing.join('; ')}`
              : 'route is not currently feasible';
    return { route, feasible, evidenceUsable, requirements, unresolved, score, reason };
  }).sort((a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY));
}

const distance = (a: { x: number; z: number; plane: number } | undefined, b: { x: number; z: number; plane: number } | undefined): number | null =>
  !a || !b || a.plane !== b.plane ? null : Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

/**
 * Locate a route only when reachability is explicitly known or checked by the
 * caller. This deliberately refuses to infer a path from a coordinate.
 */
export function getNearestReachableSource(catalog: ItemCatalog, routeId: string, position: { x: number; z: number; plane: number }, reachability: ReachabilityContext): ReachableSource {
  const route = catalog.routes.find(candidate => candidate.id === routeId);
  if (!route) throw new Error(`UNKNOWN_ROUTE: ${routeId}`);
  const locations = (route.locationIds ?? []).map(id => catalog.locations.find(location => location.id === id)).filter((location): location is NonNullable<typeof location> => Boolean(location));
  let status: ReachableSource['status'] = 'unknown';
  let chosen: typeof locations[number] | undefined;
  if (reachability.reachableRouteIds?.includes(route.id)) status = 'reachable';
  else if (reachability.reachableLocationIds) {
    chosen = locations.find(location => reachability.reachableLocationIds!.includes(location.id));
    status = chosen ? 'reachable' : 'not-reachable';
  } else if (reachability.canReach && locations.length) {
    const checked = locations.map(location => ({ location, value: reachability.canReach!(route, location) }));
    const yes = checked.find(entry => entry.value === true);
    chosen = yes?.location ?? checked[0]?.location;
    status = yes ? 'reachable' : checked.some(entry => entry.value === 'unknown') ? 'unknown' : 'not-reachable';
  }
  chosen ??= locations[0];
  return {
    route,
    location: chosen,
    status,
    distance: distance(position, chosen?.coordinates),
    reason: status === 'reachable'
      ? 'reachability was supplied by runtime evidence'
      : status === 'not-reachable'
        ? 'runtime evidence says no indexed source location is currently reachable'
        : 'coordinates exist, but no reachability evidence was supplied',
  };
}

function availableQuantity(state: AgentState, item: CatalogItem): number {
  return itemCount(state.inventory, item) + itemCount(state.bank, item);
}

export function expandRecipeDependencies(catalog: ItemCatalog, itemId: number, quantity: number, state: AgentState = {}): DependencyNode {
  const visiting = new Set<number>();
  const expand = (targetId: number, targetQuantity: number): DependencyNode => {
    const item = findItem(catalog, targetId);
    if (!item) return { itemId: targetId, quantity: targetQuantity, fulfilled: 0, missing: targetQuantity, source: 'unknown' };
    const owned = availableQuantity(state, item);
    if (owned >= targetQuantity) return { itemId: targetId, quantity: targetQuantity, fulfilled: targetQuantity, missing: 0, source: itemCount(state.inventory, item) >= targetQuantity ? 'inventory' : 'bank' };
    const recipe = catalog.recipes.find(candidate => candidate.productItemId === targetId);
    if (!recipe || visiting.has(targetId)) return { itemId: targetId, quantity: targetQuantity, fulfilled: owned, missing: targetQuantity - owned, source: recipe ? 'unknown' : 'unknown' };
    visiting.add(targetId);
    const crafts = Math.ceil((targetQuantity - owned) / Math.max(1, recipe.outputQuantity));
    const children = recipe.inputs.map(input => {
      const inputItem = input.itemId !== undefined ? findItem(catalog, input.itemId) : findItem(catalog, input.itemName ?? '');
      return inputItem ? expand(inputItem.id, input.quantity * crafts) : { itemId: -1, quantity: input.quantity * crafts, fulfilled: 0, missing: input.quantity * crafts, source: 'unknown' as const };
    });
    visiting.delete(targetId);
    return { itemId: targetId, quantity: targetQuantity, fulfilled: owned, missing: targetQuantity - owned, source: 'recipe', children };
  };
  return expand(itemId, quantity);
}

export function explainRequirements(catalog: ItemCatalog, routeId: string, state: AgentState = {}): RequirementExplanation {
  const route = catalog.routes.find(candidate => candidate.id === routeId);
  if (!route) throw new Error(`UNKNOWN_ROUTE: ${routeId}`);
  return explainRequirement(route.requirements, state, catalog);
}

export function getRouteEvidence(catalog: ItemCatalog, routeId: string): { status: string; provenance: string[]; unresolved: string[]; notes: string[] } {
  const route = catalog.routes.find(candidate => candidate.id === routeId);
  if (!route) throw new Error(`UNKNOWN_ROUTE: ${routeId}`);
  return { status: route.evidenceStatus, provenance: route.provenance, unresolved: route.unresolved ?? [], notes: route.notes ?? [] };
}

export function getCatalogCoverage(catalog: ItemCatalog) {
  const withRoutes = new Set(catalog.routes.flatMap(route => route.outputs.map(output => output.itemId)));
  const classifications = Object.fromEntries([...new Set(catalog.items.map(item => item.classification))].map(classification => [classification, catalog.items.filter(item => item.classification === classification).length]));
  return {
    profileId: catalog.profile.id,
    itemCount: catalog.items.length,
    itemRegistry: catalog.profile.completeness.itemRegistry,
    acquisitionCoverage: catalog.profile.completeness.acquisitionCoverage,
    itemsWithKnownRoute: catalog.items.filter(item => withRoutes.has(item.id)).length,
    itemsWithoutKnownRoute: catalog.items.filter(item => !withRoutes.has(item.id)).length,
    routeCount: catalog.routes.length,
    runtimeValidatedRoutes: catalog.profile.completeness.runtimeValidatedRoutes,
    unresolvedCount: catalog.profile.unresolved.length + catalog.routes.reduce((count, route) => count + (route.unresolved?.length ?? 0), 0),
    classifications,
  };
}

/**
 * Store a verified observation for the agent's learning journal. This does not
 * rewrite the reference catalog or promote a lead to a fact automatically.
 */
export function reportObservation(input: Omit<CatalogObservation, 'id'> & { id?: string }): CatalogObservation {
  const id = input.id ?? `${input.routeId}:${input.at}:${input.context}:${input.outcome}`;
  return { ...input, id };
}
