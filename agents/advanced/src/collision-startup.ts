/** Small, dependency-free protocol: never send raw exception text or config values. */
export const COLLISION_STARTUP_TIMEOUT_MS = 60_000;
export const COLLISION_STARTUP_STAGES = [
  'starting', 'resolving-upstream', 'loading-contracts', 'importing-pathfinding',
  'importing-pathfinder', 'initializing-pathfinding', 'hashing-collision-data', 'applying-hazards', 'ready',
] as const;
export type CollisionStage = typeof COLLISION_STARTUP_STAGES[number];
export const COLLISION_FAILURE_CODES = [
  'COLLISION_WORKER_TIMEOUT', 'COLLISION_WORKER_FAILED', 'COLLISION_DEPENDENCY_MISSING',
  'COLLISION_ASSET_READ_FAILED', 'COLLISION_INITIALIZATION_FAILED',
] as const;
export type CollisionFailure = typeof COLLISION_FAILURE_CODES[number];
export type CollisionDiagnostic = {
  component: 'astra-collision-worker'; status: 'starting' | 'ready' | 'failed';
  stage: CollisionStage; elapsedMs: number; errorCode?: CollisionFailure;
};
export function collisionFailure(error: unknown): CollisionFailure {
  const e=error as {code?:unknown;message?:unknown};
  if(e?.code==='ERR_MODULE_NOT_FOUND' || /cannot find (module|package)|module not found/i.test(String(e?.message??'')))
    return 'COLLISION_DEPENDENCY_MISSING';
  if(e?.code==='ENOENT' || e?.code==='EACCES' || e?.code==='EPERM') return 'COLLISION_ASSET_READ_FAILED';
  return 'COLLISION_INITIALIZATION_FAILED';
}
