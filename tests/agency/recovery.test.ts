import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LiveAgency,isSelection} from '../../src/agency/live-adapter.ts';
import {Navigator} from '../../src/navigation/controller.ts';
import {verifyActionOutcome,movementProgress} from '../../src/action-outcome.ts';
import {migrateLegacyPlanner} from '../../src/agency/legacy.ts';
import {runtimePaths,upstreamRoot} from '../../src/runtime-paths.ts';
import {inspectRuntime,describeFailure,runAstra} from '../../agents/advanced/src/startup.ts';

const state=(x=100,z=100,tick=1):any=>({tick,inGame:true,player:{worldX:x,worldZ:z,level:0,lifeId:1,hp:30,maxHp:30,respawnCount:0,combat:{inCombat:false,targetType:'none',targetIndex:-1,lastDamageTick:-1}},skills:[],inventory:[],equipment:[],nearbyNpcs:[],nearbyLocs:[],dialog:{isOpen:false}});
const route={id:'personal-lead',x:110,z:110,level:0,evidence:'own observed route'};
const identity={agent:'test',world:'test',revision:'fixture-v1'};
const action={id:'survey',type:'walkTo',fields:{x:110,z:110,level:0},waitTicks:2};
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'agency-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let clock=1000;
 const file=join(dir,'agency.json'),options={supported:['exploration'] as any,routes:[route],now:()=>clock};
 return {dir,file,options,a:new LiveAgency(file,identity,options),advance:(ms=2000)=>{clock+=ms;}};
}
function planned(a:LiveAgency,s:any){const p=a.plan(s);assert.ok(isSelection(p));return p;}

