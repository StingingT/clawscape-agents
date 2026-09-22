import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safePath } from './storage.ts';
/** Cooperating local process ownership. A reused live PID fails closed, never authorizes killing it. */
export function acquireTeamController(file:string):()=>void {
  safePath(file);mkdirSync(dirname(file),{recursive:true});
  if(existsSync(file)){
    let old:any;try{old=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('UNREADABLE_CONTROLLER_LOCK');}
    if(!Number.isSafeInteger(old.pid)||old.pid<1)throw new Error('INVALID_CONTROLLER_LOCK');
    let alive=true;try{process.kill(old.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
    if(alive)throw new Error('A controller already owns these profiles. Stop the existing watchdog/control panel first.');
    unlinkSync(file);
  }
  const token={pid:process.pid,nonce:randomUUID()},fd=openSync(file,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(token));}finally{closeSync(fd);}
  return ()=>{try{safePath(file);if(JSON.parse(readFileSync(file,'utf8')).nonce===token.nonce)unlinkSync(file);}catch{}};
}
