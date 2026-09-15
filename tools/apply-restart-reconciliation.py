from pathlib import Path

def rep(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'anchor missing: {path}')
    p.write_text(s.replace(old,new,1))

rep('src/agency/live-adapter.ts',
"  // Existing controller adapters retain compatibility; semantics remain operation-specific.\n  settleNavigation(commandId:string,state:LiveState):Verification|undefined { return this.settleStep(commandId,state); }",
"""  /** Retire a non-transactional receipt inherited from an earlier runtime when two fresh own observations
   * still cannot attribute its terminal effect. This never calls the executor and never records success.
   * Purchases, bank transfers and dialogue choices remain strict because replay could duplicate value/choice. */
  retireRestartPending(scope:'task'|'safety',first:LiveState,stable:LiveState,reason:string):boolean {
    const receipt=scope==='safety'?this.document.safetyReceipt:this.document.receipt;
    if(!receipt)return false;
    const strict=new Set(['shopBuy','shopSell','bankDeposit','bankWithdraw','clickDialogOption']);
    if(strict.has(receipt.action.type))return false;
    const a=first.player,b=stable.player;
    if(first.inGame!==true||stable.inGame!==true||!a||!b||a.isDead||b.isDead
      ||![first.tick,stable.tick,a.worldX,a.worldZ,a.level,b.worldX,b.worldZ,b.level].every(Number.isFinite)
      ||Number(stable.tick)<=Number(first.tick))return false;
    for(const field of ['character','world','worldEpoch','profileId'] as const)
      if((first as any)[field]!==undefined&&(first as any)[field]!== (stable as any)[field])return false;
    const evidence=[`restart-fresh-observations:${first.tick}->${stable.tick}`,
      `stale-${receipt.action.type}-retired-without-replay`,
      'Historical effect remains unknown; a future action must be selected and validated from fresh state.'];
    const deaths=Math.max(0,Number(b.respawnCount??0)-Number(receipt.before.player?.respawnCount??0));
    this.record(receipt.commandId,stable,{status:'interrupted',evidence,reason:'RESTART_UNATTRIBUTED_NONTRANSACTIONAL_ACTION: '+reason},
      {spentGp:0,lostGp:0,deaths,elapsedMs:Math.max(0,this.clock()-receipt.startedAt)});
    return !(scope==='safety'?this.document.safetyReceipt:this.document.receipt);
  }
  // Existing controller adapters retain compatibility; semantics remain operation-specific.
  settleNavigation(commandId:string,state:LiveState):Verification|undefined { return this.settleStep(commandId,state); }""")

rep('src/agent.ts',
"""  let state=stateFrom(await cliCall(['state']));
  if(existsSync(actionIntentPath)||existsSync(resolve(dataDir,'agency-memory.json'))) {""",
"""  let state=stateFrom(await cliCall(['state']));
  // A receipt already present before this episode belongs to an earlier runtime/episode. Observe twice first:
  // prove its effect normally when possible; otherwise abandon only non-transactional bookkeeping, never replay it.
  if(agency.pending()||agency.pending('safety')) {
    await cliCall(['wait','2']);
    const stable=stateFrom(await cliCall(['state']));
    for(const scope of ['safety','task'] as const) {
      const old=agency.pending(scope);if(!old)continue;
      const check=verifyActionOutcome(old.before,stable,old.action,old.execution);
      if(!check.uncertain)agency.record(old.commandId,stable,verification(check));
      else agency.retireRestartPending(scope,state,stable,check.reason??'terminal effect is no longer attributable after restart');
    }
    state=stable;
  }
  if(existsSync(actionIntentPath)||existsSync(resolve(dataDir,'agency-memory.json'))) {""")

rep('agents/advanced/src/store.ts',
"this.db.query(\"UPDATE control SET mode='RECONCILING',lease=?,owner=?,expires=?\").run(lease,owner,now+5000);",
"this.db.query(\"UPDATE control SET mode='RECONCILING',lease=?,owner=?,expires=?\").run(lease,owner,now+15000);")
rep('agents/advanced/src/store.ts',
"this.db.query(\"UPDATE control SET expires=? WHERE lease=?\").run(now + 5000, lease);",
"this.db.query(\"UPDATE control SET expires=? WHERE lease=?\").run(now + (c.mode==='RECONCILING'?15000:5000), lease);")

