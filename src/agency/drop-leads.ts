import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { itemName } from './item-intents.ts';
export const DROP_WEBSITE='https://thesneilert.github.io/2004scape/';
export const DROP_BASE='https://raw.githubusercontent.com/2004Scape/Server/';
export type DropLead={item:string;symbol:string;monster:string;file:string;sourceUrl:string;website:string;
  retrievedAt:string;sourceHash:string;status:'unverified';quantity:number|null;rate:null};
export type DropIndex={version:1;website:string;retrievedAt:string;sourceRevision:string;coverage:'direct-literal-drops-only';
  leads:DropLead[];skipped:string[]};
/** Parse the site's explicit file lists as data; never execute HTML or JavaScript. */
export function listedDropFiles(html:string):string[] {
  if(html.length>256_000)throw new Error('DROP_INDEX_TOO_LARGE');
  const names:string[]=[];
  for(const name of ['f2pDropFiles','p2pDropFiles']) {
    const block=new RegExp('const\\s+'+name+'\\s*=\\s*\\[([^\\]]+)\\]').exec(html)?.[1];
    if(!block)throw new Error('DROP_SITE_FORMAT_CHANGED');
    names.push(...[...block.matchAll(/"([a-z_]+\.rs2)"/g)].map(m=>m[1]!));
  }
  if(names.length<1||names.length>96)throw new Error('DROP_FILE_LIMIT');
  return [...new Set(names)];
}
/** Conditional quantities/rates and nested rare tables are deliberately not inferred. */
export function parseDropScript(text:string,file:string,revision:string,at:string):DropLead[] {
  if(!/^[a-z_]+\.rs2$/.test(file)||!/^([a-f0-9]{40}|main)$/.test(revision)||text.length>256_000)throw new Error('INVALID_DROP_SOURCE');
  const sourceUrl=DROP_BASE+revision+'/data/src/scripts/drop%20tables/scripts/'+file;
  const clean=text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
  const sourceHash=createHash('sha256').update(text).digest('hex');
  const leads=[...clean.matchAll(/\bobj_add\(\s*npc_coord\s*,\s*([a-z][a-z0-9_]*)\s*,\s*(\d+|[^,\n]+)\s*,/g)]
    .map(m=>({item:itemName(m[1]),symbol:m[1]!,monster:file.slice(0,-4).replace(/_/g,' '),file,sourceUrl,website:DROP_WEBSITE,
      retrievedAt:at,sourceHash,status:'unverified' as const,quantity:/^\d+$/.test(m[2]!.trim())?Number(m[2]):null,rate:null}));
  const unique=new Map<string,DropLead>();
  for(const lead of leads){const old=unique.get(lead.symbol);unique.set(lead.symbol,old?{...old,quantity:old.quantity===lead.quantity?old.quantity:null}:lead);}
  return [...unique.values()];
}
export function loadDropIndex(file:string):DropLead[] {
  try {
    const raw=readFileSync(file,'utf8');if(raw.length>4_000_000)return [];
    const doc=JSON.parse(raw);if(doc.version!==1||doc.website!==DROP_WEBSITE||!Array.isArray(doc.leads)||doc.leads.length>10000)return [];
    return doc.leads.filter((l:any)=>l.status==='unverified'&&typeof l.item==='string'&&l.item.length<120&&typeof l.monster==='string'&&l.monster.length<120
      && typeof l.sourceUrl==='string'&&/^https:\/\/raw\.githubusercontent\.com\/2004Scape\/Server\/[a-f0-9]{40}\/data\/src\/scripts\/drop%20tables\/scripts\/[a-z_]+\.rs2$/.test(l.sourceUrl)&&/^[a-f0-9]{64}$/.test(l.sourceHash))
      .map((l:any)=>({...l,status:'unverified',rate:null}));
  }catch{return [];}
}
