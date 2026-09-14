import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { verifyActionOutcome } from '../action-outcome.ts';

export type RecoveryIdentity = { agent: string; world: string };
export type LegacyEntry = { file: string; sha256: string; commandId?: string; disposition: 'accounted' | 'unresolved'; reason: string; evidence: string[] };
export type RecoveryReport = { version: 1; at: string; agent: string; world: string; ready: boolean; entries: LegacyEntry[] };
export type State = Record<string, any>;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const atomicRecoveryJson = (file: string, value: unknown) => {
  const tmp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
};

/** Read without treating a corrupt journal as an empty one. Never follows a journal symlink. */
export function readRecoveryJson(file: string): { value: any; raw: string; sha256: string } | undefined {
  if (!existsSync(file)) return;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_000_000) throw new Error('UNSAFE_OR_OVERSIZED_JOURNAL:' + basename(file));
  const raw = readFileSync(file, 'utf8');
  try { return { value: JSON.parse(raw), raw, sha256: hash(raw) }; }
  catch { throw new Error('CORRUPT_JOURNAL:' + basename(file)); }
}
const count = (items: any[]) => {
  const result: Record<string, number> = {};
  for (const i of items) {
    if (i.id === undefined || !Number.isFinite(Number(i.count ?? 1))) return null;
    result[String(i.id)] = (result[String(i.id)] ?? 0) + Number(i.count ?? 1);
  }
  return Object.fromEntries(Object.entries(result).filter(([,n]) => n !== 0).sort(([a],[b]) => a.localeCompare(b)));
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only durable accounting/set-state effects can be compared across a LOCAL client incarnation.
 * NPC references, dialogue progress and combat are deliberately not reconstructed after restart. */
export function durableRecoveryEvidence(before: State, after: State, action: { type: string; fields?: State }, stable: State): string[] {
  if (!before?.player || !after?.player || !stable?.player || after.inGame === false || stable.inGame === false) return [];
  for (const field of ['character','world','profileId','worldEpoch']) if (before[field] && after[field] !== before[field]) return [];
  if(('worldEpoch' in before || 'worldEpoch' in after) && before.worldEpoch !== after.worldEpoch)return [];
  const life = before.player.lifeId;
  if (life === undefined || life === null || life !== after.player.lifeId || life !== stable.player.lifeId) return [];
  if(before.player.respawnCount !== undefined && (before.player.respawnCount!==after.player.respawnCount || before.player.respawnCount!==stable.player.respawnCount))return [];
  if (!Number.isFinite(before.tick) || !Number.isFinite(after.tick) || !Number.isFinite(stable.tick) || after.tick < before.tick || stable.tick <= after.tick) return [];
  if (!Array.isArray(before.inventory) || !Array.isArray(after.inventory) || !Array.isArray(stable.inventory)) return [];
  if (!count(before.inventory)||!count(after.inventory)||!count(stable.inventory))return [];
  if (!same(count(after.inventory), count(stable.inventory)) || !same(after.equipment, stable.equipment)
    || !same(after.player.combat, stable.player.combat) || after.player.hp !== stable.player.hp) return [];
  if (after.player.combat?.inCombat === true || after.player.isDead === true) return [];
  const type = action.type;
  if (!['bankDeposit','bankWithdraw','shopBuy','shopSell','equip','useInventoryItem','walkTo','setCombatStyle'].includes(type)) return [];
  if (['bankDeposit','bankWithdraw'].includes(type) && (!Array.isArray(after.bank?.items) || !Array.isArray(stable.bank?.items)
    || !same(count(after.bank.items),count(stable.bank.items)))) return [];
  if (type === 'walkTo') {
    const f = action.fields ?? {};
    if (after.player.worldX !== f.x || after.player.worldZ !== f.z || after.player.level !== (f.level ?? 0)
      || after.player.worldX !== stable.player.worldX || after.player.worldZ !== stable.player.worldZ || after.player.level !== stable.player.level) return [];
  }
  const verified = verifyActionOutcome(before, after, action);
  if (!verified.verified) return [];
  // Transfers must leave all unrelated item counts and equipment unchanged. A same-sized
  // transfer followed by unrelated activity cannot be silently attributed to this command.
  if (['bankDeposit','bankWithdraw','shopBuy','shopSell'].includes(type)) {
    const f = action.fields ?? {};
    const source = type === 'bankWithdraw' ? before.bank?.items : type === 'shopBuy' ? before.shop?.shopItems : before.inventory;
    const item = source?.find((i: any) => i.slot === f.slot);
    if (!item || !same(before.equipment,after.equipment) || !same(before.skills,after.skills)) return [];
    if(/shop/.test(type)) {
      const quote=type==='shopBuy'?Number(item.buyPrice):Number((before.shop?.playerItems??[]).find((i:any)=>i.id===item.id)?.sellPrice);
      const bc=Number((count(before.inventory)??{})['995']??0),ac=Number((count(after.inventory)??{})['995']??0);
      if(Number(f.amount)!==1||!Number.isFinite(quote)||quote<0||Math.abs(ac-bc)!==quote)return [];
    }
    if(/bank/.test(type)) {
      const bb=count(before.bank?.items??[]),ab=count(after.bank?.items??[]);
      if(!bb||!ab)return [];
      for(const id of new Set([...Object.keys(bb),...Object.keys(ab)]))if(id!==String(item.id)&&bb[id]!==ab[id])return [];
      if(Number(f.amount)===-1) {
        const all=type==='bankWithdraw'?bb[String(item.id)]??0:(count(before.inventory)??{})[String(item.id)]??0;
        const delta=Math.abs(((count(after.inventory)??{})[String(item.id)]??0)-((count(before.inventory)??{})[String(item.id)]??0));
        if(delta!==all)return [];
      }
    }
    const expected = new Set([String(item.id), ...(/shop/.test(type) ? ['995'] : [])]);
    const b = count(before.inventory), a = count(after.inventory);
    if (!a || !b) return [];
    for (const id of new Set([...Object.keys(a),...Object.keys(b)])) if (!expected.has(id) && a[id] !== b[id]) return [];
  }
  return ['two-stable-own-observations; durable effect only; not a server command acknowledgement', ...verified.evidence];
}

const synthetic = (doc: any) => {
  const pending = doc?.pending;
  if (!pending) return true;
  const entries = Object.entries(pending.method?.effects ?? {});
  return doc.schema === 1 && typeof pending.commandId === 'string' && entries.length === 1
    && /^(action:|goal:)/.test(entries[0]![0]) && entries[0]![1] === 1
    && Array.isArray(pending.method.prerequisites) && pending.method.prerequisites.length === 0
    && Object.keys(pending.method.consumes ?? {}).length === 0
    && doc.active?.target?.fact === entries[0]![0];
};

/** Backups are byte-for-byte, immutable by name, and made before the recovery receipt.
 * Original files remain untouched. A hash-scoped receipt prevents reprocessing after restart. */
export function recoverLegacyJournals(directory: string, identity: RecoveryIdentity, options: {
  state?: State; stable?: State; executorSettled?: boolean; executorHasHistory?: boolean;
  legacyWorld?: string; apply?: boolean;
} = {}): RecoveryReport {
  if(options.apply)mkdirSync(directory, { recursive: true });
  const receiptFile = join(directory,'legacy-recovery.json');
  const previous = readRecoveryJson(receiptFile)?.value as RecoveryReport | undefined;
  if (previous && (previous.version !== 1 || previous.agent !== identity.agent || previous.world !== identity.world)) throw new Error('RECOVERY_RECEIPT_IDENTITY_MISMATCH');
  const report: RecoveryReport = { version:1, at:new Date().toISOString(), ...identity, ready:true, entries:[] };
  let executorAccounted = options.executorSettled === true;
  let executorPresent = options.executorHasHistory === true;
  for (const name of ['action-intent.json','agency-memory.json']) {
    const file = join(directory,name), saved = readRecoveryJson(file);
    if (!saved) continue;
    const doc = saved.value;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('INVALID_LEGACY_JOURNAL:' + name);
    if (doc.agent && String(doc.agent).toLowerCase() !== identity.agent.toLowerCase()) throw new Error('LEGACY_JOURNAL_AGENT_MISMATCH');
    if (doc.world && doc.world !== identity.world && doc.world !== options.legacyWorld) throw new Error('LEGACY_JOURNAL_WORLD_MISMATCH');
    const old = previous?.entries.find(e => e.file === name && e.sha256 === saved.sha256 && e.disposition === 'accounted');
    let entry: LegacyEntry = { file:name, sha256:saved.sha256, commandId:doc.commandId ?? doc.pending?.commandId,
      disposition:'unresolved', reason:'Authoritative execution outcome is not established.', evidence:[] };
    if (old) entry = old;
    else if (name === 'action-intent.json') {
      if (typeof doc.commandId !== 'string' || typeof doc.type !== 'string' || !['pending','outcome-unknown','failed','verified','rejected'].includes(doc.status))
        throw new Error('INVALID_LEGACY_ACTION_INTENT');
      if(!doc.beforeState?.character && !doc.commandId.toLowerCase().startsWith(identity.agent.toLowerCase()+'-'))throw new Error('LEGACY_ACTION_ACTOR_UNPROVEN');
      if (doc.beforeState?.character && String(doc.beforeState.character).toLowerCase() !== identity.agent.toLowerCase()) throw new Error('LEGACY_JOURNAL_AGENT_MISMATCH');
      if (doc.beforeState?.world && doc.beforeState.world !== identity.world) throw new Error('LEGACY_JOURNAL_WORLD_MISMATCH');
      if (['verified','rejected'].includes(doc.status)) {
        entry = { ...entry, disposition:'accounted', reason:'Previously terminal executor record retained; no new learning or replay.', evidence:[`legacy-terminal:${doc.status}`] };
      } else if (['wait','scanNearbyLocs'].includes(doc.type)) {
        entry = { ...entry, disposition:'accounted', reason:'Retired observation-only request; no success or gameplay effect inferred.', evidence:['operation is read-only; original unknown status retained in backup'] };
      } else if (options.state && options.stable && doc.beforeState) {
        const evidence = durableRecoveryEvidence(doc.beforeState, options.state, doc, options.stable);
        if (evidence.length) entry = { ...entry, disposition:'accounted', reason:'Requested durable effect reconciled without replay.', evidence };
      }
    } else {
      if (!synthetic(doc)) throw new Error('UNRECOGNIZED_LEGACY_PLANNER_JOURNAL');
      if (!doc.pending) entry = { ...entry, disposition:'accounted', reason:'Resolved legacy planning history retained.', evidence:['no pending planning record'] };
      else if (executorAccounted && executorPresent) entry = { ...entry, disposition:'accounted', reason:'Obsolete synthetic planner receipt archived, not declared successful. Actual executor ledger is settled.', evidence:['known action-first adapter format','executor ledger checked independently; no new learning'] };
    }
    if (name === 'action-intent.json') { executorPresent = true; executorAccounted = entry.disposition === 'accounted' && options.executorSettled !== false; }
    if (entry.disposition === 'unresolved') report.ready = false;
    report.entries.push(entry);
    if (options.apply && entry.disposition === 'accounted') {
      const backupDir = join(directory,'journal-backups');mkdirSync(backupDir,{recursive:true});
      const backup = join(backupDir,name + '.' + saved.sha256 + '.json');
      if (!existsSync(backup)) copyFileSync(file,backup,constants.COPYFILE_EXCL);
      if (hash(readFileSync(backup,'utf8')) !== saved.sha256 || hash(readFileSync(file,'utf8')) !== saved.sha256) throw new Error('JOURNAL_CHANGED_DURING_RECOVERY');
    }
  }
  if (options.executorSettled === false) report.ready = false;
  if (options.apply) atomicRecoveryJson(receiptFile,report);
  return report;
}
