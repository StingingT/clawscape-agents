import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EscalationTracker,ESCALATION,problemKey,safeForAdvice} from '../../src/team/escalation.ts';
import {ApprovalBook} from '../../src/team/approvals.ts';
import {TeamManager} from '../../src/team/manager.ts';
import {requestSummary,requestDetails,statusText} from '../../src/team/presentation.ts';
import {initialModes,type WorkerSnapshot,type Candidate} from '../../src/team/protocol.ts';
import {writeJson,controlDir,readJson} from '../../src/team/storage.ts';

const base=1_000_000;
const candidate=(id:string,family=id,registered=true):Candidate=>({id,domain:'gathering',reason:'Fresh own plan evidence',source:'collection',target:{fact:'result:'+family,minimum:1},
  plan:{family,registered,firstMethodId:'method:'+family,capability:family,steps:1,durationMs:1000,costGp:0,lossBoundGp:0}});
function snap(patch:Partial<WorkerSnapshot>={}):WorkerSnapshot{return {version:1,agent:'clawscout',session:'test-session',workerRun:'run',at:base,context:'skills-and-kit',fingerprint:'scope-a',
  connected:true,pending:false,stalled:true,progressAt:base-30_854_000,currentGoal:'current',
  planning:{version:1,clearance:'ready',currentFamily:'current-family',unavailable:[]},candidates:[],...patch};}
