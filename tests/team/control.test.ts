import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalBook } from '../../src/team/approvals.ts';
import { agentName, digest, fresh, initialModes, text, type WorkerSnapshot, type TeamSession } from '../../src/team/protocol.ts';
import { readJson, writeJson, controlDir, teamEnabled } from '../../src/team/storage.ts';
import { acquireTeamController } from '../../src/team/lease.ts';
import { TeamManager, job } from '../../src/team/manager.ts';
import { workerMode, teamPlanning } from '../../src/team/worker.ts';
import { parseAdvice, consultantEnvironment, consultantSpec, localAdvice } from '../../src/team/models.ts';
import { panelCommand } from '../../src/team/herdr.ts';
import { capture, launch, terminate } from '../../src/team/process.ts';
import { createMemory, Director } from '../../src/agency/director.ts';
import { buildCatalogue, emptyKnowledge, defaultPolicy } from '../../src/agency/world-model.ts';
const identity={agent:'coincrafter',world:'test-world',revision:'v1'};
function fixture(t:any){const root=mkdtempSync(join(tmpdir(),'team-test-'));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));return root;}
const snapshot=(patch:Partial<WorkerSnapshot>={}):WorkerSnapshot=>({version:1,agent:'coincrafter',session:'owned',at:1000,context:'same',fingerprint:'f',connected:true,pending:false,
  stalled:true,progressAt:null,candidates:[{id:'goal-a',domain:'crafting',source:'collection',reason:'Available personal goal',target:{fact:'xp:crafting',minimum:100}}],...patch});
function session(root:string,at=1000){
 const dir=controlDir(root);writeJson(join(dir,'enabled.json'),{version:1});
 const s:TeamSession={version:1,id:'owned',pid:process.pid,at,active:true,modes:{...initialModes(),coincrafter:'running'},objectives:{}};
 writeJson(join(dir,'session.json'),s);return s;
}
const env=(root:string)=>({CLAWSCAPE_TEAM_ROOT:root,CLAWSCAPE_TEAM_SESSION:'owned',CLAWSCAPE_TEAM_AGENT:'coincrafter'});

