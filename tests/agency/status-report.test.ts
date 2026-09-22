import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StatusReporter} from '../../src/agency/status-report.ts';

test('unchanged blocked planner status is rate limited without hiding changes',()=>{
  const reporter=new StatusReporter(60_000);
  assert.equal(reporter.shouldReport('blocked:a',0),true);
  assert.equal(reporter.shouldReport('blocked:a',59_999),false);
  assert.equal(reporter.shouldReport('blocked:b',60_000),true);
  assert.equal(reporter.shouldReport('blocked:b',119_999),false);
  assert.equal(reporter.shouldReport('blocked:b',120_000),true);
});
