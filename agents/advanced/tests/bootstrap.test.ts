import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const entry=resolve(import.meta.dir,'../src/live-entry.ts');
function run(root:string,file=entry,mode='run') {
  return spawnSync(process.execPath,[file,mode,'--runtime-root',root],{encoding:'utf8',timeout:5000,env:{...process.env,CLAWSCAPE_ASTRA_HOME:root}});
}
function temporary(f:(dir:string)=>void){const dir=mkdtempSync(join(tmpdir(),'astra-bootstrap-'));try{f(dir);}finally{rmSync(dir,{recursive:true,force:true});}}

test('missing local config produces a precise live status and releases controller ownership',()=>temporary(root=>{
  const child=run(root);expect(child.error).toBeUndefined();expect(child.status).toBe(2);
  const status=JSON.parse(readFileSync(join(root,'data/astra-live/status.json'),'utf8'));
  expect(status.reason).toBe('CONFIG_FILE_MISSING');expect(status.retryable).toBe(false);
  expect(existsSync(join(root,'data/astra-live/controller.lock'))).toBe(false);
  expect(run(root).status).toBe(2); // no leaked lock or five-second recovery lease
}));
test('bad configuration is redacted and reported before any CLI command',()=>temporary(root=>{
  writeFileSync(join(root,'config.local.json'),JSON.stringify({token:'DO_NOT_LOG_THIS_SECRET'}));
  const child=run(root);expect(child.status).toBe(2);expect(child.stderr).not.toContain('DO_NOT_LOG_THIS_SECRET');
  expect(JSON.parse(readFileSync(join(root,'data/astra-live/status.json'),'utf8')).reason).toBe('CONFIG_SCHEMA_INVALID');
}));
test('a missing executor database is never recreated over a saved v2 receipt',()=>temporary(root=>{
  mkdirSync(join(root,'data/astra-live'),{recursive:true});writeFileSync(join(root,'data/astra-live/agency-v2.json'),'{"version":2}');
  const child=run(root);expect(child.status).toBe(2);expect(existsSync(join(root,'data/astra-live/journal.sqlite'))).toBe(false);
  expect(JSON.parse(readFileSync(join(root,'data/astra-live/status.json'),'utf8')).reason).toBe('EXECUTOR_JOURNAL_MISSING');
}));
test('bootstrap catches an actual runtime import failure using only built-in dependencies',()=>temporary(root=>{
  const code=join(root,'code');mkdirSync(join(code,'src'),{recursive:true});
  copyFileSync(entry,join(code,'src/live-entry.ts'));copyFileSync(resolve(import.meta.dir,'../src/startup.ts'),join(code,'src/startup.ts'));
  mkdirSync(join(code,'node_modules/zod'),{recursive:true});writeFileSync(join(code,'node_modules/zod/index.js'),'');
  writeFileSync(join(code,'src/live-cli.ts'),"import './deliberately-missing-local-module.ts'; export async function main() {}\n");
  const child=run(root,join(code,'src/live-entry.ts'));expect(child.status).toBe(2);expect(child.error).toBeUndefined();
  expect(JSON.parse(readFileSync(join(root,'data/astra-live/status.json'),'utf8')).reason).toBe('RUNTIME_DEPENDENCY_MISSING');
}));