rep('agents/advanced/src/live-cli.ts',
"""    let recovery=reconcileAstraJournals(store,data,first,latest,agency);
    const settleUntil=Date.now()+45_000;""",
"""    // Explicit renewal around potentially expensive journal scans prevents scheduler/SQLite stalls from
    // turning a valid sole-controller recovery lease into RECOVERY_LEASE_REQUIRED mid-reconciliation.
    store.renew(lease,Date.now());
    let recovery=reconcileAstraJournals(store,data,first,latest,agency);
    const settleUntil=Date.now()+45_000;""")
rep('agents/advanced/src/live-cli.ts',
"""      await sleep(1_000);const previous=latest;latest=await adapter.snapshot();
      recovery=reconcileAstraJournals(store,data,previous,latest,agency);""",
"""      await sleep(1_000);const previous=latest;latest=await adapter.snapshot();
      store.renew(lease,Date.now());
      recovery=reconcileAstraJournals(store,data,previous,latest,agency);""")

p=Path('tests/agency/live-integration.test.ts');s=p.read_text();anchor="test('a different success cannot finalize an old pending command'"
addition="""test('restart can abandon an unattributed old movement without replay or success',t=>{\n  const f=fixture(t,{supported:['food']}),a=f.agency,before=s({tick:10});a.begin(select(a,before),{id:'old-route',type:'walkTo',fields:{x:3300,z:3300,level:0}},before,'old-walk');\n  a.record('old-walk',before,{status:'unknown',evidence:[],reason:'navigation clock reset'});\n  const first=s({tick:20}),stable=s({tick:21});assert.equal(a.retireRestartPending('task',first,stable,'clock reset'),true);\n  assert.equal(a.pending(),undefined);assert.equal(a.summary().lastOutcome?.status,'interrupted');\n  assert.match(a.summary().lastOutcome?.reason??'',/RESTART_UNATTRIBUTED/);assert.ok(!a.summary().lastOutcome?.evidence.some(e=>/success/i.test(e)));\n});\ntest('restart does not abandon value-moving transactions without attribution',t=>{\n  const f=fixture(t,{supported:['food']}),a=f.agency,before=s({tick:10,inventory:[{id:995,name:'Coins',slot:0,count:100}],shop:{isOpen:true,shopItems:[{id:303,slot:0,count:5,buyPrice:10}]}});\n  a.begin(select(a,before),{id:'buy',type:'shopBuy',fields:{slot:0,amount:1}},before,'old-buy');\n  a.record('old-buy',before,{status:'unknown',evidence:[],reason:'transport lost'});\n  assert.equal(a.retireRestartPending('task',s({tick:20}),s({tick:21}),'restart'),false);assert.equal(a.pending()?.commandId,'old-buy');\n});\n"""
if anchor not in s: raise SystemExit('test anchor missing')
p.write_text(s.replace(anchor,addition+anchor,1))

Path('agents/advanced/tests/recovery-lease.test.ts').write_text("""import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {mkdtempSync,rmSync} from 'node:fs';\nimport {tmpdir} from 'node:os';\nimport {join} from 'node:path';\nimport {Store} from '../src/store.ts';\n\ntest('recovery lease has restart-tolerant horizon and renews without becoming action authority',t=>{\n  const dir=mkdtempSync(join(tmpdir(),'astra-lease-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));\n  const store=new Store(join(dir,'journal.sqlite'));t.after(()=>store.close());\n  const lease=store.acquireRecovery('test',1000);let c=store.control();assert.equal(c.mode,'RECONCILING');assert.equal(c.lease,lease);assert.equal(c.expires,16000);\n  store.renew(lease,5000);c=store.control();assert.equal(c.mode,'RECONCILING');assert.equal(c.expires,20000);\n});\n""")
