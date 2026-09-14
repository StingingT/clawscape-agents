import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

/** The old synthetic planner ledger is advisory, not an authoritative server receipt.
 * Archive only records for replaceable motion/read-only operations, under controller ownership.
 * Purchases, transfers, eating and production remain explicit reconciliation blockers. */
export function migrateLegacyPlanner(file:string):'absent'|'resolved'|'archived-motion' {
  if(!existsSync(file))return 'absent';
  const raw=readFileSync(file,'utf8');let memory:any;
  try{memory=JSON.parse(raw);}catch{throw new Error('LEGACY_AGENCY_MEMORY_CORRUPT');}
  if(!memory.pending)return 'resolved';
  const capability=memory.pending.method?.capability;
  if(typeof capability!=='string'||!['live:walkTo','live:retreat','live:wait','live:scanNearbyLocs','astra:move','astra:observe'].includes(capability))
    throw new Error('LEGACY_AGENCY_INTENT_RECONCILIATION_REQUIRED');
  const hash=createHash('sha256').update(raw).digest('hex').slice(0,16);
  const backup=file+'.legacy-'+hash+'.json';
  if(!existsSync(backup))writeFileSync(backup,raw,{flag:'wx',mode:0o600});
  // Never mark an unknown legacy action successful or insert it into learned results.
  memory.legacyMigration={at:new Date().toISOString(),status:'archived-unknown-replaceable-motion',backup,commandId:memory.pending.commandId};
  delete memory.pending;
  const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(memory,null,2)+'\n',{mode:0o600});renameSync(temp,file);
  return 'archived-motion';
}
