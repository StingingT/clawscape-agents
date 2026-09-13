import { test, expect } from 'bun:test';
import { recordRouteResult } from './shared-world';
import { readFileSync, rmSync, existsSync } from 'node:fs';

test('only movement or verified arrival creates a shared route event', () => {
  const path = `${process.cwd()}\\data\\shared-world-events.jsonl`;
  if (existsSync(path)) rmSync(path);
  const base = { player: { worldX: 1, worldZ: 1, level: 0 } };
  recordRouteResult(base, base, { type: 'walkTo', fields: { x: 5, z: 5, level: 0 } }, { navigation: { status: 'blocked' } }, 'test');
  expect(existsSync(path)).toBe(false);
  recordRouteResult(base, { player: { worldX: 3, worldZ: 1, level: 0 } }, { type: 'walkTo', fields: { x: 5, z: 5, level: 0 } }, { navigation: { status: 'progress' } }, 'test');
  expect(readFileSync(path, 'utf8')).toContain('route-observation');
  rmSync(path);
});
