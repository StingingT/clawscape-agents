import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamManager } from '../../src/team/manager.ts';
import { writeJson, controlDir } from '../../src/team/storage.ts';
import type { WorkerSnapshot, Candidate } from '../../src/team/protocol.ts';
import { FeasibilityEvidence, LocalRoundTracker } from '../../src/team/local-diagnostics.ts';

const diag={kind:'capability-gap',summary:'The worker has no registered choices. More executor evidence is needed.',evidenceIds:['E1'],focus:'executor',recheck:'observe-and-replan'};
test('bounded executor episode is diagnostic evidence, never a command',()=>{
 const s:WorkerSnapshot={version:1,agent:'clawscout',session:'session',at:1000,context:'context',fingerprint:'f',connected:true,pending:false,stalled:true,progressAt:null,candidates:[],
   blocked:'EXECUTOR_CAPABILITY_EPISODE',executorEpisode:{failures:['gathering-batch','discovery:observed-transition-interaction'],recheckAt:2000}};
 const frame=new FeasibilityEvidence().frame(s,1000);
 assert.ok(frame.facts.some(f=>/Bounded executor capability episode.*gathering-batch.*observed-transition-interaction/.test(f.statement)));
  assert.equal(frame.facts.some(f=>/command|walk|interactLoc/i.test(f.statement)&&f.statement.includes('Bounded executor')),false);
});
test('a renewed executor recheck deadline does not manufacture fresh model evidence',()=>{
 const base:WorkerSnapshot={version:1,agent:'clawscout',session:'session',at:1000,context:'context',fingerprint:'f',connected:true,pending:false,stalled:true,progressAt:null,candidates:[],blocked:'EXECUTOR_CAPABILITY_EPISODE recheck at 2026-09-19T12:00:00.000Z',executorEpisode:{failures:['gathering-batch'],recheckAt:2000}};
 const evidence=new FeasibilityEvidence(),tracker=new LocalRoundTracker(),first=evidence.evidenceKey(base,1000);assert.equal(tracker.gate(base,first,1000),'call');tracker.start(base,first,1000);tracker.finish(base,1,true,true,1000);
 const renewed={...base,at:3000,executorEpisode:{failures:['gathering-batch'],recheckAt:4000},blocked:'EXECUTOR_CAPABILITY_EPISODE recheck at 2026-09-19T12:01:00.000Z'};
 const next=evidence.evidenceKey(renewed,3000);assert.equal(next,first);assert.equal(tracker.gate(renewed,next,62_000),'waiting-new-evidence');
});
async function fixture(fn:(h:any)=>Promise<void>){
  const root=mkdtempSync(join(tmpdir(),'herdr-gap-test-')),realNow=Date.now,realFetch=globalThis.fetch;
  let now=1_800_000_000_000,output:any=diag,fail=false,hold:undefined|((value:Response)=>void);
  const requests:any[]=[];
  Date.now=()=>now;
  globalThis.fetch=(async(url:any,init:any)=>{
    const body=JSON.parse(init.body);requests.push({url:String(url),body});
    if(String(url).endsWith('/api/show'))return new Response(JSON.stringify({details:{family:'qwen3'}}));
    if(!body.prompt)return new Response('{}'); // Explicit unload is not inference.
    if(fail)return new Response('do not persist this raw response',{status:503});
    if(output==='hold')return await new Promise<Response>((resolve,reject)=>{
      hold=resolve;init.signal.addEventListener('abort',()=>reject(new Error('LOCAL_CANCELLED')),{once:true});
    });
    return new Response(JSON.stringify({done:true,response:JSON.stringify(output),thinking:'not part of advice'}));
  }) as typeof fetch;
  writeJson(join(controlDir(root),'config.json'),{version:1,localModel:'qwen3:8b',codexBinary:'DO_NOT_LAUNCH_CODEX'});
  const m=new TeamManager(root);clearInterval((m as any).timer);
  let s:WorkerSnapshot={version:1,agent:'clawscout',session:m.session.id,workerRun:'real-test-run',at:now,
    context:'test-kit',fingerprint:'f',connected:true,pending:false,stalled:true,progressAt:now-1000,candidates:[],
    blocked:'No safe executable goal',planning:{version:1,clearance:'ready',unavailable:[]}};
  m.session.modes.clawscout='running';m.snapshots=()=>({clawscout:s});
  const h={m,root,requests,get s(){return s},set s(v:WorkerSnapshot){s=v},get now(){return now},
    reply(v:any){output=v},fail(v:boolean){fail=v},release(v:any){hold?.(new Response(JSON.stringify({done:true,response:JSON.stringify(v)})))},
    advance(ms:number,patch:Partial<WorkerSnapshot>={}){now+=ms;s={...s,at:now,fingerprint:'f'+now,...patch};(m as any).tick()},
    async settle(){await (m as any).local?.done;},
    async ready(){(m as any).tick();for(let i=0;i<120;i++)this.advance(5000);await this.settle()},
    inference(){return requests.filter(x=>x.body.prompt)} };
  try{await fn(h);}finally{await m.close().catch(()=>{});globalThis.fetch=realFetch;Date.now=realNow;rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
test('real manager waits ten eligible active minutes then diagnoses an empty set instead of requesting Codex',async()=>{
  await fixture(async h=>{
    (h.m as any).tick();for(let i=0;i<119;i++)h.advance(5000);
    assert.equal(h.inference().length,0);assert.equal(h.m.approvals.rows.length,0);
    h.advance(5000);await h.settle();
    assert.equal(h.inference().length,1);assert.equal(h.m.localReports[0].mode,'capability-gap');
    assert.equal(h.m.localReports[0].outcome,'diagnosis');assert.equal(h.m.approvals.rows.length,0);
    assert.deepEqual(h.m.session.objectives,{});assert.equal(h.m.children.size,0);
    const saved=JSON.parse(readFileSync(join(controlDir(h.root),'ollama-latest.json'),'utf8'));
    assert.equal(saved.reports[0].diagnosis.kind,'capability-gap');assert.equal(saved.reports[0].preferenceIssued,false);
    assert.ok(!JSON.stringify(saved).includes('not part of advice'));
  });
});
test('same evidence keeps ordinary rechecks running without repeated Ollama or Codex requests',async()=>{
  await fixture(async h=>{await h.ready();for(let i=0;i<180;i++)h.advance(5000);await h.settle();
    assert.equal(h.inference().length,1);assert.equal(h.m.approvals.rows.length,0);
    assert.match(h.m.localSummary(),/waiting for changed evidence/);
  });
});
test('changed facts allow bounded local follow-ups; third completion does not skip the final recheck',async()=>{
  await fixture(async h=>{
    await h.ready();
    for(let n=2;n<=3;n++){
      for(let i=0;i<12;i++)h.advance(5000,{blocked:'Distinct observed blocker '+n});
      await h.settle();assert.equal(h.inference().length,n);assert.equal(h.m.approvals.rows.length,0);
    }
    for(let i=0;i<12;i++)h.advance(5000);
    assert.equal(h.m.approvals.rows.filter((x:any)=>x.status==='requested').length,1);
    assert.equal((h.m as any).consultant,undefined);assert.equal(h.m.children.size,0);
  });
});
test('three local transport failures are reported, not silently turned into automatic Codex requests',async()=>{
  await fixture(async h=>{h.fail(true);await h.ready();
    for(let n=0;n<2;n++){for(let i=0;i<12;i++)h.advance(5000);await h.settle();}
    for(let i=0;i<24;i++)h.advance(5000);
    assert.equal(h.inference().length,3);assert.equal(h.m.approvals.rows.length,0);
    assert.ok(h.m.localReports.every((x:any)=>x.outcome==='error'&&x.error==='LOCAL_HTTP_503'));
    assert.ok(!JSON.stringify(h.m.localReports).includes('do not persist'));
    assert.match(h.m.localSummary(),/no automatic Codex request/);
  });
});
test('pending recovery never calls the local model despite elapsed wall time',async()=>{
  await fixture(async h=>{h.s={...h.s,pending:true,planning:{version:1,clearance:'recovery',unavailable:[]}};
    await h.ready();for(let i=0;i<180;i++)h.advance(5000);await h.settle();
    assert.equal(h.inference().length,0);assert.equal(h.m.approvals.rows.length,0);
  });
});
test('pause aborts in-flight local diagnostics; a reply cannot assign an objective afterward',async()=>{
  await fixture(async h=>{h.reply('hold');(h.m as any).tick();for(let i=0;i<120;i++)h.advance(5000);
    await new Promise(r=>setImmediate(r));assert.equal(h.inference().length,1);
    h.m.pause('clawscout');await h.settle();
    assert.equal(h.m.localReports[0].outcome,'aborted');assert.deepEqual(h.m.session.objectives,{});
    assert.equal(h.m.approvals.rows.length,0);
  });
});
test('diagnostic command-shaped output is rejected and never reaches game preferences',async()=>{
  await fixture(async h=>{h.reply({...diag,goalId:'invented'});await h.ready();
    assert.equal(h.m.localReports[0].outcome,'error');assert.equal(h.m.localReports[0].error,'LOCAL_DIAGNOSIS_OUTSIDE_CONTRACT');
    assert.deepEqual(h.m.session.objectives,{});assert.equal(h.m.approvals.rows.length,0);
  });
});
test('goal-only local advice still requires the same allowed plan on a fresh stalled snapshot',async()=>{
  await fixture(async h=>{
    const c:Candidate={id:'listed',domain:'gathering',source:'collection',reason:'Test plan',target:{fact:'result',minimum:1},
      plan:{registered:true,family:'gathering',firstMethodId:'m',capability:'gathering',steps:1,durationMs:1000,costGp:0,lossBoundGp:0}};
    h.s={...h.s,candidates:[c]};h.reply('hold');
    (h.m as any).startLocalConsultation('clawscout',h.s,'e');await new Promise(r=>setImmediate(r));
    h.s={...h.s,fingerprint:'new',at:h.now,candidates:[{...c,target:{fact:'different',minimum:1}}]};
    h.release({goalId:'listed',reason:'Use registered choice'});await h.settle();
    assert.equal(h.m.localReports[0].outcome,'rejected');assert.deepEqual(h.m.session.objectives,{});
  });
});
