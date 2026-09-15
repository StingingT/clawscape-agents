const RECOVERABLE_EXECUTOR_BLOCKS = new Set([
  'MISSING_TOOL_ROUTE',
  'MISSING_TOOL_OR_SUPPLY_ROUTE',
  'PUBLIC_LEAD_NOT_CONFIRMED',
  'REPEATED_NO_EFFECT',
  'ROUTE_OSCILLATION',
  'TRAINING_LEADS_EXHAUSTED',
]);

/** Executor-local dead ends are evidence against the current bounded attempt,
 * not a reason to freeze the whole autonomous session. Safety, stale-state,
 * reconciliation and unknown-outcome blockers deliberately remain terminal. */
export const recoverableExecutorBlock = (reason:string):boolean => RECOVERABLE_EXECUTOR_BLOCKS.has(reason);
