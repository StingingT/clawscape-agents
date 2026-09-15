#!/usr/bin/env bun
/** Explicit, bounded public-source refresh. No login, game command or paid API. */
import {writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DROP_WEBSITE,DROP_BASE,listedDropFiles,parseDropScript,type DropIndex} from '../src/agency/drop-leads.ts';
async function text(url:string):Promise<string> {
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok||Number(response.headers.get('content-length')??0)>256000)throw new Error('SOURCE_HTTP_OR_SIZE');
  const reader=response.body?.getReader();if(!reader)throw new Error('EMPTY_SOURCE');
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const value=await reader.read();if(value.done)break;size+=value.value.length;if(size>256000)throw new Error('SOURCE_SIZE');chunks.push(value.value);}}
  finally {await reader.cancel();}
  return Buffer.concat(chunks).toString('utf8');
}
export async function refreshDrops(out:string):Promise<DropIndex> {
  const files=listedDropFiles(await text(DROP_WEBSITE));
  const ref=JSON.parse(await text('https://api.github.com/repos/2004Scape/Server/git/ref/heads/main')).object?.sha;
  if(!/^[a-f0-9]{40}$/.test(ref))throw new Error('SOURCE_REVISION_UNAVAILABLE');
  const at=new Date().toISOString();const doc:DropIndex={version:1,website:DROP_WEBSITE,retrievedAt:at,sourceRevision:ref,coverage:'direct-literal-drops-only',leads:[],skipped:[]};
  // Sequential requests keep the source load and total request count bounded.
  for(const file of files) {
    try {doc.leads.push(...parseDropScript(await text(DROP_BASE+ref+'/data/src/scripts/drop%20tables/scripts/'+file),file,ref,at));}
    catch {doc.skipped.push(file);}
  }
  if(!doc.leads.length)throw new Error('NO_DROP_LEADS_LOADED');
  mkdirSync(dirname(out),{recursive:true});const tmp=out+'.tmp';writeFileSync(tmp,JSON.stringify(doc,null,2)+'\n',{mode:0o600});renameSync(tmp,out);return doc;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  if(args.length && (args.length!==2||args[0]!=='--output'))throw new Error('Usage: bun run knowledge:refresh-drops [--output FILE]');
  const out=args.length?resolve(args[1]!):resolve(root,'data/shared/drop-leads.json');
  refreshDrops(out).then(d=>console.log(JSON.stringify({saved:out,leads:d.leads.length,skipped:d.skipped,coverage:d.coverage,status:'unverified; not server facts'})))
    .catch(e=>{console.error(String(e));process.exitCode=1;});
}
