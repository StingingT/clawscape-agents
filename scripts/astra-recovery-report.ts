#!/usr/bin/env bun
/** Offline read-only inspection; never constructs Store, connects to the game or edits receipts. */
import { Database } from 'bun:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionCommand, ActionResult, Observation } from '../agents/advanced/src/contracts.ts';
import { describeJournalAction, needsReconciliation } from '../agents/advanced/src/journal-diagnostics.ts';

export function inspectAstraJournal(file: string, limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_DIAGNOSTIC_LIMIT');
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('EXISTING_REGULAR_JOURNAL_REQUIRED');
  const db = new Database(file, { readonly: true, create: false });
  try {
    // A consistent read transaction, including WAL state; no PRAGMA/migration/write paths.
    db.run('BEGIN');
    const rows = db.query('SELECT command,result FROM actions').all() as { command: string; result: string }[];
    const unresolved = [];
    let unresolvedCount = 0;
    for (const row of rows) {
      let command, result;
      try { command = ActionCommand.parse(JSON.parse(row.command)); result = ActionResult.parse(JSON.parse(row.result)); }
      catch { throw new Error('INVALID_JOURNAL_ACTION_RECORD'); }
      if (command.action_id !== result.action_id) throw new Error('JOURNAL_ACTION_ID_MISMATCH');
      if (!needsReconciliation(result)) continue;
      unresolvedCount++;
      if (unresolved.length >= limit) continue;
      const found = db.query("SELECT body FROM records WHERE kind='action_checkpoints' AND json_extract(body,'$.action_id')=? ORDER BY seq")
        .all(command.action_id) as { body: string }[];
      const checkpoints = found.map(r => {
        try { const c = JSON.parse(r.body); return { action_id: String(c.action_id), before: Observation.parse(c.before) }; }
        catch { throw new Error('INVALID_JOURNAL_CHECKPOINT'); }
      });
      unresolved.push(describeJournalAction(command, result, checkpoints));
    }
    db.run('ROLLBACK');
    return { version: 1, readOnly: true, generatedAt: new Date().toISOString(),
      unresolvedCount, truncated: unresolvedCount > unresolved.length, unresolved,
      warning: 'Historical journal inspection only. No live state was fetched, no action was settled, and no replay is authorized.' };
  } finally { db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--runtime-root' || !args[1]?.trim()))
      throw new Error('Usage: bun scripts/astra-recovery-report.ts [--runtime-root DIRECTORY]');
    const root = args.length ? resolve(args[1]!) : resolve(dirname(fileURLToPath(import.meta.url)), '../agents/advanced');
    console.log(JSON.stringify(inspectAstraJournal(join(root, 'data/astra-live/journal.sqlite')), null, 2));
  } catch (error) {
    // Do not serialize arbitrary filesystem/database errors or credential-bearing content.
    const message = error instanceof Error ? error.message : '';
    console.error(/^(INVALID_|EXISTING_|JOURNAL_ACTION_|Usage:)/.test(message) ? message : 'ASTRA_JOURNAL_INSPECTION_FAILED');
    process.exitCode = 1;
  }
}
