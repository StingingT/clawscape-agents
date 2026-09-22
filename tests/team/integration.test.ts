import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { TeamManager } from '../../src/team/manager.ts';
import { controlDir, readJson, writeJson } from '../../src/team/storage.ts';
import { initialModes, type TeamSession, type WorkerSnapshot } from '../../src/team/protocol.ts';
import { teamPlanning, workerMode } from '../../src/team/worker.ts';
import { createMemory, Director } from '../../src/agency/director.ts';
import { LiveAgency, isSelection } from '../../src/agency/live-adapter.ts';
import { buildCatalogue, emptyKnowledge, defaultPolicy, type Catalogue } from '../../src/agency/world-model.ts';
const identity={agent:'coincrafter',world:'test-world',revision:'test'};
const state=()=>({character:identity.agent,world:identity.world,inGame:true,tick:1,
  player:{hp:30,maxHp:30,lifeId:1,respawnCount:0,worldX:10,worldZ:10,level:0,animId:-1,combat:{inCombat:false,targetType:'none',lastDamageTick:-1}},
  inventory:[],equipment:[],skills:[],nearbyLocs:[],nearbyNpcs:[],bank:{isOpen:false,items:[]},dialog:{isOpen:false},shop:{isOpen:false}});
function fixture(t:any){const root=mkdtempSync(join(tmpdir(),'team-integration-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return root;}
function control(root:string,at:number){
  const s:TeamSession={version:1,id:randomUUID(),pid:process.pid,at,active:true,modes:{...initialModes(),coincrafter:'running'},objectives:{}};
  writeJson(join(controlDir(root),'enabled.json'),{version:1});writeJson(join(controlDir(root),'session.json'),s);
  return {s,env:{CLAWSCAPE_TEAM_ROOT:root,CLAWSCAPE_TEAM_SESSION:s.id,CLAWSCAPE_TEAM_AGENT:'coincrafter'},save:()=>writeJson(join(controlDir(root),'session.json'),s)};
}
function objective(c:Catalogue,id:string,at=1000){return {id:randomUUID(),agent:'coincrafter' as const,goalId:id,context:c.view.context,issuedAt:at,expiresAt:at+300_000,replace:true,reason:'Temporary evidence-based choice'};}
function environment(env:NodeJS.ProcessEnv,fn:()=>void){const old={...process.env};try{Object.assign(process.env,env);fn();}finally{for(const k of Object.keys(env)){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}}

test('a current overseer preference reaches the real shared planner, without adding facts or actions',t=>{
  const root=fixture(t),x=control(root,1000),d=new Director(createMemory(identity));
  const c=buildCatalogue(identity,state(),emptyKnowledge(),defaultPolicy,['exploration'],d.memory,1000);
  const desired=c.opportunities.at(-1)!;assert.ok(desired);x.s.objectives.coincrafter=objective(c,desired.id);x.save();
  const facts=JSON.stringify(c.view.facts),methods=JSON.stringify(c.methods);
  const preference=teamPlanning(c,d,true,false,undefined,x.env,1000);
  assert.equal(preference,desired.id);
  const chosen=d.next(c.view,c.opportunities,c.methods,preference);assert.equal(chosen.type,'execute');
  if(chosen.type==='execute')assert.equal(chosen.goal.id,desired.id);
  assert.equal(JSON.stringify(c.view.facts),facts);assert.equal(JSON.stringify(c.methods),methods);
});

test('shared LiveAgency publishes own candidates and consumes a preference through its actual plan entry point',t=>{
  const root=fixture(t),x=control(root,1000);
  environment(x.env,()=>{
    const agency=new LiveAgency(join(root,'agency.json'),identity,{supported:['exploration'],now:()=>1000});
    const c=agency.catalogue(state()),target=c.opportunities.at(-1)!;x.s.objectives.coincrafter=objective(c,target.id);x.save();
    const chosen=agency.plan(state());assert.ok(isSelection(chosen));assert.equal(chosen.decision.goal.id,target.id);
    const s=readJson<WorkerSnapshot>(join(controlDir(root),'workers/coincrafter.json'))!;
    assert.equal(s.session,x.s.id);assert.equal(s.objectiveReceipt?.status,'accepted');
    assert.equal('inventory' in s,false);assert.equal('before' in s,false);
  });
});

test('a real LiveAgency executor episode publishes bounded diagnostic evidence without candidates',t=>{
  const root=fixture(t),x=control(root,1000);
  environment(x.env,()=>{
    const agency=new LiveAgency(join(root,'agency.json'),identity,{supported:['exploration'],now:()=>1000}),current=state();
    for(const id of ['gathering-batch','production-batch','discovery:observed-transition-interaction'])
      (agency as any).recordExecutorFailure(current,id);
    const result=agency.plan(current);assert.equal(result.type,'blocked');
    const snapshot=readJson<WorkerSnapshot>(join(controlDir(root),'workers/coincrafter.json'))!;
    assert.deepEqual(snapshot.executorEpisode?.failures,['gathering-batch','production-batch','discovery:observed-transition-interaction']);
    assert.equal(snapshot.candidates.length,0);assert.match(snapshot.blocked??'',/EXECUTOR_CAPABILITY_EPISODE/);
    assert.equal(snapshot.stalled,true,'a terminal executor episode must enter the shared bounded-recovery signal immediately');
  });
});

test('a pending historical command cannot be retired or replaced by an overseer preference',t=>{
  const root=fixture(t),x=control(root,1000);
  environment(x.env,()=>{
    const agency=new LiveAgency(join(root,'agency.json'),identity,{supported:['exploration'],now:()=>1000});
    const chosen=agency.plan(state());assert.ok(isSelection(chosen));
    agency.begin(chosen,{id:'bounded',type:'wait'},state(),'original-command');
    agency.record('original-command',state(),{status:'unknown',evidence:[],reason:'unattributed'});
    const c=agency.catalogue(state()),other=c.opportunities.find(g=>g.id!==chosen.decision.goal.id)!;
    x.s.objectives.coincrafter=objective(c,other.id);x.save();
    const original=JSON.stringify(agency.pending());const result=agency.plan(state());
    assert.equal(result.type,'reconcile');assert.equal(JSON.stringify(agency.pending()),original);
    assert.equal(agency.director.memory.active!.id,chosen.decision.goal.id);
  });
});

test('expired, unobserved, wrong-context and paused preferences never change the current plan',t=>{
  const root=fixture(t),x=control(root,1000),d=new Director(createMemory(identity));
  const c=buildCatalogue(identity,state(),emptyKnowledge(),defaultPolicy,['exploration'],d.memory,1000),id=c.opportunities[0]!.id;
  for(const patch of [{goalId:'manufactured-goal'},{context:'other'},{expiresAt:900},{issuedAt:2000}]){
    x.s.objectives.coincrafter={...objective(c,id),...patch};x.save();assert.equal(teamPlanning(c,d,true,false,undefined,x.env,1000),undefined);
  }
  x.s.objectives.coincrafter=objective(c,id);x.s.modes.coincrafter='paused';x.save();
  assert.equal(teamPlanning(c,d,true,false,undefined,x.env,1000),undefined);assert.equal(d.memory.active,undefined);
});

test('a healthy committed plan does not change merely because another goal was suggested',t=>{
  const root=fixture(t),x=control(root,1000),d=new Director(createMemory(identity));
  const c=buildCatalogue(identity,state(),emptyKnowledge(),defaultPolicy,['exploration'],d.memory,1000);
  const first=d.next(c.view,c.opportunities,c.methods);assert.equal(first.type,'execute');if(first.type!=='execute')return;
  d.memory.progress={since:1000,lastProductiveAt:1000,noProgressActions:0,recentStates:[]};
  const id=c.opportunities.find(g=>g.id!==first.goal.id)!.id;x.s.objectives.coincrafter=objective(c,id);x.save();
  const p=teamPlanning(c,d,true,false,undefined,x.env,1000),next=d.next(c.view,c.opportunities,c.methods,p);
  assert.equal(next.type,'execute');if(next.type==='execute')assert.equal(next.goal.id,first.goal.id);
});

test('overseer preference cannot override an unknown-risk method or a high-priority need',()=>{
  const memory=createMemory(identity),d=new Director(memory);
  const view:any={...identity,context:'safe',at:1000,facts:{supply:0,progress:0},capabilities:['work'],budget:{spendableGp:0,maxLossGp:0,maxDeaths:0,maxDurationMs:60000}};
  const goal=(id:string,source:string):any=>({id,domain:'gathering',target:{fact:id,minimum:1},source,reason:'observed need',evidence:['own']});
  const method=(id:string,risk:string):any=>({id,domain:'gathering',capability:'work',effects:{[id]:1},prerequisites:[],risk,costGp:0,lossBoundGp:0,durationMs:1000});
  const goals=[goal('supply','need'),goal('progress','frontier')];
  for(const risk of ['safe','unknown']){
    const next=new Director(createMemory(identity)).next(view,goals,[method('supply','safe'),method('progress',risk)],'progress');
    assert.equal(next.type,'execute');if(next.type==='execute')assert.equal(next.goal.id,'supply');
  }
});

async function until(fn:()=>boolean,max=6000){const end=Date.now()+max;while(!fn()){if(Date.now()>end)throw new Error('FIXTURE_TIMEOUT');await new Promise(r=>setTimeout(r,30));}}
function fakeWorker(root:string){
  const source=`const fs=require('node:fs'),path=require('node:path');
    const root=process.env.CLAWSCAPE_TEAM_ROOT,name=process.env.CLAWSCAPE_TEAM_AGENT;
    const file=path.join(root,'data','team-control',name+'-fixture.json');
    const timer=setInterval(()=>{const s=JSON.parse(fs.readFileSync(path.join(root,'data','team-control','session.json'),'utf8'));
    fs.writeFileSync(file,JSON.stringify({pid:process.pid,mode:s.modes[name]}));
    if(!s.active||s.modes[name]==='stopped'){clearInterval(timer);process.exit(0);}},30);`;
  // Both entry shapes are covered: tests run under Node and under Bun.
  writeFileSync(join(root,'run'),source);mkdirSync(join(root,'src'),{recursive:true});writeFileSync(join(root,'src/agent.ts'),source);
}

test('manager start/pause/resume/stop operates a real owned child; Stop All leaves no worker restart authority',async t=>{
  const root=fixture(t);fakeWorker(root);const m=new TeamManager(root);t.after(()=>m.close());
  m.start('coincrafter');await until(()=>!!readJson(join(controlDir(root),'coincrafter-fixture.json')));
  const first=m.children.get('coincrafter')!.pid;assert.ok(first);
  m.start('coincrafter');assert.equal(m.children.get('coincrafter')!.pid,first,'start cannot duplicate a controller');
  m.pause('coincrafter');await until(()=>readJson<any>(join(controlDir(root),'coincrafter-fixture.json'))?.mode==='paused');
  m.start('coincrafter');await until(()=>readJson<any>(join(controlDir(root),'coincrafter-fixture.json'))?.mode==='running');
  await m.stop('coincrafter');assert.equal(m.children.size,0);assert.equal(m.session.modes.coincrafter,'stopped');
  m.start('coincrafter');await until(()=>m.children.get('coincrafter')?.pid!==first);
  await Promise.all([m.close(),m.close()]);assert.equal(m.children.size,0);assert.equal(m.session.active,false);
  assert.ok(Object.values(m.session.modes).every(x=>x==='stopped'));
  const next=new TeamManager(root);assert.equal(next.children.size,0);assert.equal(next.session.objectives.coincrafter,undefined);await next.close();
});

test('stale consultant advice cannot assign a new objective after a changed session or current state',async t=>{
  const root=fixture(t),m=new TeamManager(root);t.after(()=>m.close());m.session.modes.coincrafter='running';
  const s:WorkerSnapshot={version:1,agent:'coincrafter',session:m.session.id,at:Date.now(),context:'one',fingerprint:'old',connected:true,pending:false,stalled:true,progressAt:null,
    candidates:[{id:'work',domain:'crafting',reason:'own evidence',source:'collection',target:{fact:'xp:crafting',minimum:1}}]};
  writeJson(join(controlDir(root),'workers/coincrafter.json'),{...s,fingerprint:'new'});
  m.applyAdvice(s,{goalId:'work',reason:'old advice'});assert.equal(m.session.objectives.coincrafter,undefined);
  assert.throws(()=>m.requestHelp(s),/STATE_CHANGED/);
  const r=m.approvals.request(s); // A scope created before the state changed.
  await assert.rejects(()=>m.approve(r.id,r.scopeHash.slice(0,12),true),/STATE_CHANGED/);
  assert.equal(m.approvals.find(r.id).status,'cancelled');await m.close();
});

test('real manager locally prefers a registered alternative and the real worker revalidates the handoff',async t=>{
  const root=fixture(t),realNow=Date.now;let now=2_000_000;Date.now=()=>now;
  const m=new TeamManager(root);
  try{
    m.session.modes.coincrafter='running';m.save();
    const env={CLAWSCAPE_TEAM_ROOT:root,CLAWSCAPE_TEAM_SESSION:m.session.id,CLAWSCAPE_TEAM_AGENT:'coincrafter'};
    const d=new Director(createMemory(identity));d.memory.progress={since:1000,lastProductiveAt:1000,noProgressActions:20,recentStates:[]};
    // The gathering alternative must be an observed executable affordance,
    // rather than the old synthetic batch that existed in an empty scene.
    const world:any=state();world.inventory=[{id:1351,name:'Bronze axe',slot:0,count:1}];world.skills=[{name:'woodcutting',baseLevel:1,experience:0}];
    world.nearbyLocs=[{id:1,name:'Tree',x:11,z:10,level:0,reachable:true,optionsWithIndex:[{opIndex:1,text:'Chop down'}]}];
    let c=buildCatalogue(identity,world,emptyKnowledge(),defaultPolicy,['production','gathering','exploration'],d.memory,now);
    const exploring=c.opportunities.filter(g=>g.domain==='exploration');assert.ok(exploring.length);
    d.next(c.view,exploring,c.methods);const original=d.memory.active!.id;
    for(let n=0;n<=120_000;n+=5000){
      now=2_000_000+n;c=buildCatalogue(identity,world,emptyKnowledge(),defaultPolicy,['production','gathering','exploration'],d.memory,now);
      teamPlanning(c,d,true,false,undefined,env,now,false);(m as any).monitorOnce();
    }
    const assigned=m.session.objectives.coincrafter;assert.ok(assigned);assert.notEqual(assigned.goalId,original);
    const snapshot=readJson<WorkerSnapshot>(join(controlDir(root),'workers/coincrafter.json'))!;
    assert.ok(snapshot.candidates.find(c=>c.id===assigned.goalId)?.plan?.registered);assert.equal(m.approvals.rows.length,0);
    const facts=JSON.stringify(c.view.facts),methods=JSON.stringify(c.methods);
    const preferred=teamPlanning(c,d,true,false,undefined,env,now,true);
    assert.equal(preferred,assigned.goalId);
    const choice=d.next(c.view,c.opportunities,c.methods,preferred);assert.equal(choice.type,'execute');
    if(choice.type==='execute')assert.equal(choice.goal.id,assigned.goalId);
    assert.equal(JSON.stringify(c.view.facts),facts);assert.equal(JSON.stringify(c.methods),methods);
  }finally{Date.now=realNow;await m.close();}
});
