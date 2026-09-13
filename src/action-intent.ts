import { existsSync, readFileSync } from 'node:fs';
import { saveGoalJson } from './goals/persistence';

export type ActionStatus = 'pending' | 'rejected' | 'verified' | 'outcome-unknown' | 'failed';
export type ActionIntent = {
  commandId: string;
  actionId: string;
  type: string;
  fields: Record<string, unknown>;
  taskId?: string;
  startedAt: string;
  status: ActionStatus;
  expectedEffect?: string;
  outcomeAt?: string;
  evidence?: string[];
  failure?: string;
  beforeState?: unknown;
};

export function loadActionIntent(file: string): ActionIntent | undefined {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, 'utf8')) as ActionIntent; } catch { return undefined; }
}

export function beginActionIntent(file: string, intent: Omit<ActionIntent, 'status'>): ActionIntent {
  const existing = loadActionIntent(file);
  if (existing && (existing.status === 'pending' || existing.status === 'outcome-unknown')) {
    throw new Error(`UNRESOLVED_ACTION_INTENT:${existing.commandId}`);
  }
  const value: ActionIntent = { ...intent, status: 'pending' };
  saveGoalJson(file, value);
  return value;
}

export function finishActionIntent(file: string, intent: ActionIntent, status: Exclude<ActionStatus, 'pending'>, evidence: string[] = [], failure?: string): ActionIntent {
  const value: ActionIntent = { ...intent, status, outcomeAt: new Date().toISOString(), evidence, ...(failure ? { failure } : {}) };
  saveGoalJson(file, value);
  return value;
}
