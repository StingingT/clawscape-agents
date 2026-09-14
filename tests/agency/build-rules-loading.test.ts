import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBuildRules } from '../../src/agency/build-rules.ts';

const rules={version:1 as const,world:'clawscape',revision:'rev-1',source:'audited local server definitions at test revision',
  xpThresholds:{attack:[0,0,83]},effects:{},features:{}};

test('profile loader falls back to one shared audited data/build-rules.json',()=>{
  const root=mkdtempSync(join(tmpdir(),'build-rules-shared-'));
  try {
    const profile=join(root,'profile');mkdirSync(profile,{recursive:true});
    writeFileSync(join(root,'build-rules.json'),JSON.stringify(rules));
    const loaded=loadBuildRules(join(profile,'build-rules.json'),{world:'clawscape',revision:'rev-1'});
    assert.equal(loaded?.source,rules.source);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('profile-specific audited rules take precedence over shared rules',()=>{
  const root=mkdtempSync(join(tmpdir(),'build-rules-profile-'));
  try {
    const profile=join(root,'profile');mkdirSync(profile,{recursive:true});
    writeFileSync(join(root,'build-rules.json'),JSON.stringify(rules));
    writeFileSync(join(profile,'build-rules.json'),JSON.stringify({...rules,source:'profile-specific audit'}));
    const loaded=loadBuildRules(join(profile,'build-rules.json'),{world:'clawscape',revision:'rev-1'});
    assert.equal(loaded?.source,'profile-specific audit');
  } finally { rmSync(root,{recursive:true,force:true}); }
});
