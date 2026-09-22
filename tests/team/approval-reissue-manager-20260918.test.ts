import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {join} from 'node:path';
test('reissue keeps exact approval/advice guards and only clears manager throttle',()=>{const a=readFileSync(join(process.cwd(),'src/team/approvals.ts'),'utf8'),m=readFileSync(join(process.cwd(),'src/team/manager.ts'),'utf8'),e=readFileSync(join(process.cwd(),'src/team/escalation.ts'),'utf8');
assert.match(a,/fingerprint!==r\.snapshot\.fingerprint/);assert.match(a,/currentGoal!==r\.snapshot\.currentGoal/);assert.match(a,/progressAt!==r\.snapshot\.progressAt/);
assert.match(m,/s\.fingerprint!==preview\.snapshot\.fingerprint/);assert.match(m,/lastRequest\.delete\(agent\)/);
assert.match(e,/\.map\(t=>text\(t\.family\+'\: '\+t\.reason,350\)\)\.slice\(-6\)/);});