test('actual Navigator completes detour legs; planner keeps one unfinished route across a restart',async t=>{
 const f=fixture(t);let a=f.a,current=state(),target:any;
 const navigator=new Navigator({state:async()=>structuredClone(current),act:async(type,fields)=>{assert.equal(type,'walkTo');target=fields;return {success:true};},
  wait:async()=>{current={...current,tick:current.tick+2,player:{...current.player,worldX:target?.x??current.player.worldX,worldZ:target?.z??current.player.worldZ}};return structuredClone(current);}},join(f.dir,'navigation.json'),
  async()=>({legs:[{target:{x:98,z:100,level:0},doors:[]},{target:{x:98,z:110,level:0},doors:[]},{target:{x:110,z:110,level:0},doors:[]}],hash:'fixture',unmappedTiles:0}));
 t.after(()=>navigator.close());let goalKey:string|undefined;
 for(let n=0;n<3;n++){
  const p=planned(a,current);goalKey??=p.decision.goal.key;assert.equal(p.decision.goal.key,goalKey);
  const id='leg-'+n;a.begin(p,action,current,id);
  const trip=await navigator.step(route,current,false,(step,before)=>a.noteExecution(id,{id:'leg',...step},before));
  assert.equal(a.pending()?.action.fields?.x,110,'the route commitment must not be replaced by its waypoint');
  if(n===0){assert.equal(a.pending()?.execution?.action.fields?.x,98);a=new LiveAgency(f.file,identity,f.options);}
  current=trip.state;f.advance();
  const proof=a.reconcile(id,current);assert.equal(proof.status,'verified');a.record(id,current,proof);
  assert.equal(a.pending(),undefined);
  assert.equal(a.director.memory.reviews.length,n<2?0:1);
 }
 assert.equal(a.director.memory.reviews[0]?.result,'success');
 assert.ok(Object.values(a.director.memory.methods).every(m=>m.rejected===0));
});
test('equal distance to the final destination does not invalidate a proved leg',()=>{
 assert.equal(movementProgress({x:10,z:10,level:0},{x:12,z:10,level:0},{x:15,z:10,level:0}),true);
 assert.equal(verifyActionOutcome(state(100,100),state(102,100,2),{type:'walkTo',fields:{x:110,z:110,level:0}}).verified,false,'an unrecorded detour needs leg evidence, not guessed success');
});
test('unrelated movement, missing coordinates, plane change and death do not verify a leg',()=>{
 assert.equal(movementProgress({x:0,z:0,plane:0},{x:2,z:1,plane:0},{x:5,z:0,plane:0}),false);
 for(const patch of [{worldX:undefined},{level:1},{lifeId:2},{worldX:100,worldZ:100}]){
  const after=state(102,100,2);Object.assign(after.player,patch);
  assert.equal(verifyActionOutcome(state(),after,{type:'walkTo',fields:{x:108,z:100,level:0}}).verified,false);
 }
});
test('map loading without a dispatched command clears only the step, not the goal',t=>{
 const f=fixture(t),b=state(),p=planned(f.a,b);f.a.begin(p,action,b,'unsent');f.advance();
 const proof=f.a.reconcile('unsent',state(100,100,2),{navigation:{status:'loading-map'}});
 assert.equal(proof.status,'deferred');f.a.record('unsent',state(100,100,2),proof);
 assert.equal(f.a.pending(),undefined);assert.equal(f.a.director.memory.active?.key,p.decision.goal.key);
 assert.deepEqual(f.a.director.memory.methods,{});assert.equal(f.a.director.memory.reviews.length,0);
});
test('no-dispatch route rejection is terminal, not a perpetually pending movement',t=>{
 const f=fixture(t),b=state();f.a.begin(planned(f.a,b),action,b,'blocked');
 const proof=f.a.reconcile('blocked',b,{navigation:{status:'blocked',reason:'no-feasible-path'}});assert.equal(proof.status,'rejected');f.a.record('blocked',b,proof);assert.equal(f.a.pending(),undefined);
});
test('old stationary movement can be superseded without learning fictitious success',t=>{
 const f=fixture(t),b=state();f.a.begin(planned(f.a,b),action,b,'old');
 // Old v2 had no dispatch-state or subcommand field. Persist its real shape.
 const doc=JSON.parse(readFileSync(f.file,'utf8'));delete doc.receipt.dispatchState;writeFileSync(f.file,JSON.stringify(doc));
 const a=new LiveAgency(f.file,identity,f.options);f.advance(20_000);
 assert.equal(a.reconcile('old',state(98,100,2)).status,'unknown');f.advance();
 const proof=a.reconcile('old',state(98,100,4));assert.equal(proof.status,'deferred');a.record('old',state(98,100,4),proof);
 assert.equal(a.pending(),undefined);assert.equal(a.director.memory.reviews.length,0);assert.deepEqual(a.director.memory.methods,{});
 assert.ok(isSelection(a.plan(state(98,100,5))));
});
test('a stopped route cannot be superseded while fighting or after losing health',t=>{
 const f=fixture(t),b=state();f.a.begin(planned(f.a,b),action,b,'moving');f.a.noteExecution('moving',action,b);f.advance(20_000);
 const hurt=state(100,100,2);hurt.player.hp=5;assert.equal(f.a.reconcile('moving',hurt).status,'unknown');f.advance();hurt.tick=4;assert.equal(f.a.reconcile('moving',hurt).status,'unknown');
});
test('unknown purchases never use motion timeout to become replayable',t=>{
 const f=fixture(t),b=state();b.inventory=[{id:995,name:'Coins',count:100,slot:0}];b.shop={isOpen:true,shopItems:[{id:882,count:10,slot:0,buyPrice:1}]};
 const purchase={id:'buy',type:'shopBuy',fields:{slot:0,amount:1}};
 f.a.begin(planned(f.a,b),purchase,b,'purchase');f.a.noteExecution('purchase',purchase,b);f.advance(60_000);
 const next={...b,tick:2};assert.equal(f.a.reconcile('purchase',next).status,'unknown');f.advance();next.tick=4;assert.equal(f.a.reconcile('purchase',next).status,'unknown');assert.equal(f.a.pending()?.commandId,'purchase');
});
test('unchanged make interface can verify attributable arrow production',()=>{
 const b=state();b.dialog={isOpen:true,options:[{index:3,text:'Make all arrows'}]};b.skills=[{name:'Fletching',experience:10}];b.inventory=[{id:53,count:10,slot:0},{id:39,count:10,slot:1}];
 const a=structuredClone(b);a.tick=2;a.inventory=[{id:53,count:9,slot:0},{id:39,count:9,slot:1},{id:882,count:1,slot:2}];a.skills[0].experience=11;
 const click={type:'clickDialogOption',fields:{optionIndex:3}};
 assert.equal(verifyActionOutcome(b,a,click).verified,true);
 a.skills[0].experience=10;assert.equal(verifyActionOutcome(b,a,click).verified,false);
 a.skills[0].experience=11;b.dialog.options[0].text='Accept trade';a.dialog=structuredClone(b.dialog);assert.equal(verifyActionOutcome(b,a,click).verified,false);
});
test('using an observed Fletch item option can finish by opening its recipe interface',()=>{
 const b=state();b.inventory=[{id:1511,count:1,slot:0,optionsWithIndex:[{opIndex:2,text:'Fletch'}]}];const a=structuredClone(b);a.dialog={isOpen:true,options:[{index:2,text:'Arrow shafts'}]};a.tick=2;
 assert.equal(verifyActionOutcome(b,a,{type:'useInventoryItem',fields:{slot:0,optionIndex:2}}).verified,true);
});
test('legacy synthetic movement is archived idempotently, but money/production are retained',t=>{
 const f=fixture(t),file=join(f.dir,'legacy.json');
 writeFileSync(file,JSON.stringify({pending:{commandId:'old',method:{capability:'live:walkTo'}}}));
 assert.equal(migrateLegacyPlanner(file),'archived-motion');const saved=JSON.parse(readFileSync(file,'utf8'));assert.ok(existsSync(saved.legacyMigration.backup));assert.equal(migrateLegacyPlanner(file),'resolved');
 for(const capability of ['live:shopBuy','live:bankWithdraw','live:useItemOnItem','astra:interact']){
  const raw=JSON.stringify({pending:{commandId:'unknown',method:{capability}}});writeFileSync(file,raw);assert.throws(()=>migrateLegacyPlanner(file),/RECONCILIATION_REQUIRED/);assert.equal(readFileSync(file,'utf8'),raw);
 }
});
test('packaged code can reuse an existing sibling runtime without moving config or learning',t=>{
 const f=fixture(t),code=join(f.dir,'repo/agents/advanced'),legacy=join(f.dir,'clawscape-autonomous-agent');mkdirSync(code,{recursive:true});mkdirSync(legacy);writeFileSync(join(legacy,'config.local.json'),'{}');
 assert.equal(runtimePaths(code,[],{}).home,legacy);assert.equal(runtimePaths(code,[],{}).source,'legacy');
 writeFileSync(join(code,'config.local.json'),'{}');assert.equal(runtimePaths(code,[],{}).home,code);
 assert.equal(runtimePaths(code,['--runtime-root',legacy],{}).home,legacy);
 assert.equal(runtimePaths(code,['--config',join(legacy,'config.local.json')],{}).home,legacy);
});
test('upstream resolution is explicit and never silently ignores a bad configured path',t=>{
 const f=fixture(t),repo=join(f.dir,'repo');mkdirSync(join(repo,'tmp/clawscape/upstream/sdk'),{recursive:true});writeFileSync(join(repo,'tmp/clawscape/upstream/sdk/pathfinding.ts'),'');
 assert.equal(upstreamRoot({},repo),join(repo,'tmp/clawscape/upstream'));
 assert.equal(upstreamRoot({CLAWSCAPE_UPSTREAM:join(f.dir,'explicit-missing')},repo),join(f.dir,'explicit-missing'));
});
test('doctor reports absent config and map resources without loading a game controller',t=>{
 const f=fixture(t),paths=runtimePaths(join(f.dir,'repo/agents/advanced'),[],{});
 const issues=inspectRuntime(paths);assert.ok(issues.some(i=>i.resource==='config.local.json'));assert.ok(issues.some(i=>i.code==='UPSTREAM_FILE_MISSING'));
 const issue=describeFailure(new Error('token=DO_NOT_PRINT password=secret'),'module-loading');assert.ok(!JSON.stringify(issue).includes('DO_NOT_PRINT'));assert.ok(!JSON.stringify(issue).includes('password='));
});
test('dependency failure is reported before live status instead of disappearing into backoff',async t=>{
 const f=fixture(t),old=process.exitCode,oldHome=process.env.CLAWSCAPE_ASTRA_HOME;
 try{await runAstra(['status','--runtime-root',f.dir],async()=>{throw new Error("Cannot find module 'zod'");});
  const boot=JSON.parse(readFileSync(join(f.dir,'data/astra-live/startup-status.json'),'utf8'));assert.equal(boot.status,'STARTUP_FAILED');assert.equal(boot.reason,'MISSING_DEPENDENCY');assert.equal(process.exitCode,1);
 }finally{process.exitCode=old;if(oldHome===undefined)delete process.env.CLAWSCAPE_ASTRA_HOME;else process.env.CLAWSCAPE_ASTRA_HOME=oldHome;}
});

test('an unsent receipt cannot claim credit for an unrelated arrival',t=>{
 const f=fixture(t),b=state();f.a.begin(planned(f.a,b),action,b,'not-sent');
 const proof=f.a.reconcile('not-sent',state(110,110,2));assert.equal(proof.status,'deferred');
 f.a.record('not-sent',state(110,110,2),proof);assert.equal(f.a.pending(),undefined);assert.deepEqual(f.a.director.memory.methods,{});
});
