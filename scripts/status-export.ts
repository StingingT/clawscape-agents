#!/usr/bin/env bun
import {randomUUID} from 'node:crypto';
/** Local, read-only report. No login, gameplay, environment dump or journal edits. */
import { readFileSync,writeFileSync,renameSync,mkdirSync,lstatSync,openSync,readSync,closeSync,realpathSync,readdirSync } from 'node:fs';
import {dirname,resolve,relative,join,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inspectAgency} from './agency-status.ts';
import {progressHealth} from '../src/agency/progress.ts';
const profiles=[['clawscout','online'],['stinger','stinger'],['coincrafter','coincrafter'],['featherer','featherer'],['astra','advanced']] as const;
const sensitive=/token|password|secret|authorization|api[_-]?key|cookie|private[_-]?key|credential/i;
/** Redact before truncation; nested JSON strings are never decoded/executed. */
export function scrub(value:any,root:string,depth=0):any {
  if(depth>10)return '[depth omitted]';
  if(typeof value==='string') {
    if(sensitive.test(value)||/\b(?:sk-|ghp_|github_pat_|eyJ)[\w.-]{12,}/.test(value))return '[redacted]';
    return value.split(root).join('<repo>').replace(/https?:\/\/[^\s"<>]+/g,u=>{try{const v=new URL(u);return v.origin+v.pathname;}catch{return '[url omitted]';}}).slice(0,700);
  }
  if(Array.isArray(value))return value.slice(-30).map(v=>scrub(v,root,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,70).filter(([k])=>!sensitive.test(k)).map(([k,v])=>[k,scrub(v,root,depth+1)]));
  return value;
}
function inside(root:string,path:string):boolean {const rel=relative(root,path);return rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
function readable(root:string,path:string,maxBytes:number):number {
  if(!inside(root,resolve(path))||!inside(realpathSync(root),realpathSync(path)))throw new Error('Outside report scope');
  const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>maxBytes)throw new Error('Unsupported diagnostic file');return s.size;
}
function json(root:string,path:string,warnings:string[]):any {
  try{readable(root,path,16_000_000);return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));}
  catch{warnings.push(relative(root,path)+': missing, incomplete, oversized or unreadable');return undefined;}
}
const pick=(v:any,keys:string[])=>v&&Object.fromEntries(keys.filter(k=>v[k]!==undefined).map(k=>[k,v[k]]));
const auditSummary=(rows:any)=>Array.isArray(rows)?rows.slice(-8).map(r=>pick(r,['at','commandId','reason','evidence','lossAttribution','operation','itemId','accountedAt'])):[];
function pending(r:any){return r&&{...pick(r,['commandId','startedAt','scope','methodId','investigation']),
  historicalWindow:pick(r.historical,['loss','since','at','tick','samples']),action:pick(r.action,['id','type','itemRefs','fields']),execution:r.execution,
  referencedBeforeItems:Array.isArray(r.before?.inventory)?r.before.inventory.filter((i:any)=>[r.action?.fields?.slot,r.action?.fields?.sourceSlot,r.action?.fields?.itemSlot,r.action?.fields?.targetSlot].includes(i.slot)).map((i:any)=>pick(i,['slot','id','name','count'])):undefined};}
