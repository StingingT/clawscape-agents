import {mkdirSync,appendFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {acquireController} from '../src/controller-lease';
import {inspectProgress} from './agency-status.ts';
const root=resolve(import.meta.dir,'..'), logs=resolve(root,'data/supervisor');
mkdirSync(logs,{recursive:true});
const release=acquireController(resolve(logs,'supervisor.lock'));
const jobs=[
 {name:'clawscout',cwd:root,args:['run','src/agent.ts','--character','clawscout','--profile','online','--role','brawler','--build','broad','--forever']},
 {name:'stinger',cwd:root,args:['run','src/agent.ts','--character','stinger','--profile','stinger','--role','brawler','--build','ranged-magic','--forever']},
 {name:'coincrafter',cwd:root,args:['run','src/agent.ts','--character','coincrafter','--profile','coincrafter','--role','economy','--build','broad','--forever']},
 {name:'featherer',cwd:root,args:['run','src/agent.ts','--character','featherer','--profile','featherer','--role','resource','--build','broad','--forever']},
 {name:'astra',cwd:resolve(root,'agents/advanced'),args:['src/live-entry.ts','run','--seconds','900']},
];
let stopping=false;
const children=new Map<string,ReturnType<typeof Bun.spawn>>();
const states:Record<string,any>={};
function publish(event:string,name?:string,detail?:any){
 // Read-only health: a live process and verified clicks are not productive
 // progress. Never kill/restart an uncertain transaction to escape a stall.
 for(const job of jobs)if(states[job.name])try {
   const i=job.args.indexOf('--profile');
   const file=i>=0?resolve(job.cwd,'data',job.args[i+1]!,'agency-v2.json'):resolve(job.cwd,'data/astra-live/agency-v2.json');
   states[job.name].progressHealth=inspectProgress(file);
 }catch{states[job.name].progressHealth={status:'unavailable'};}
 appendFileSync(resolve(logs,'events.jsonl'),JSON.stringify({time:new Date().toISOString(),event,name,detail})+'\n');
 writeFileSync(resolve(logs,'status.json'),JSON.stringify({time:new Date().toISOString(),pid:process.pid,agents:states},null,2));
}
const timer=setInterval(()=>publish('productive-health-check'),30_000);
async function run(job:typeof jobs[number]){
 let failures=0;
 while(!stopping){
  // A deliberate pause is respected without erasing the goal or journal.
  if(existsSync(resolve(logs,job.name+'.paused'))){states[job.name]={status:'paused'};publish('paused',job.name);await Bun.sleep(60000);continue;}
  const started=Date.now(), prefix=resolve(logs,job.name+'-'+started);
  try{
   const child=Bun.spawn([process.execPath,...job.args],{cwd:job.cwd,stdin:'ignore',stdout:Bun.file(prefix+'.log'),stderr:Bun.file(prefix+'.err'),windowsHide:true});
   children.set(job.name,child);states[job.name]={status:'running',pid:child.pid,started:new Date(started).toISOString(),log:prefix+'.log',errorLog:prefix+'.err'};publish('started',job.name);
   const code=await child.exited;children.delete(job.name);
   if(stopping)break;
   let reason='process-exit';let needsAttention=false;
   if(job.name==='astra')try{
     const result=JSON.parse(readFileSync(resolve(job.cwd,'data/astra-launcher-status.json'),'utf8'));
     if(result.pid===child.pid && result.startedAt>=started){reason=result.reason??reason;needsAttention=result.retryable===false;}
   }catch{}
   // CONTROL_REVOKED also occurs when the supervisor itself restarts or the
   // machine interrupts Astra. Treat only explicit manual takeover/disable
   // reasons as a durable pause; ordinary revocation must retry.
   const manual=/MANUAL|HARD_DISABLED/.test(reason);
   if(manual){writeFileSync(resolve(logs,job.name+'.paused'),reason);states[job.name]={status:'paused',reason};publish('manual-stop',job.name);continue;}
   failures=Date.now()-started>300000?0:Math.min(failures+1,4);
   const retryMs=Math.min(900000,60000*2**failures);
   states[job.name]={status:needsAttention?'needs-attention':'retry-backoff',exitCode:code,reason,retryAt:new Date(Date.now()+retryMs).toISOString(),log:prefix+'.log',errorLog:prefix+'.err'};
   publish('exited',job.name,{code,reason,retryMs});await Bun.sleep(retryMs);
  }catch(error){states[job.name]={status:'launch-failed',reason:String(error)};publish('launch-failed',job.name);await Bun.sleep(60000);}
 }
}
function stop(){if(stopping)return;stopping=true;clearInterval(timer);for(const child of children.values())child.kill();publish('supervisor-stopping');release();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
publish('supervisor-started');
await Promise.all(jobs.map(async(job,index)=>{await Bun.sleep(index*5000);await run(job);}));
clearInterval(timer);release();
