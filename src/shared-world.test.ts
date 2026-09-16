import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('only movement or verified arrival creates a shared route event', () => {
  // Run the real writer in a separate working directory. Tests must never
  // delete a player's shared-world history, and paths must work on both OSes.
  const root = mkdtempSync(join(tmpdir(), 'shared-world-test-'));
  const source = new URL('./shared-world.ts', import.meta.url).href;
  try {
    mkdirSync(join(root, 'data'));
    const script = `
      import { recordRouteResult } from ${JSON.stringify(source)};
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      const path = join(process.cwd(), 'data', 'shared-world-events.jsonl');
      const base = { player: { worldX: 1, worldZ: 1, level: 0 } };
      recordRouteResult(base, base, { type: 'walkTo', fields: { x: 5, z: 5, level: 0 } }, { navigation: { status: 'blocked' } }, 'test');
      assert.equal(existsSync(path), false);
      recordRouteResult(base, { player: { worldX: 3, worldZ: 1, level: 0 } }, { type: 'walkTo', fields: { x: 5, z: 5, level: 0 } }, { navigation: { status: 'progress' } }, 'test');
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'data', 'shared-world-events.jsonl'), 'utf8')).toContain('route-observation');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
