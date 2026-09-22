/**
 * Source-backed item knowledge for agents.
 *
 * This is deliberately separate from character memory. Catalog records are
 * reference facts and leads; runtime observations and learned route scores
 * must be stored by the agent that made them.
 */

export type AvailabilityClass =
  | 'active'
  | 'generated-variant'
  | 'inactive'
  | 'historical'
  | 'admin-test'
  | 'unresolved';

export type EvidenceStatus =
  | 'source-verified'
  | 'runtime-verified'
  | 'observed-lead'
  | 'unresolved'
  | 'excluded';

export type AcquisitionMethod =
  | 'ground-spawn'
  | 'monster-drop'
  | 'crafting'
  | 'quest-reward'
  | 'quest-stage'
  | 'shop-purchase'
  | 'gathering'
  | 'thieving'
  | 'npc-service'
  | 'object-interaction'
  | 'minigame'
  | 'random-event'
  | 'initial-loadout'
  | 'player-trade'
  | 'transformation';

export type SourceReference = {
  id: string;
  kind: 'repository' | 'runtime' | 'document' | 'external';
  uri: string;
  revision?: string;
  path?: string;
  line?: number;
  lineEnd?: number;
  contentHash?: string;
  note?: string;
};

export type Coordinates = {
  x: number;
  z: number;
  plane: number;
};

export type RawCoordinates = {
  regionX?: number;
  regionZ?: number;
  localX?: number;
  localZ?: number;
  plane?: number;
};

export type CatalogLocation = {
  id: string;
  profileId: string;
  label: string;
  coordinates?: Coordinates;
  rawCoordinates?: RawCoordinates;
  anchorKind: 'ground-item' | 'npc-anchor' | 'object' | 'shop' | 'facility' | 'unknown';
  access?: {
    status: 'verified' | 'unverified' | 'unknown';
    notes?: string[];
  };
  provenance: string[];
  unresolved?: string[];
};

export type ItemProperties = {
  stackable?: boolean;
  tradeable?: boolean;
  members?: boolean;
  equipment?: boolean;
  usable?: boolean;
  noteVariantOf?: number;
  chargedVariantOf?: number;
  metadata?: Record<string, unknown>;
};

export type CatalogItem = {
  profileId: string;
  id: number;
  symbol: string;
  name: string;
  aliases?: string[];
  classification: AvailabilityClass;
  availabilityRationale: string;
  properties?: ItemProperties;
  variantOf?: number;
  acquisitionRouteIds: string[];
  provenance: string[];
  unresolved?: string[];
};

export type Requirement =
  | { all: Requirement[] }
  | { any: Requirement[] }
  | { fact: string; minimum?: number; equals?: string | number | boolean }
  | { skill: string; level: number }
  | { itemId: number; quantity: number; container?: 'inventory' | 'bank' | 'either' }
  | { itemName: string; quantity: number; container?: 'inventory' | 'bank' | 'either' }
  | { coins: number; container?: 'inventory' | 'bank' | 'either' }
  | { quest: string; stage?: number }
  | { flag: string; value?: string | number | boolean };

export type OutputQuantity = {
  itemId: number;
  quantity?: number;
  quantityDistribution?: Array<{ quantity: number; weight: number | null }>;
};

export type AcquisitionRoute = {
  id: string;
  profileId: string;
  method: AcquisitionMethod;
  outputs: OutputQuantity[];
  actor?: { id?: number; symbol?: string; name?: string };
  interaction?: { action: string; option?: string; handler?: string };
  locationIds?: string[];
  requirements?: Requirement;
  consumes?: Array<{ itemId?: number; itemName?: string; quantity: number }>;
  tools?: Array<{ itemId?: number; itemName?: string; quantity: number }>;
  costGp?: number;
  repeatability?: 'one-off' | 'repeatable' | 'conditional' | 'unknown';
  lifecycle?: { stock?: number | null; respawnTicks?: number | null; cooldownTicks?: number | null };
  failureOutcomes?: string[];
  evidenceStatus: EvidenceStatus;
  provenance: string[];
  unresolved?: string[];
  notes?: string[];
};

export type Recipe = {
  id: string;
  profileId: string;
  productItemId: number;
  outputQuantity: number;
  inputs: Array<{ itemId?: number; itemName?: string; quantity: number }>;
  tools?: Array<{ itemId?: number; itemName?: string; quantity: number }>;
  requirements?: Requirement;
  evidenceStatus: EvidenceStatus;
  provenance: string[];
  unresolved?: string[];
};

export type RequirementExplanation = {
  satisfied: boolean;
  missing: string[];
  unknown: string[];
};

export type AgentInventoryRow = { id?: number; name?: string; count: number };

export type AgentState = {
  skills?: Record<string, number>;
  facts?: Record<string, number | string | boolean>;
  inventory?: AgentInventoryRow[];
  bank?: AgentInventoryRow[];
  carriedCoins?: number;
  bankCoins?: number;
  quests?: Record<string, number | boolean>;
  flags?: Record<string, string | number | boolean>;
};

export type RoutePolicy = {
  includeUnverified?: boolean;
  allowUnknownRequirements?: boolean;
  maxRisk?: 'safe' | 'bounded' | 'unknown';
};

export type AcquisitionOption = {
  route: AcquisitionRoute;
  feasible: boolean;
  evidenceUsable: boolean;
  requirements: RequirementExplanation;
  unresolved: string[];
  score: number | null;
  reason: string;
};

export type CatalogObservation = {
  id: string;
  profileId: string;
  routeId: string;
  at: number;
  context: string;
  outcome: 'success' | 'partial' | 'failure' | 'unknown';
  evidence: string[];
  facts?: Record<string, number | string | boolean>;
  note?: string;
};

export type CatalogProfile = {
  id: string;
  repository: string;
  branch?: string;
  commit?: string;
  contentDate?: string;
  serverConfirmed: boolean;
  registryHash?: string;
  completeness: {
    itemRegistry: 'complete' | 'partial' | 'unknown';
    acquisitionCoverage: 'complete' | 'partial' | 'unknown';
    runtimeValidatedRoutes: number;
  };
  provenance: string[];
  unresolved: string[];
};

export type ItemCatalog = {
  profile: CatalogProfile;
  items: CatalogItem[];
  routes: AcquisitionRoute[];
  locations: CatalogLocation[];
  recipes: Recipe[];
};

export type ReachabilityContext = {
  /** Explicit runtime reachability facts. Coordinates alone never imply reachability. */
  reachableRouteIds?: string[];
  reachableLocationIds?: string[];
  canReach?: (route: AcquisitionRoute, location: CatalogLocation) => boolean | 'unknown';
};

export type ReachableSource = {
  route: AcquisitionRoute;
  location?: CatalogLocation;
  status: 'reachable' | 'not-reachable' | 'unknown';
  distance: number | null;
  reason: string;
};

export type DependencyNode = {
  itemId: number;
  quantity: number;
  fulfilled: number;
  missing: number;
  source: 'inventory' | 'bank' | 'recipe' | 'unknown';
  children?: DependencyNode[];
};