test('default state is off; unknown profile names and terminal control text are rejected',()=>{
 assert.ok(Object.values(initialModes()).every(s=>s==='stopped'));assert.throws(()=>agentName('../other'),/UNKNOWN/);
 assert.equal(text('\x1b]52;copy\x07\n'), ' ]52;copy  ');
});
test('worker gate is inert until explicit setup, then fails closed without a matching owner',t=>{
 const root=fixture(t);assert.equal(workerMode('coincrafter',{CLAWSCAPE_TEAM_ROOT:root},1000),'unmanaged');session(root);
 assert.equal(workerMode('coincrafter',{CLAWSCAPE_TEAM_ROOT:root},1000),'stopped');
 assert.equal(workerMode('coincrafter',env(root),1000),'running');assert.equal(workerMode('stinger',env(root),1000),'stopped');
 assert.equal(workerMode('coincrafter',env(root),22_000),'stopped');assert.equal(workerMode('coincrafter',env(root),900),'stopped');
});
test('paused, stopped, corrupt and replaced control sessions never permit dispatch',t=>{
 const root=fixture(t);const s=session(root);
 for(const mode of ['paused','stopped'] as const){s.modes.coincrafter=mode;writeJson(join(controlDir(root),'session.json'),s);assert.equal(workerMode('coincrafter',env(root),1000),mode);}
 s.modes.coincrafter='running';s.id='replacement';writeJson(join(controlDir(root),'session.json'),s);assert.equal(workerMode('coincrafter',env(root),1000),'stopped');
 writeFileSync(join(controlDir(root),'session.json'),'{broken');assert.equal(workerMode('coincrafter',env(root),1000),'stopped');
});
test('snapshots cannot be reused after stop/restart or accepted from the future',()=>{
 assert.equal(fresh(snapshot(),'owned',1000),true);assert.equal(fresh(snapshot(),'new',1000),false);
 assert.equal(fresh(snapshot(),'owned',62_000),false);assert.equal(fresh(snapshot(),'owned',999),false);
});
test('local controller lock refuses duplicates and never deletes replacement ownership',t=>{
 const root=fixture(t),f=join(root,'lock.json'),release=acquireTeamController(f);
 assert.throws(()=>acquireTeamController(f),/already owns/);writeJson(f,{pid:process.pid,nonce:'different'});release();assert.ok(existsSync(f));
});
test('corrupt or symlinked control files are not replaced with empty state',t=>{
 const root=fixture(t),f=join(root,'state.json');writeFileSync(f,'broken');assert.throws(()=>readJson(f),/CORRUPT/);
 const target=join(root,'target');writeFileSync(target,'original');
 try{symlinkSync(target,join(root,'alias'));}catch(e){if(process.platform==='win32')return;throw e;}
 assert.throws(()=>writeJson(join(root,'alias'),{}),/SYMLINK/);assert.equal(readFileSync(target,'utf8'),'original');
});
test('approval is exact-scope, one-use and saved before launch',t=>{
 const book=new ApprovalBook(join(fixture(t),'approvals.json'),1000),r=book.request(snapshot(),1000);
 assert.equal(book.request(snapshot(),2000).id,r.id);assert.throws(()=>book.consume(r.id,'wrong',2000),/MISMATCH/);
 const approved=book.consume(r.id,r.scopeHash.slice(0,12),2000);assert.equal(approved.status,'running');
 assert.throws(()=>book.consume(r.id,r.scopeHash.slice(0,12),2000),/NOT_PENDING/);
});
test('tampered or expired scope cannot launch a paid request',t=>{
 const b=new ApprovalBook(join(fixture(t),'a.json'),1000),r=b.request(snapshot(),1000);r.question='changed';
 assert.throws(()=>b.consume(r.id,r.scopeHash.slice(0,12),2000),/SCOPE/);
 const b2=new ApprovalBook(join(fixture(t),'a.json'),1000),r2=b2.request(snapshot(),1000);
 assert.throws(()=>b2.consume(r2.id,r2.scopeHash.slice(0,12),999999),/EXPIRED/);
});
test('denial and failed consultation are terminal, never automatic paid retries',t=>{
 const b=new ApprovalBook(join(fixture(t),'a.json'),1000),r=b.request(snapshot(),1000);b.deny(r.id);
 assert.throws(()=>b.consume(r.id,r.scopeHash.slice(0,12),1001),/NOT_PENDING/);assert.equal(b.request(snapshot(),2000).status,'denied');
});
test('restart retires in-flight and unapproved requests without reusing authority',t=>{
 const f=join(fixture(t),'a.json'),b=new ApprovalBook(f,1000),r=b.request(snapshot(),1000);
 b.consume(r.id,r.scopeHash.slice(0,12),2000);const restarted=new ApprovalBook(f,3000);
 assert.equal(restarted.find(r.id).status,'interrupted');assert.throws(()=>restarted.consume(r.id,r.scopeHash.slice(0,12),3000),/NOT_PENDING/);
});
test('model output is advice/known goal selection, never arbitrary tools or manufactured facts',()=>{
 assert.deepEqual(parseAdvice('{"goalId":"goal-a","reason":"useful"}',snapshot()),{goalId:'goal-a',reason:'useful'});
 for(const s of ['{"goalId":"go-to-specific-place","reason":"x"}','{"goalId":null,"reason":"x","command":"codex"}','not json'])assert.throws(()=>parseAdvice(s,snapshot()));
});
test('consultant has no gameplay/Herdr/API secrets and cannot enable a writable sandbox',()=>{
 const e=consultantEnvironment({PATH:'x',HOME:'h',CLAWSCAPE_HOME:'secret',HERDR_SOCKET:'socket',OPENAI_API_KEY:'not-inherited'});
 assert.deepEqual(e,{PATH:'x',HOME:'h'});const args=consultantSpec('codex','/tmp/private').args.join(' ');
 assert.match(args,/read-only/);assert.match(args,/shell_tool=false/);assert.match(args,/unified_exec=false/);
 assert.match(args,/multi_agent=false/);assert.match(args,/ignore-user-config/);assert.doesNotMatch(args,/danger-full-access|workspace-write|resume/);
});
test('local model requests cannot route to cloud and release memory after inference',async()=>{
 const calls:Array<{url:string;body:any}>=[];
 const mock=async(url:any,options:any)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify(calls.length===1?{details:{family:'local'}}:{response:'{"goalId":null,"reason":"Need information"}'}),{status:200});};
 const a=await localAdvice('installed:small',snapshot(),new AbortController().signal,mock as typeof fetch);
 assert.equal(a.goalId,null);assert.ok(calls.every(c=>c.url.startsWith('http://127.0.0.1:11434/')));
 assert.equal(calls[1]!.body.keep_alive,0);assert.equal(calls[1]!.body.options.num_ctx,4096);
 await assert.rejects(()=>localAdvice('anything:cloud',snapshot(),new AbortController().signal,mock as typeof fetch),/LOCAL/);
});
test('remote Ollama model metadata is rejected, without automatic pulling',async()=>{
 let n=0;await assert.rejects(()=>localAdvice('model',snapshot(),new AbortController().signal,(async()=>{n++;return new Response('{"remote_host":"https://remote","details":{}}');}) as typeof fetch),/CLOUD/);assert.equal(n,1);
});
test('Herdr commands quote arbitrary local paths rather than execute inserted text',()=>{
 const s=panelCommand("C:\\Guy's files\\bun.exe","C:\\repo;not-a-command\\team.ts",['ui'],true);
 assert.match(s,/^powershell.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
 const decoded=Buffer.from(s.split(' ').at(-1)!,'base64').toString('utf16le');assert.match(decoded,/Guy''s files/);
 assert.ok(panelCommand('/tmp/a b/bun',"/tmp/x'y",['ui'],false).startsWith("'/tmp/a b/bun'"));
});
test('opening and closing the manager starts no models/game processes and preserves saved character data',async t=>{
 const root=fixture(t);mkdirSync(join(root,'data/coincrafter'),{recursive:true});const f=join(root,'data/coincrafter/agency-v2.json');writeFileSync(f,'private-journal');
 const m=new TeamManager(root);assert.equal(m.children.size,0);assert.equal(m.config.localModel,null);assert.ok(Object.values(m.session.modes).every(x=>x==='stopped'));
 await assert.rejects(()=>m.approve('anything','x',false),/HUMAN/);await m.close();
 assert.equal(readFileSync(f,'utf8'),'private-journal');assert.equal(readJson<TeamSession>(join(controlDir(root),'session.json'))!.active,false);assert.equal(teamEnabled(root),true);
});
test('profile launch settings reuse existing identities but contain no forced gameplay objective',()=>{
 assert.ok(job('/repo','coincrafter').args.includes('coincrafter'));assert.ok(job('/repo','clawscout').args.includes('online'));
 assert.equal(job('/repo','astra').cwd,join('/repo','agents/advanced'));assert.ok(!job('/repo','stinger').args.includes('--goal'));
});
test('owned process execution is bounded and never uses a shell',async t=>{
 const root=fixture(t);assert.equal((await capture({file:process.execPath,args:['-e','process.stdout.write("ok")'],cwd:root})).trim(),'ok');
 await assert.rejects(()=>capture({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:root},'',100),/TIMED_OUT/);
});
test('stop terminates an owned child process without affecting arbitrary saved PIDs',async t=>{
 const root=fixture(t),c=launch({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:root});
 const done=new Promise(r=>c.once('close',r));await new Promise(r=>setTimeout(r,100));await terminate(c);await done;assert.ok(c.exitCode!==null||c.signalCode!==null);
});

test('completed approval history is archived without retaining an unbounded hot index',t=>{
 const root=fixture(t),b=new ApprovalBook(join(root,'a.json'),1000);let first='';
 for(let n=0;n<23;n++){const r=b.request(snapshot({fingerprint:'state-'+n,context:'different-capability-context-'+n}),1000+n);if(n===0)first=r.id;b.deny(r.id,1000+n);}
 assert.ok(b.rows.length<=20);assert.ok(existsSync(join(root,'approval-history',first+'.json')));
 assert.equal(readJson<any>(join(root,'approval-history',first+'.json')).status,'denied');
 assert.throws(()=>b.consume(first,'unused',2000),/NOT_UNIQUE/);
});
