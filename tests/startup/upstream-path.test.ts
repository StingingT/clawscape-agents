import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkedUpstream } from '../../agents/advanced/src/startup.ts';
import { REQUIRED_UPSTREAM_FILES, resolveUpstream, safePathFailure, UpstreamPathError } from '../../agents/advanced/src/upstream-path.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'astra-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'agent-repo/agents/advanced');
  mkdirSync(runtimeRoot, { recursive: true });
  return { root, runtimeRoot };
}
function checkout(root: string) {
  for (const file of REQUIRED_UPSTREAM_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '// inert fixture; never imported by the test\n');
  }
  return root;
}
function configure(runtimeRoot: string, game_root: unknown, name = 'config.local.json') {
  writeFileSync(join(runtimeRoot, name), JSON.stringify({ game_root, token: 'SECRET_MUST_NOT_BE_LOGGED' }));
}

test('uses configured checkout instead of broken agents/tmp location', t => {
  const f = fixture(t), upstream = checkout(join(f.root, 'tmp/clawscape/upstream'));
  configure(f.runtimeRoot, relative(f.runtimeRoot, upstream));
  const result = resolveUpstream({ runtimeRoot: f.runtimeRoot, env: {} });
  assert.equal(result.upstream, upstream);
  assert.equal(result.source, 'game_root');
  assert.notEqual(result.upstream, resolve(f.runtimeRoot, '../tmp/clawscape/upstream'));
});
test('absolute game_root works regardless of working directory', t => {
  const f = fixture(t), upstream = checkout(join(f.root, 'server checkout with spaces'));
  configure(f.runtimeRoot, upstream);
  assert.equal(resolveUpstream({ runtimeRoot: f.runtimeRoot, env: {} }).upstream, upstream);
});
test('explicit map override takes precedence without reading credentials', t => {
  const f = fixture(t), upstream = checkout(join(f.root, 'chosen-server'));
  configure(f.runtimeRoot, '/nonexistent/stale/server');
  assert.equal(resolveUpstream({ runtimeRoot: f.runtimeRoot, env: { CLAWSCAPE_UPSTREAM: upstream } }).upstream, upstream);
});
test('explicit wrong map path does not silently choose another valid map', t => {
  const f = fixture(t), upstream = checkout(join(f.root, 'configured-server'));
  configure(f.runtimeRoot, upstream);
  assert.throws(() => resolveUpstream({ runtimeRoot: f.runtimeRoot, env: { CLAWSCAPE_UPSTREAM: join(f.root, 'wrong') } }), /UPSTREAM_COLLISION_FILES_MISSING/);
});
test('custom config override supports non-default config names', t => {
  const f = fixture(t), upstream = checkout(join(f.root, 'test-world'));
  configure(f.runtimeRoot, upstream, 'local-test.json');
  assert.equal(resolveUpstream({ runtimeRoot: f.runtimeRoot, env: { CLAWSCAPE_ASTRA_CONFIG: 'local-test.json' } }).upstream, upstream);
});
test('explicit config option takes precedence over config environment option', t => {
  const f = fixture(t), upstream = checkout(join(f.root, 'test-world'));
  configure(f.runtimeRoot, upstream, 'explicit.json');
  assert.equal(resolveUpstream({ runtimeRoot: f.runtimeRoot, configFile: 'explicit.json', env: { CLAWSCAPE_ASTRA_CONFIG: 'absent.json' } }).upstream, upstream);
});
test('missing config produces a specific safe error', t => {
  const f = fixture(t);
  assert.throws(() => resolveUpstream({ runtimeRoot: f.runtimeRoot, env: {} }), /ASTRA_CONFIG_FILE_MISSING/);
});
test('invalid JSON does not leak its secret-bearing content', t => {
  const f = fixture(t);
  writeFileSync(join(f.runtimeRoot, 'config.local.json'), '{ SECRET_MUST_NOT_BE_LOGGED invalid');
  try { resolveUpstream({ runtimeRoot: f.runtimeRoot, env: {} }); assert.fail('must reject'); }
  catch (error) { assert.equal(safePathFailure(error).code, 'ASTRA_CONFIG_FILE_INVALID'); assert.ok(!JSON.stringify(error).includes('SECRET_MUST_NOT_BE_LOGGED')); }
});
test('blank, non-path and invalid game_root values are rejected', t => {
  const f = fixture(t);
  for (const value of ['', null, 123, 'https://example.invalid/server', 'bad\0path']) {
    configure(f.runtimeRoot, value);
    assert.throws(() => resolveUpstream({ runtimeRoot: f.runtimeRoot, env: {} }), /ASTRA_GAME_ROOT_INVALID/);
  }
});
test('reports missing files individually, not just pathfinding.ts', t => {
  const f = fixture(t), upstream = checkout(join(f.root, 'server'));
  configure(f.runtimeRoot, upstream);
  rmSync(join(upstream, REQUIRED_UPSTREAM_FILES[1]));
  try { resolveUpstream({ runtimeRoot: f.runtimeRoot, env: {} }); assert.fail('must reject'); }
  catch (error) { assert.deepEqual(safePathFailure(error), { code: 'UPSTREAM_COLLISION_FILES_MISSING', missingFiles: [REQUIRED_UPSTREAM_FILES[1]] }); }
});
test('a directory named like a required file is not accepted', t => {
  const f = fixture(t), upstream = checkout(join(f.root, 'server'));
  configure(f.runtimeRoot, upstream);
  rmSync(join(upstream, REQUIRED_UPSTREAM_FILES[0])); mkdirSync(join(upstream, REQUIRED_UPSTREAM_FILES[0]));
  assert.throws(() => resolveUpstream({ runtimeRoot: f.runtimeRoot, env: {} }), /UPSTREAM_COLLISION_FILES_MISSING/);
});
test('arbitrary low-level errors are not serialized to the user', () => {
  assert.deepEqual(safePathFailure(new Error('secret=NOT_FOR_LOGS')), { code: 'UPSTREAM_PATH_CHECK_FAILED' });
});
test('both collision workers use the same resolver and keep pathfinding initialization', () => {
  const src = fileURLToPath(new URL('../../agents/advanced/src/', import.meta.url));
  for (const name of ['live-map-worker.ts', 'recovery-map-worker.ts']) {
    const text = readFileSync(join(src, name), 'utf8');
    assert.ok(text.includes('resolveUpstream()'));
    assert.ok(!text.includes("../../tmp/clawscape/upstream"));
    assert.ok(text.includes('rsmod-pathfinder.js'));
  }
  assert.ok(readFileSync(join(src,'live-map-worker.ts'),'utf8').includes('map.initPathfinding()'));
});

function preflightFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t), repo = resolve(f.runtimeRoot, '../..');
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  for (const file of ['scripts/astra-preflight.ts','agents/advanced/src/upstream-path.ts','agents/advanced/src/startup.ts']) {
    mkdirSync(dirname(join(repo,file)), {recursive:true});
    writeFileSync(join(repo,file),readFileSync(join(sourceRoot,file)));
  }
  mkdirSync(join(f.runtimeRoot,'docs'),{recursive:true});
  writeFileSync(join(f.runtimeRoot,'docs/compatibility-profile.json'),'{}');
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--experimental-strip-types',join(repo,'scripts/astra-preflight.ts'), ...args], {
    encoding:'utf8', timeout:5000, env:{...process.env,CLAWSCAPE_UPSTREAM:undefined,CLAWSCAPE_ASTRA_CONFIG:undefined,CLAWSCAPE_ASTRA_HOME:undefined,...env},
  });
  return {...f,run};
}
test('preflight script passes inert local path fixtures without importing server modules', t => {
  const f=preflightFixture(t), upstream=checkout(join(f.root,'server'));
  configure(f.runtimeRoot,upstream);
  const result=f.run(); assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.pathChecksPassed,true);assert.equal(report.gameConnectionAttempted,false);
  assert.ok(!result.stdout.includes('SECRET_MUST_NOT_BE_LOGGED'));assert.equal(report.config.schemaValidated,false);
});
test('preflight script reports missing map files without exposing config contents', t => {
  const f=preflightFixture(t);configure(f.runtimeRoot,join(f.root,'absent'));
  const result=f.run();assert.equal(result.status,2);
  const report=JSON.parse(result.stdout);assert.equal(report.failure.code,'UPSTREAM_COLLISION_FILES_MISSING');
  assert.equal(report.failure.missingFiles.length,3);assert.ok(!result.stdout.includes('SECRET_MUST_NOT_BE_LOGGED'));
});
test('preflight script does not replace absent config with a newly created one', t => {
  const f=preflightFixture(t),result=f.run();assert.equal(result.status,2);
  assert.equal(JSON.parse(result.stdout).failure.code,'CONFIG_NOT_READABLE');
  assert.throws(()=>readFileSync(join(f.runtimeRoot,'config.local.json')));
});
test('preflight leaves existing journals and credentials byte-for-byte unchanged', t => {
  const f=preflightFixture(t), upstream=checkout(join(f.root,'server'));configure(f.runtimeRoot,upstream);
  const journal=join(f.runtimeRoot,'data/astra-live/agency-v2.json');mkdirSync(dirname(journal),{recursive:true});
  writeFileSync(journal,'{"pending":"must-not-change"}');const configBefore=readFileSync(join(f.runtimeRoot,'config.local.json'),'utf8');
  assert.equal(f.run().status,0);assert.equal(readFileSync(journal,'utf8'),'{'+'"pending":"must-not-change"}');
  assert.equal(readFileSync(join(f.runtimeRoot,'config.local.json'),'utf8'),configBefore);
});