const observe=(e:EscalationTracker,s:WorkerSnapshot,ms:number)=>e.observe('clawscout',{...s,at:base+ms},'running',s.session,base+ms);
function run(e:EscalationTracker,s:WorkerSnapshot,from:number,to:number){let v=e.view(s.agent);for(let n=from;n<=to;n+=5000)v=observe(e,s,n);return v;}
function fixture(t:any){const r=mkdtempSync(join(tmpdir(),'escalation-test-'));t.after(()=>rmSync(r,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return r;}

test('the supplied historic 30854-second productive age cannot authorize immediate escalation',()=>{
  const e=new EscalationTracker(),s=snap({pending:true,blocked:'Observing a fresh 30-second current-context window; the historical command is not replayed.'});
  const first=observe(e,s,0);assert.equal(first.phase,'recovering');assert.equal(first.eligible,false);
  const second=observe(e,{...s,pending:false,currentGoal:'another-coordinate'},28_668);
  assert.equal(second.eligible,false);assert.equal(second.noProgressMs,0);
});

test('fresh pending reconciliation accumulates diagnostic stall time but earns no escalation time',()=>{
  const e=new EscalationTracker(),s=snap({pending:true,blocked:'Historical outcome is still reconciling.'});
  const v=run(e,s,0,60_000);
  assert.ok(v.noProgressMs>=55_000);assert.equal(v.decisionNoProgressMs,0);assert.equal(v.eligible,false);assert.equal(v.phase,'recovering');
});

test('pause, disconnect and verified progress end the diagnostic active-stall episode',()=>{
  const s=snap(),e=new EscalationTracker();run(e,s,0,60_000);assert.ok(e.view(s.agent).noProgressMs>=55_000);
  e.observe(s.agent,{...s,at:base+65_000},'paused',s.session,base+65_000);assert.equal(e.view(s.agent).noProgressMs,0);
  const d=new EscalationTracker();run(d,s,0,60_000);d.observe(s.agent,{...s,connected:false,at:base+65_000},'running',s.session,base+65_000);assert.equal(d.view(s.agent).noProgressMs,0);
  const p=new EscalationTracker();run(p,s,0,60_000);const progress=base+65_000;const pv=observe(p,{...s,progressAt:progress},65_000);assert.equal(pv.noProgressMs,0);assert.equal(pv.decisionNoProgressMs,0);
});

test('duplicate observations and long polling gaps never accrue active stall time',()=>{
  const e=new EscalationTracker(),s=snap();observe(e,s,0);
  for(let n=1;n<100;n++)e.observe(s.agent,s,'running',s.session,base+n*1000);
  assert.equal(e.view(s.agent).noProgressMs,0);
  assert.equal(observe(e,s,900_000).noProgressMs,0);
});

test('paused, disconnected, recovery and changed worker run time cannot count toward escalation',()=>{
  for(const mode of ['paused','disconnected','pending','safety','new-run'] as const){
    const e=new EscalationTracker(),s=snap();run(e,s,0,60_000);
    let changed={...s,at:base+65_000};
    if(mode==='disconnected')changed.connected=false;
    if(mode==='pending')changed.pending=true;
    if(mode==='safety')changed.planning={...s.planning!,clearance:'safety'};
    if(mode==='new-run')changed.workerRun='replacement';
    e.observe(s.agent,changed,mode==='paused'?'paused':'running',s.session,base+65_000);
    const after=observe(e,s,900_000);assert.equal(after.eligible,false);assert.ok(after.noProgressMs<=60_000);
  }
});

test('catalogue rows without fresh registered plan metadata cannot be autonomous fallbacks',()=>{
  const e=new EscalationTracker(),s=snap({candidates:[candidate('unregistered','unregistered',false)]});
  const v=run(e,s,0,120_000);assert.equal(v.nextGoal,undefined);
  const legacy=snap({planning:undefined});assert.equal(run(new EscalationTracker(),legacy,0,900_000).eligible,false);
});

test('an admissible different family is tried locally before any model, not chosen by character name',()=>{
  const e=new EscalationTracker(),s=snap({candidates:[candidate('same-coordinate','current-family'),candidate('different-method')]});
  assert.equal(run(e,s,0,115_000).nextGoal,undefined);
  const v=observe(e,s,120_000);assert.equal(v.phase,'local-replan');assert.equal(v.nextGoal,'different-method');assert.equal(v.eligible,false);
});

test('three acknowledged and actually selected distinct plans and ten active minutes can justify one help request',()=>{
  const e=new EscalationTracker(),s=snap({candidates:['method-a','method-b','method-c'].map(id=>candidate(id))});
  let t=0;
  for(let i=0;i<3;i++){
    const v=run(e,s,t,(i+1)*120_000);assert.equal(v.phase,'local-replan');
    const c=s.candidates.find(c=>c.id===v.nextGoal)!;e.markTrial(s.agent,c,'objective-'+i);
    s.currentGoal=c.id;s.planning={...s.planning!,currentFamily:c.plan!.family};
    s.objectiveReceipt={id:'objective-'+i,status:'accepted',reason:'Preference admitted, execution still checked.'};t=(i+1)*120_000+5000;
  }
  assert.equal(run(e,s,t,480_000).eligible,false);
  const ready=run(e,s,485_000,600_000);assert.equal(ready.eligible,true);assert.equal(ready.trials,3);
  const why=e.why(s,'automatic');assert.equal(why.localTrials,3);assert.ok(why.evidence.every(v=>v.includes('no verified progress')));
});

test('unacknowledged preferences and coordinate variants are not three failed gameplay attempts',()=>{
  const e=new EscalationTracker(),s=snap({candidates:[candidate('tile-a','one-family'),candidate('tile-b','one-family')]});
  const v=run(e,s,0,120_000);e.markTrial(s.agent,s.candidates[0]!,'not-acknowledged');
  const after=run(e,s,125_000,900_000);assert.equal(after.trials,0);assert.equal(after.nextGoal,undefined);assert.equal(after.eligible,false);
});

test('ten active minutes plus repeated fresh empty-plan checks explain a capability gap without inventing attempts',()=>{
  const e=new EscalationTracker(),s=snap();assert.equal(run(e,s,0,595_000).eligible,false);
  const v=observe(e,s,600_000);assert.equal(v.eligible,true);assert.equal(v.trials,0);assert.ok(v.rechecks>=3);
  assert.equal(e.why(s,'automatic').localTrials,0);
});

test('verified progress resets current-run escalation without erasing the historical progress record',()=>{
  const e=new EscalationTracker(),s=snap();run(e,s,0,600_000);
  const progress=base+605_000,v=observe(e,{...s,progressAt:progress},605_000);
  assert.equal(v.eligible,false);assert.equal(v.noProgressMs,0);assert.equal(v.trials,0);
});

test('protected/recovery clearances forbid automatic advice even if candidates look plausible',()=>{
  for(const clearance of ['safety','recovery'] as const){
    const s=snap({planning:{version:1,clearance,unavailable:[]},candidates:[candidate('work')]});
    assert.equal(safeForAdvice(s),false);assert.equal(run(new EscalationTracker(),s,0,900_000).eligible,false);
  }
});

test('one outstanding request per agent survives coordinate/fingerprint changes without editing the approved scope',t=>{
  const b=new ApprovalBook(join(fixture(t),'a.json'),base),s=snap(),r=b.request(s,base);const hash=r.scopeHash;
  const changed=snap({at:base+28_668,fingerprint:'scope-b',currentGoal:'other-tile'});
  assert.equal(problemKey(s),problemKey(changed));assert.equal(b.request(changed,base+28_668).id,r.id);
  assert.equal(r.scopeHash,hash);assert.equal(r.snapshot.currentGoal,'current');assert.equal(b.rows.filter(r=>r.status==='requested').length,1);
});

test('pause and stop invalidate pending approvals instead of leaving obsolete approve buttons',t=>{
  for(const mode of ['paused','stopped'] as const){
    const b=new ApprovalBook(join(fixture(t),mode+'.json'),base),s=snap(),r=b.request(s,base);
    b.reconcile({clawscout:s},{...initialModes(),clawscout:mode},s.session,base+1000);
    assert.equal(r.status,'cancelled');assert.throws(()=>b.consume(r.id,r.scopeHash.slice(0,12),base+1000),/NOT_PENDING/);
    assert.equal('approve' in requestDetails(r),false);
  }
});

test('changed pending state, goal, fingerprint and progress invalidate exact request scopes',t=>{
  for(const patch of [{pending:true},{currentGoal:'changed'},{fingerprint:'changed'},{progressAt:base+1}]){
    const b=new ApprovalBook(join(fixture(t),'a.json'),base),s=snap(),r=b.request(s,base);
    b.reconcile({clawscout:snap(patch)},{...initialModes(),clawscout:'running'},s.session,base+1000);
    assert.equal(r.status,'cancelled');assert.throws(()=>b.consume(r.id,r.scopeHash.slice(0,12),base+1000),/NOT_PENDING/);
  }
});

test('recovery requests are refused at the approval book boundary',t=>{
  const b=new ApprovalBook(join(fixture(t),'a.json'),base);assert.throws(()=>b.request(snap({pending:true}),base),/RECOVERY_PENDING/);assert.equal(b.rows.length,0);
});

test('denial cooldown persists across restarts and tiny coordinate variations',t=>{
  const f=join(fixture(t),'a.json'),b=new ApprovalBook(f,base),s=snap(),r=b.request(s,base);b.deny(r.id,base+1);
  const restarted=new ApprovalBook(f,base+3000);
  const again=restarted.request(snap({at:base+3000,fingerprint:'moved',currentGoal:'tile-b'}),base+3000);
  assert.equal(again.id,r.id);assert.equal(again.status,'denied');
});

test('failed/running consultations cannot be launched again by another request or consumed twice',t=>{
  const b=new ApprovalBook(join(fixture(t),'a.json'),base),r=b.request(snap(),base);
  b.consume(r.id,r.scopeHash.slice(0,12),base+1);
  assert.equal(b.request(snap({fingerprint:'other'}),base+2).status,'running');
  b.finish(r.id,'failed','No retry.',base+3);
  assert.equal(b.request(snap({fingerprint:'another'}),base+4).status,'failed');
  assert.throws(()=>b.consume(r.id,r.scopeHash.slice(0,12),base+5),/NOT_PENDING/);
});

test('reason/evidence are part of the approved scope and cannot be silently rewritten',t=>{
  const b=new ApprovalBook(join(fixture(t),'a.json'),base),e=new EscalationTracker(),s=snap();
  const r=b.request(s,base,e.why(s,'operator'));r.why!.summary='modified after display';
  assert.throws(()=>b.consume(r.id,r.scopeHash.slice(0,12),base+1),/SCOPE/);
});

test('status and requests have bounded readable summaries; exact scope is explicit',t=>{
  const b=new ApprovalBook(join(fixture(t),'a.json'),base),s=snap(),e=new EscalationTracker(),r=b.request(s,base,e.why(s,'operator'));
  const summary=requestSummary(b.rows);assert.match(summary,/Why:/);assert.doesNotMatch(summary,/skills-and-kit|fingerprint/);
  assert.deepEqual(requestDetails(r).snapshot,s);
  const status=statusText('ready',{clawscout:{status:'paused'}},{clawscout:s},{},b.rows,base);
  assert.match(status,/TEAM STATUS/);assert.match(status,/clawscout \| paused/);assert.match(status,/dashboard/);assert.doesNotMatch(status,/\x1b\[2J/);
  const recovering=statusText('ready',{clawscout:{status:'running'}},{clawscout:{...s,stalled:true,blocked:'No executable step'}},{},[],base);
  assert.match(recovering,/recovering/);assert.match(recovering,/Blocker: No executable step/);
  const stale=statusText('ready',{},{},{},[],base,true);
  assert.match(stale,/DEPLOYMENT REQUIRED/);assert.match(stale,/reload, then start all/);
});

test('real manager automatic gate ignores the old request timestamps and queues no help during recovery',async t=>{
  const root=fixture(t),m=new TeamManager(root);t.after(()=>m.close());m.session.modes.clawscout='running';
  const s=snap({session:m.session.id,at:Date.now(),pending:true});
  writeJson(join(controlDir(root),'workers/clawscout.json'),s);(m as any).monitorOnce();
  assert.equal(m.approvals.rows.length,0);assert.equal(m.session.objectives.clawscout,undefined);
  assert.equal(m.escalationStatus('clawscout').phase,'recovering');
  assert.throws(()=>m.requestHelp(s),/RECOVERY_PENDING/);
});

test('actual manager cancels an old request on stop and never overwrites game memory',async t=>{
  const root=fixture(t),m=new TeamManager(root);t.after(()=>m.close());m.session.modes.clawscout='running';
  const s=snap({session:m.session.id,at:Date.now()});writeJson(join(controlDir(root),'workers/clawscout.json'),s);
  mkdirSync(join(root,'data/online'),{recursive:true});writeJson(join(root,'data/online/agency-v2.json'),{sentinel:'retained'});
  const before=readFileSync(join(root,'data/online/agency-v2.json')),r=m.requestHelp(s)!;
  await m.stop('clawscout');assert.equal(r.status,'cancelled');assert.deepEqual(readFileSync(join(root,'data/online/agency-v2.json')),before);
  await assert.rejects(()=>m.approve(r.id,r.scopeHash.slice(0,12),true));assert.equal(m.children.size,0);
});

test('changes in reason invalidate no original scope and cancelled churn is rate-limited persistently',t=>{
  const f=join(fixture(t),'a.json'),b=new ApprovalBook(f,base),s=snap(),r=b.request(s,base);
  b.cancelFor(s.agent,'Scope changed.',base+29_000);
  const next=new ApprovalBook(f,base+30_000),again=next.request(snap({fingerprint:'tile-variant'}),base+30_000);
  assert.equal(again.id,r.id);assert.equal(again.status,'cancelled');
  assert.equal(next.rows.length,1);
});

test('archived denial retains a problem cooldown, not just an entry in the bounded hot list',t=>{
  const f=join(fixture(t),'a.json'),b=new ApprovalBook(f,base);let first='';
  for(let i=0;i<23;i++){const r=b.request(snap({context:'distinct-context-'+i}),base+i);if(i===0)first=r.id;b.deny(r.id,base+i);}
  assert.ok(b.rows.length<=20);assert.equal(b.rows.some(r=>r.id===first),false);
  const again=new ApprovalBook(f,base+1000);
  assert.throws(()=>again.request(snap({context:'distinct-context-0',fingerprint:'changed'}),base+1000),/COOLDOWN/);
});

test('manually asking for help does not bypass mode, recovery or approval requirements',async t=>{
  const root=fixture(t),m=new TeamManager(root);t.after(()=>m.close());
  const s=snap({session:m.session.id,at:Date.now()});writeJson(join(controlDir(root),'workers/clawscout.json'),s);
  assert.throws(()=>m.requestHelp(s),/STATE_CHANGED/);
  m.session.modes.clawscout='running';const r=m.requestHelp(s)!;
  assert.equal(r.status,'requested');assert.equal(r.why?.origin,'operator');assert.equal(m.children.size,0);
  await assert.rejects(()=>m.approve(r.id,r.scopeHash.slice(0,12),false),/HUMAN/);
  assert.equal(r.status,'requested');
});

test('unavailable approval persistence cannot skip explicit worker stop cleanup',async t=>{
  const root=fixture(t),m=new TeamManager(root);t.after(()=>m.close());
  m.session.modes.clawscout='running';
  const saved=m.approvals.cancelFor.bind(m.approvals);
  m.approvals.cancelFor=()=>{throw new Error('simulated approval persistence failure');};
  await assert.rejects(()=>m.stop('clawscout'),/persistence/);
  assert.equal(m.session.modes.clawscout,'stopped');assert.equal(m.processes.clawscout?.status,'stopped');
  m.approvals.cancelFor=saved;
});

test('a merely accepted preference is not a selected local trial when the worker keeps another goal',()=>{
  const e=new EscalationTracker(),s=snap({candidates:[candidate('work')]});
  run(e,s,0,120_000);e.markTrial(s.agent,s.candidates[0]!,'preference');
  s.objectiveReceipt={id:'preference',status:'accepted',reason:'Preference only.'};
  const v=run(e,s,125_000,900_000);assert.equal(v.trials,0);assert.equal(v.eligible,false);
});

test('pause during restart backoff cancels retry authority without a live child',async t=>{
  const root=fixture(t),m=new TeamManager(root);t.after(()=>m.close());m.session.modes.clawscout='running';
  m.processes.clawscout={status:'retry-backoff',retryAt:Date.now()-1};
  m.pause('clawscout');(m as any).monitorOnce();
  assert.equal(m.session.modes.clawscout,'paused');assert.equal(m.processes.clawscout?.retryAt,undefined);assert.equal(m.children.size,0);
});

test('model advice cannot turn an unregistered catalogue entry into an executable preference',async t=>{
  const root=fixture(t),m=new TeamManager(root);t.after(()=>m.close());m.session.modes.clawscout='running';
  const s=snap({session:m.session.id,at:Date.now(),candidates:[candidate('not-registered','family',false)]});
  writeJson(join(controlDir(root),'workers/clawscout.json'),s);
  assert.equal(m.applyAdvice(s,{goalId:'not-registered',reason:'merely listed'}),false);
  assert.equal(m.session.objectives.clawscout,undefined);assert.equal(m.children.size,0);
});

test('a small available repertoire can escalate after trying all alternatives and repeated rechecks, without inventing a third plan',()=>{
  const e=new EscalationTracker(),s=snap({candidates:[candidate('method-a'),candidate('method-b')]});
  let from=0;
  for(let i=0;i<2;i++){
    const v=run(e,s,from,(i+1)*120_000),c=s.candidates.find(c=>c.id===v.nextGoal)!;
    e.markTrial(s.agent,c,'objective-'+i);s.currentGoal=c.id;s.planning={...s.planning!,currentFamily:c.plan!.family};
    s.objectiveReceipt={id:'objective-'+i,status:'accepted',reason:'Selected.'};from=(i+1)*120_000+5000;
  }
  const v=run(e,s,from,600_000);assert.equal(v.trials,2);assert.ok(v.rechecks>=3);assert.equal(v.eligible,true);
});
