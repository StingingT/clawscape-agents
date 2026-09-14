import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { recoverLegacyJournals, readRecoveryJson } from '../src/agency/journal-recovery.ts';

const args=process.argv.slice(2);
function required(name:string):string {
  const index=args.indexOf('--'+name),value=args[index+1];
  if(index<0||!value||value.startsWith('--'))throw new Error('REQUIRED_ARGUMENT:'+name);
  return value;
}
try {
  const directory=resolve(required('data-dir')),agent=required('agent'),world=required('world');
  if(!existsSync(directory))throw new Error('JOURNAL_DIRECTORY_MISSING');
  const legacy=recoverLegacyJournals(directory,{agent,world});
  const current=readRecoveryJson(resolve(directory,'agency-v2.json'))?.value;
  console.log(JSON.stringify({mode:'read-only; no server requests or journal changes',legacy,
    current:current?{version:current.version,agent:current.memory?.agent,world:current.memory?.world,
      pending:current.receipt?.commandId,safetyPending:current.safetyReceipt?.commandId}:null,
    note:'For Astra, the executor SQLite journal must also be checked by live-entry.ts reconcile; an empty legacy report is not proof of executor readiness.'},null,2));
  if(!legacy.ready||current?.receipt||current?.safetyReceipt)process.exitCode=2;
} catch(error) {
  console.error(JSON.stringify({error:error instanceof Error?error.message:'JOURNAL_INSPECTION_FAILED'}));process.exitCode=2;
}
