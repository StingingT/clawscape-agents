import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Use the installed upstream skill without editing the game checkout. The
// policy requires complete observations, not the skill's default summary/delta.
export function skillCommand(character: string, args: string[], env = process.env): string[] {
  if (!/^[a-z][a-z0-9]{0,11}$/.test(character)) throw new Error('Invalid character');
  if (args.some(a => ['--character', '--server'].includes(a))) throw new Error('Identity override rejected');
  const full = ['state', 'act', 'wait'].includes(args[0] ?? '') && !args.includes('--full');
  return [env.CLAWSCAPE_PYTHON ?? 'python',
    env.CLAWSCAPE_SKILL_CLI ?? resolve(homedir(), '.codex/skills/clawscape/clawscape.py'),
    '--character', character, ...args, ...(full ? ['--full'] : [])];
}

export async function callSkill(character: string, args: string[], home: string): Promise<Record<string, any>> {
  const child = Bun.spawn(skillCommand(character, args), {
    stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAWSCAPE_HOME: home },
  });
  // Upstream emits structured failures on stderr. Drain it concurrently, and
  // expose only its bounded error field, never a traceback or raw process log.
  const errorOutput = new Response(child.stderr).text();
  // The upstream action deadline is 100s. A shorter subprocess timeout would
  // abandon an action still executing on the server and cause unsafe retries.
  const timeoutMs = ['connect', 'disconnect', 'act', 'wait'].includes(args[0] ?? '') ? 110_000 : 20_000;
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    let raw = '';
    for await (const chunk of child.stdout) {
      raw += Buffer.from(chunk).toString('utf8');
      if (raw.length > 4_000_000) { child.kill(); throw new Error('CLI response too large'); }
    }
    const code = await child.exited;
    let reply: Record<string, any>;
    try { reply = JSON.parse(raw); } catch {
      let reason = '';
      try { reason = String(JSON.parse(await errorOutput).error ?? '').slice(0, 500); } catch {}
      throw new Error(`CLI ${args[0]} unavailable (exit ${code})${reason ? ': ' + reason : ''}`);
    }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Invalid CLI response');
    if(args[0]==='act'&&reply.success===false&&reply.reason==='action_in_progress')return reply;
    if (code !== 0 || reply.error) throw new Error(`CLI ${args[0]}: ${String(reply.error ?? 'unavailable')}`);
    return reply;
  } finally { clearTimeout(timer); }
}
