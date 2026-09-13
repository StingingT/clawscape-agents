import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function isLiveController(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'win32') return true;
    const rows = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' });
    return /bun(?:\.exe)?/i.test(rows);
  } catch {
    return false;
  }
}

// Cooperating local runners only; this is not server-side session fencing.
export function acquireController(file: string) {
  if (existsSync(file)) {
    let old: { pid: number };
    try { old = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Controller lock unreadable; inspect before starting'); }
    if (!Number.isInteger(old.pid) || old.pid < 1) throw new Error('Invalid controller lock');
    if (isLiveController(old.pid)) throw new Error('A local controller already owns this profile');
    unlinkSync(file); // Exact stale lock, never a data directory.
  }
  const owner = { pid: process.pid, nonce: randomUUID() };
  const fd = openSync(file, 'wx');
  try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
  return () => {
    try { if (JSON.parse(readFileSync(file, 'utf8')).nonce === owner.nonce) unlinkSync(file); } catch {}
  };
}
