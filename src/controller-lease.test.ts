import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireController } from './controller-lease';

test('second cooperating controller is rejected and released owner can reacquire',()=>{
  const dir=mkdtempSync(join(tmpdir(),'clawscape-lease-test-')),file=join(dir,'controller.lock');
  try { const release=acquireController(file); expect(()=>acquireController(file)).toThrow('already owns');release();expect(existsSync(file)).toBe(false);acquireController(file)(); }
  finally {rmSync(dir,{recursive:true,force:true});}
});
test('releasing a lease never deletes a replacement owner',()=>{
  const dir=mkdtempSync(join(tmpdir(),'clawscape-lease-test-')),file=join(dir,'controller.lock');
  try {const release=acquireController(file);const owner=JSON.parse(readFileSync(file,'utf8'));writeFileSync(file,JSON.stringify({...owner,nonce:'replacement'}));release();expect(existsSync(file)).toBe(true);}
  finally {rmSync(dir,{recursive:true,force:true});}
});