test('startup checkedUpstream and workers resolve the same explicit relative override', t => {
  const f=fixture(t),upstream=checkout(join(f.root,'chosen'));
  const override=relative(f.runtimeRoot,upstream);
  assert.equal(checkedUpstream(f.runtimeRoot,'not-used',override),upstream);
  assert.equal(resolveUpstream({runtimeRoot:f.runtimeRoot,env:{CLAWSCAPE_UPSTREAM:override}}).upstream,upstream);
});
test('startup validates a parsed game_root without re-reading a different configuration', t => {
  const f=fixture(t),upstream=checkout(join(f.root,'custom-config-target'));
  configure(f.runtimeRoot,'wrong-default');
  assert.equal(resolveUpstream({runtimeRoot:f.runtimeRoot,gameRoot:upstream,env:{}}).upstream,upstream);
});
test('configured invalid path cannot fall back to the obsolete agents/tmp map', t => {
  const f=fixture(t);checkout(resolve(f.runtimeRoot,'../tmp/clawscape/upstream'));
  assert.throws(()=>checkedUpstream(f.runtimeRoot,'invalid-game-root'),/UPSTREAM_COLLISION_FILES_MISSING/);
});
test('an explicitly empty override is invalid at startup, not permission to use another map', t => {
  const f=fixture(t),upstream=checkout(join(f.root,'valid'));
  assert.throws(()=>checkedUpstream(f.runtimeRoot,upstream,''),/UPSTREAM_OVERRIDE_INVALID/);
});
test('preflight follows the live runtime-root flag while leaving saved state alone', t => {
  const f=preflightFixture(t),home=join(f.root,'existing runtime'),upstream=checkout(join(f.root,'server'));
  mkdirSync(join(home,'docs'),{recursive:true});writeFileSync(join(home,'docs/compatibility-profile.json'),'{}');
  configure(home,upstream);mkdirSync(join(home,'data/astra-live'),{recursive:true});
  const status=join(home,'data/astra-live/status.json');writeFileSync(status,'{"running":"unchanged"}');
  const result=f.run(['--runtime-root',home]);assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).runtimeRoot,home);assert.equal(readFileSync(status,'utf8'),'{"running":"unchanged"}');
});
test('preflight follows the live runtime-home environment selection', t => {
  const f=preflightFixture(t),home=join(f.root,'old-runtime'),upstream=checkout(join(f.root,'server'));
  mkdirSync(join(home,'docs'),{recursive:true});writeFileSync(join(home,'docs/compatibility-profile.json'),'{}');configure(home,upstream);
  const result=f.run([],{CLAWSCAPE_ASTRA_HOME:home});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).runtimeRoot,home);
});
test('preflight honors custom config in the selected runtime home', t => {
  const f=preflightFixture(t),upstream=checkout(join(f.root,'alternate-world'));
  configure(f.runtimeRoot,upstream,'alternate.json');
  const result=f.run(['--config','alternate.json']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).upstream,upstream);
});
test('preflight refuses ambiguous old and packaged homes without modifying either', t => {
  const f=preflightFixture(t),old=resolve(f.runtimeRoot,'../../../clawscape-autonomous-agent'),upstream=checkout(join(f.root,'server'));
  mkdirSync(old,{recursive:true});configure(old,upstream);configure(f.runtimeRoot,upstream);
  const result=f.run();assert.equal(result.status,2);assert.equal(JSON.parse(result.stdout).failure.code,'AMBIGUOUS_ASTRA_RUNTIME_HOME');
});
test('preflight rejects repeated, incomplete and unknown flags without starting anything', t => {
  const f=preflightFixture(t);
  for(const args of [['--config'],['--start'],['--config','a','--config','b'],['--runtime-root','']]) {
    const result=f.run(args);assert.equal(result.status,2);assert.equal(JSON.parse(result.stdout).failure.code,'INVALID_ARGUMENTS');
  }
});
