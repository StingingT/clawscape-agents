#!/usr/bin/env bun
/** Operator controls only. No network, game mutation, model call, or changes to saved learning. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSourceCatalogue, SOURCE_ADAPTER_VERSION } from '../src/catalog/source-catalogue.ts';
import { readSourceSettings, MAIN_SOURCE_AGENTS, SOURCE_CONFIG } from '../src/agency/source-resources.ts';
const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),command=args.shift()??'status';
const option=(name:string,fallback?:string)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
const number=(name:string,fallback:number,min:number,max:number)=>{const n=Number(option(name,String(fallback)));if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`--${name} must be an integer in ${min}..${max}`);return n;};
const write=(file:string,data:unknown)=>{mkdirSync(dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(data,null,2)+'\n');renameSync(tmp,file);};
try {
  const cfg=readSourceSettings(root);if(!cfg)throw new Error('Run the integration installer first: source-integration.json is absent.');
  const data=loadSourceCatalogue(resolve(root,cfg.directory));
  if(command==='inspect') {
    const key=args[0];if(!key)throw new Error('Usage: bun scripts/source-catalogue.ts inspect steel_arrow');
    const item=data.item(/^\d+$/.test(key)?Number(key):key);if(!item)throw new Error('Unknown or ambiguous item: '+key);
    const routes=data.sourcesFor(item.id);
    console.log(JSON.stringify({profile:data.data.profile.id,item:{id:item.id,name:item.name,symbol:item.symbol},
      sourceCounts:routes.reduce((a,r)=>(a[r.method]=(a[r.method]??0)+1,a),{} as Record<string,number>),
      recipes:data.recipesFor(item.id),runecrafting:data.runes.get(item.id),
      note:'This is factual catalogue data, not a claim of a currently executable route.'},null,2));
  } else if(command==='shadow') {
    cfg.mode='shadow';cfg.pilotAgents=[];delete cfg.pilotId;delete cfg.expiresAt;
    write(resolve(root,SOURCE_CONFIG),cfg);console.log('SHADOW: new source actions disabled. Existing pending actions still require reconciliation; ordinary agents keep their previous behavior.');
  } else if(command==='pilot') {
    if(!args.includes('--confirm-uploaded-server'))throw new Error('Include --confirm-uploaded-server only after confirming the uploaded Clawscape source matches your running server.');
    const agent=option('agent');if(!agent||!MAIN_SOURCE_AGENTS.includes(agent))throw new Error('Choose one main-runner agent: '+MAIN_SOURCE_AGENTS.join(', ')+'. Astra uses a separate, unavailable executor.');
    const world=option('world');if(!world)throw new Error('--world must match the agent world identity (normally clawscape).');
    const members=option('members');if(!['true','false'].includes(members??''))throw new Error('--members true or --members false is required; no membership inference.');
    const minutes=number('minutes',10,1,15),maxActions=number('max-actions',40,1,120),maxGp=number('max-gp',100,0,10000);
    cfg.mode='pilot';cfg.pilotAgents=[agent];cfg.confirmedWorld=world;cfg.confirmedProfileId=data.data.profile.id;cfg.members=members==='true';
    cfg.pilotId=randomUUID();cfg.expiresAt=Date.now()+minutes*60000;cfg.maxActions=maxActions;cfg.maxSpendGp=maxGp;
    const wanted=option('item');cfg.requests={};
    if(wanted){const item=data.item(/^\d+$/.test(wanted)?Number(wanted):wanted);if(!item)throw new Error('Unknown or ambiguous item: '+wanted);
      cfg.requests={[agent]:[{item:item.id,quantity:number('quantity',15,1,1000)}]};}
    write(resolve(root,SOURCE_CONFIG),cfg);
    console.log(JSON.stringify({mode:cfg.mode,agent,profile:cfg.confirmedProfileId,world,expiresAt:new Date(cfg.expiresAt).toISOString(),
      maxNewActionAttempts:maxActions,maxNewPurchaseGp:maxGp,requests:cfg.requests,
      note:'Only the new local source executor is budgeted here; existing gameplay continues. This does not start or stop a worker.'},null,2));
  } else if(command==='status'||command==='report') {
    const profiles:Record<string,string>={clawscout:'online',stinger:'stinger',coincrafter:'coincrafter',featherer:'featherer'};
    const reports=Object.entries(profiles).map(([agent,profile])=>{
      const file=resolve(root,'data',profile,'source-catalogue-report.json');
      if(!existsSync(file))return {agent,reportAvailable:false,path:file};
      const report=JSON.parse(readFileSync(file,'utf8'));return {...report,reportAvailable:true,path:file,ageSeconds:Math.round((Date.now()-report.at)/1000)};
    });
    const output={version:SOURCE_ADAPTER_VERSION,capturedAt:new Date().toISOString(),mode:cfg.mode,pilotAgents:cfg.pilotAgents,
      profile:data.data.profile.id,expiresAt:cfg.expiresAt?new Date(cfg.expiresAt).toISOString():null,
      counts:{items:data.items.size,recipes:data.recipes.size,routes:data.routes.size},reports,
      excluded:{astra:'Separate advanced executor was absent from the supplied ZIP; not integrated.'},
      note:'Worker reports have individual observation timestamps, not a synchronized live snapshot.'};
    if(command==='report'){const file=resolve(root,'share/source-catalogue-report.json');write(file,output);console.log('REPORT: '+file);}
    else console.log(JSON.stringify({...output,reports:reports.map(r=>({agent:r.agent,available:r.reportAvailable,ageSeconds:r.ageSeconds,mode:r.mode,
      enabled:r.enabled,reason:r.gateReason,registeredMethods:r.registeredMethods,needs:r.needs,plans:r.plans,report:r.path}))},null,2));
  } else throw new Error('Commands: status | report | inspect ITEM | shadow | pilot --agent NAME --confirm-uploaded-server --world WORLD --members true|false');
} catch(error){console.error('SOURCE CATALOGUE: '+String(error));process.exitCode=1;}
