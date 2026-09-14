import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('expected startup failures do not leave exit code 2 on a passing Bun test process',()=>{
  const child=spawnSync(process.execPath,['test',resolve(import.meta.dir,'../../../tests/agency/journal-recovery.test.ts')],
    {encoding:'utf8',timeout:15_000});
  expect(child.error).toBeUndefined();expect(child.status).toBe(0);
});
