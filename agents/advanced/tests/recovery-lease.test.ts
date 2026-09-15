import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.ts';

test('recovery lease has restart-tolerant horizon and renews without becoming action authority',t=>{
  const dir=mkdtempSync(join(tmpdir(),'astra-lease-'));
  const store=new Store(join(dir,'journal.sqlite'));
  t.after(()=>{
    store.close();
    rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const lease=store.acquireRecovery('test',1000);let c=store.control();assert.equal(c.mode,'RECONCILING');assert.equal(c.lease,lease);assert.equal(c.expires,16000);
  store.renew(lease,5000);c=store.control();assert.equal(c.mode,'RECONCILING');assert.equal(c.expires,20000);
});
