import { createHash } from 'node:crypto';
import type { ActionCommand, ActionResult, Observation } from './contracts.ts';

export function needsReconciliation(r: ActionResult): boolean {
  return !((r.status === 'SUCCEEDED' && r.evidence.length > 0) || r.status === 'REJECTED' || r.status === 'EXPIRED'
    || r.status === 'CANCELLED' && !/MAY_STILL|OUTCOME_UNKNOWN|PREEMPTED/.test(r.reason));
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe = (value: unknown) => typeof value !== 'string' ? null
  : /token|password|secret|authorization|bearer|api[_-]?key/i.test(value) ? '[redacted]' : value.slice(0, 500);
const numeric = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? n : null;

/** A diagnostic, NOT evidence that a dialogue ended without giving a reward.
 * Export selected fields only: no lease/session tokens, account config or arbitrary payloads. */
export function describeJournalAction(command: ActionCommand, result: ActionResult,
  checkpoints: Array<{ action_id: string; before: Observation }>) {
  const matches = checkpoints.filter(c => c.action_id === command.action_id);
  const before = matches.length === 1 ? matches[0]!.before : undefined;
  const dialogue = command.intent.operation === 'dialogue';
  const index = command.intent.operation === 'dialogue' ? command.intent.option_index : undefined;
  const options = before?.dialog?.options ?? [];
  const chosen = options.find(o => o.index === index);
  return {
    commandId: command.action_id, operation: command.intent.operation,
    originalStatus: result.status, originalReason: safe(result.reason), recordedAt: numeric(result.at),
    commandHash: hash(command), resultHash: hash(result),
    checkpointCount: matches.length, checkpointHash: before ? hash(before) : null,
    basedOnSnapshot: command.based_on_snapshot,
    before: before ? { tick: numeric(before.tick), snapshot: numeric(before.seq), observedAt: numeric(before.observed_at),
      connected: before.connected, lifeId: numeric(before.life_id), respawns: numeric(before.respawns),
      dialogue: dialogue ? { open: before.dialog?.open, waiting: before.dialog?.waiting,
        interfaceId: numeric(before.activity?.modal_id), text: safe(before.dialog?.text),
        optionIndex: index, selectedText: safe(chosen?.text),
        options: options.slice(0, 20).map(o => ({ index: numeric(o.index), text: safe(o.text) })),
        optionsTruncated: options.length > 20 } : undefined } : null,
    requiredEvidence: !before
      ? 'A unique original pre-action checkpoint is missing; do not guess the target or outcome.'
      : dialogue ? 'Match this exact dialogue choice to authoritative completion/reward evidence. A closed interface, elapsed time or unchanged visible inventory is insufficient.'
        : 'Match the original action to operation-specific evidence; this report does not authorize replay.',
    replayAuthorized: false,
  };
}
