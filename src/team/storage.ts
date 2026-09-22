import { existsSync, mkdirSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export const controlDir = (root: string) => join(resolve(root), 'data', 'team-control');
export function safePath(path: string): void {
  let p = resolve(path);
  while (true) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('TEAM_SYMLINK_REFUSED');
    const parent = dirname(p); if (parent === p) break; p = parent;
  }
}
export function readJson<T>(path: string, max = 1_000_000): T | undefined {
  safePath(path); if (!existsSync(path)) return;
  const s = lstatSync(path); if (!s.isFile() || s.size > max) throw new Error('INVALID_TEAM_FILE');
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as T; }
  catch { throw new Error('CORRUPT_TEAM_FILE'); }
}
export function writeJson(path: string, data: unknown): void {
  safePath(path); mkdirSync(dirname(path), { recursive: true }); safePath(path);
  const tmp = path + '.' + randomUUID() + '.tmp', fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
}
// A deliberate takeover persists after shutdown: the legacy watchdog stays off.
export const teamEnabled = (root: string) => existsSync(join(controlDir(root), 'enabled.json'));
