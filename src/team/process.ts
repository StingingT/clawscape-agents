import { spawn, type ChildProcess } from 'node:child_process';
export type ProcessSpec = { file: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv };
export function launch(spec: ProcessSpec, stdout: number | 'pipe' = 'pipe', stderr: number | 'pipe' = 'pipe'): ChildProcess {
  return spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, shell: false,
    detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', stdout, stderr] });
}
/** Only a ChildProcess owned by this runtime is accepted; never kill a PID loaded from disk. */
export async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve()); killer.once('close', () => resolve());
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
    await new Promise(r => setTimeout(r, 250));
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}
const shown=(s:string,n=4000)=>s.length>n?s.slice(-n):s;
const command=(spec:ProcessSpec)=>[spec.file,...spec.args].map(x=>/\s/.test(x)?JSON.stringify(x):x).join(' ');
export async function capture(spec: ProcessSpec, input = '', timeoutMs = 10_000, limit = 1_000_000, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('CANCELLED');
  const child = launch(spec); let out = '', err = '', size = 0, failure: Error | undefined;
  const abort = () => { failure = new Error('CANCELLED_OR_TIMED_OUT'); void terminate(child); };
  const timer = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, { once: true });
  child.stdout?.on('data', chunk => { size += chunk.length; if (size > limit) abort(); else out += chunk.toString(); });
  child.stderr?.on('data', chunk => { size += chunk.length; if (size > limit) abort(); else err += chunk.toString(); });
  child.stdin?.on('error', () => {}); child.stdin?.end(input);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error',reject); child.once('close', resolve); });
    if (failure) throw failure;
    if (code !== 0) {
      const detail=shown(err.trim()||out.trim()||'(no subprocess output)');
      throw new Error(`PROCESS_FAILED: ${code}\ncommand: ${command(spec)}\nstderr/output:\n${detail}`);
    }
    return out;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