function logTail(root:string,file:string):any {
  // Read bounded tail bytes, never an entire log or paths supplied in its contents.
  const real=realpathSync(file);if(!inside(realpathSync(join(root,'data/supervisor')),real))throw new Error('Log outside supervisor directory');
  const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unsafe log type');
  const bytes=Math.min(stat.size,64000),fd=openSync(file,'r'),buf=Buffer.alloc(bytes);
  try{readSync(fd,buf,0,bytes,stat.size-bytes);}finally{closeSync(fd);}
  const lines=buf.toString('utf8').split(/\r?\n/);if(stat.size>bytes)lines.shift();
  let omitted=0;const records:any[]=[];
  for(const line of lines.filter(Boolean).slice(-60))try{
    const entry=JSON.parse(line),record=pick(entry,['at','time','agency','status','reason','operation','commandId','goal','startedAt','tick','actions','verified','failed']);
    if(record&&Object.keys(record).length)records.push(record);else omitted++;
  }catch{omitted++;}
  return {file:relative(root,file),modifiedAt:stat.mtime.toISOString(),truncated:stat.size>bytes,unstructuredLinesOmitted:omitted,records:records.slice(-20)};
}
export function collectReport(root:string,now=Date.now()):any {
  root=resolve(root);const warnings:string[]=[];
  const supervisor=json(root,join(root,'data/supervisor/status.json'),warnings);
  let standards:any;try{
    for(const [name,profile] of profiles)if(name!=='astra'){
      readable(root,join(root,'data',profile,'agency-v2.json'),16_000_000);
      readable(root,join(root,'data',profile,'legacy-recovery.json'),16_000_000);
    }
    standards=inspectAgency(root,now);}catch{warnings.push('Standard summary could not be read atomically; available per-agent diagnostics follow.');}
  const agents=profiles.map(([name,profile])=>{
    const dir=name==='astra'?join(root,'agents/advanced/data/astra-live'):join(root,'data',profile);
    const doc=json(root,join(dir,'agency-v2.json'),warnings);
    const latest=name==='astra'?json(root,join(dir,'status.json'),warnings):undefined;
    const navigation=name==='astra'?latest?.navigation:json(root,join(dir,'navigation.json'),warnings);
    const recovery=name==='astra'?json(root,join(dir,'startup-recovery.json'),warnings):undefined;
    const status=pick(latest,['time','status','reason','pid','startedAt','mode','live','goal','actions','verified','failed','elapsedSeconds','pending']);
    const stamp=latest?.time?Date.parse(latest.time):doc?.lastObservation?.at;
    const selected=standards?.find((v:any)=>v.agent===name);
    let logs:any[]=[];
    try{const folder=join(root,'data/supervisor');logs=['log','err'].flatMap(ext=>{
      const files=readdirSync(folder).filter(n=>new RegExp('^'+name+'-\\d+\\.'+ext+'$').test(n)).sort((a,b)=>Number(b.split('-')[1]?.split('.')[0])-Number(a.split('-')[1]?.split('.')[0]));
      return files[0]?[logTail(root,join(folder,files[0]))]:[];
    });}catch{warnings.push(name+': recent logs unavailable');}
    return {agent:name,summary:selected,supervisor:pick(supervisor?.agents?.[name],['status','pid','started','reason','exitCode','retryAt','progressHealth']),status,
      progressHealth:doc?.version===2?progressHealth(doc.memory??{},now):undefined,
      observationAgeSeconds:Number.isFinite(stamp)?Math.max(0,Math.floor((now-stamp)/1000)):null,
      latestObservation:pick(doc?.lastObservation,['at','tick','connected','position']),
      astraObservation:pick(latest?.observation,['tick','connected','position','hp','maxHp']),
      goal:pick(doc?.memory?.active,['id','target','reason','requestedSupport','blocker']),
      preparation:doc?.preparation,acquisition:doc?.acquisition,
      pending:pending(doc?.receipt),safetyPending:pending(doc?.safetyReceipt),
      transactionQuarantine:auditSummary(doc?.transactionQuarantine),historicalRetirements:auditSummary(doc?.historicalRetirements),
      discoveryRetryAt:Number.isFinite(doc?.discoveryRetryAt)?doc.discoveryRetryAt:undefined,
      routeFailures:Object.entries(doc?.knowledge?.routeFailures??{}).slice(-10).map(([id,r])=>({id,...r as any})),
      navigation:pick(navigation,['time','status','reason','destination','nextWaypoint','position','hint','endpoint','approachOnly']),
      recovery:pick(recovery,['at','ready','resolved','unresolved']),
      historicalCombatCounters:latest?.policy?.state?.counters,
      currentCombatLearning:pick(latest?.policy?.state?.learning,['active','selection']),
      lastOutcome:doc?.lastOutcome,logs};
  });
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:3000,windowsHide:true});
  return scrub({version:1,capturedAt:new Date(now).toISOString(),checkoutCommit:git.status===0?git.stdout.trim():null,
    runtime:process.versions,notes:['Saved state, not an independent live server or Windows process check.','Checkout revision does not prove which revision a running agent loaded.','Historical counters are separate from current-run actions.','Only structured recent log fields are included; credentials/configuration and full journals are never exported.'],agents,warnings},root);
}
export function exportReport(root:string,output=join(root,'data/status-report.txt')):string {
  const path=resolve(output);
  if(!path.endsWith('.txt'))throw new Error('Report output must be a .txt file');
  const report=collectReport(root);mkdirSync(dirname(path),{recursive:true});
  const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,path);return path;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    let root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),output:string|undefined;
    const args=process.argv.slice(2);
    for(let i=0;i<args.length;i+=2){if(!args[i+1]||!['--root','--output'].includes(args[i]!))throw new Error('Usage: bun run status:export [--root DIRECTORY] [--output FILE.txt]');
      if(args[i]==='--root')root=resolve(args[i+1]!);else output=resolve(args[i+1]!);}
    console.log('Report saved: '+exportReport(root,output));
  }catch{console.error('Status export failed. Check the report path and local file permissions.');process.exitCode=1;}
}
