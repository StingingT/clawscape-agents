import { readAdaptiveReport } from '../src/training/adaptive-runtime.ts';
import { readAdaptiveSettings } from '../src/training/adaptive-settings.ts';
/** Local configuration/report CLI. Never starts workers, models, or a game action. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GOAL_SETTINGS_PATH, readGoalSettings, type GoalPlanningSettings } from '../src/agency/goal-readiness.ts';
import { SOURCE_CONFIG, MAIN_SOURCE_AGENTS, readSourceSettings } from '../src/agency/source-resources.ts';
import { loadSourceCatalogue } from '../src/catalog/source-catalogue.ts';
import { GOAL_PLANNING_VERSION } from '../src/agency/goal-planner.ts';
import { readGoalRuntime } from '../src/agency/goal-status.ts';
import { SOURCE_XP_DATA } from '../src/agency/goal-xp-data.ts';
const root=resolve(import.meta.dirname,'..'),[command='status',...args]=process.argv.slice(2);
const option=(name:string)=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
const numeric=(name:string,fallback:number,min:number,max:number)=>{const value=Number(option(name)??fallback);if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`--${name} must be an integer in ${min}..${max}`);return value;};
const write=(file:string,data:unknown)=>{mkdirSync(dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(data,null,2)+'\n');renameSync(temp,file);};
try {
  const sourceSettings=readSourceSettings(root);if(!sourceSettings)throw new Error('The source-catalogue integration must be installed first.');
  const source=loadSourceCatalogue(resolve(root,sourceSettings.directory));
  let settings=readGoalSettings(root);if(!settings)throw new Error('Install the goal-prerequisite patch first.');
  if(command==='shadow'){
    settings.mode='shadow';settings.intentMode='shadow';write(resolve(root,GOAL_SETTINGS_PATH),settings);
    // Explicit stop affects new source actions too; ordinary gameplay and pending receipts remain.
    sourceSettings.mode='shadow';sourceSettings.pilotAgents=[];delete sourceSettings.pilotId;delete sourceSettings.expiresAt;
    write(resolve(root,SOURCE_CONFIG),sourceSettings);
    console.log('SHADOW: new source actions and intention changes disabled. Pending commands still require reconciliation. Saved goals and learning preserved.');
  } else if(command==='intents'){
    if(args.length!==1||!['on','off'].includes(args[0]!))throw new Error('Usage: intents on|off');
    settings.intentMode=args[0]==='on'?'enforce':'shadow';write(resolve(root,GOAL_SETTINGS_PATH),settings);
    console.log('INTENTIONS: '+settings.intentMode.toUpperCase()+'. Source actions remain '+sourceSettings.mode+'; training/planning remains '+settings.mode+'. No worker, model or game action was started.');
  } else if(command==='confirm-xp'){
    if(!args.includes('--confirm-uploaded-server'))throw new Error('Confirm that the uploaded server profile matches the running world.');
    if(option('xp-rate')===undefined)throw new Error('--xp-rate is required. The source default is not proof of your running configuration.');
    settings={...settings,xpRate:numeric('xp-rate',0,1,1000),confirmedProfileId:source.data.profile.id};
    write(resolve(root,GOAL_SETTINGS_PATH),settings);
    console.log('XP model recorded for '+settings.confirmedProfileId+'. Mode remains '+settings.mode+'. This does not enable a pilot.');
  } else if(command==='pilot'){
    if(!args.includes('--confirm-uploaded-server'))throw new Error('--confirm-uploaded-server is required.');
    const agent=option('agent'),world=option('world'),members=option('members');
    if(!agent||!MAIN_SOURCE_AGENTS.includes(agent)||!world||!['true','false'].includes(members??''))
      throw new Error('Specify --agent NAME --world WORLD --members true|false. Astra has a separate executor.');
    if(option('xp-rate')===undefined)throw new Error('--xp-rate must match your running server (the uploaded source default is '+SOURCE_XP_DATA.sourceDefaultXpRate+').');
    const rate=numeric('xp-rate',0,1,1000),minutes=numeric('minutes',5,1,15);
    settings={...settings,version:1,mode:'pilot',xpRate:rate,confirmedProfileId:source.data.profile.id};
    Object.assign(sourceSettings,{mode:'pilot',pilotAgents:[agent],confirmedWorld:world,confirmedProfileId:source.data.profile.id,members:members==='true',
      pilotId:randomUUID(),expiresAt:Date.now()+minutes*60_000,maxActions:numeric('max-actions',20,1,120),maxSpendGp:numeric('max-gp',50,0,10000)});
    // Do not inject an item/destination objective: existing personal needs choose their own methods.
    write(resolve(root,SOURCE_CONFIG),sourceSettings);write(resolve(root,GOAL_SETTINGS_PATH),settings);
    console.log(JSON.stringify({mode:'pilot',agent,profile:source.data.profile.id,xpRate:rate,expiresAt:new Date(sourceSettings.expiresAt!).toISOString(),
      maxNewActions:sourceSettings.maxActions,maxNewSpendGp:sourceSettings.maxSpendGp,existingResourceRequests:sourceSettings.requests??{},
      note:'No new goal was prescribed. Existing requests, role preferences, build constraints and original executor checks remain.'},null,2));
  } else if(command==='status'||command==='report'){
    const paths:Record<string,string>={clawscout:'online',stinger:'stinger',coincrafter:'coincrafter',featherer:'featherer'};
    const reports=Object.entries(paths).map(([agent,profile])=>{
      const file=resolve(root,'data',profile,'goal-planning-report.json');
      const combatLearning=readAdaptiveReport(root,agent,profile);
      const runtime=readGoalRuntime(resolve(root,'data',profile,'agency-v2.json'),agent,Date.now());
      if(!existsSync(file))return {agent,reportAvailable:false,path:file,runtime,combatLearning};
      try {const data=JSON.parse(readFileSync(file,'utf8'));return {...data,reportAvailable:true,path:file,runtime,combatLearning,ageSeconds:Math.round((Date.now()-data.at)/1000),reportVersionMatches:data.version===GOAL_PLANNING_VERSION};}
      catch(error){return {agent,reportAvailable:false,path:file,runtime,combatLearning,error:String(error)};}
    });
    const output={version:GOAL_PLANNING_VERSION,capturedAt:new Date().toISOString(),settings,sourceMode:sourceSettings.mode,
      sourcePilotAgents:sourceSettings.pilotAgents,sourceProfile:source.data.profile.id,reports,adaptiveSettings:readAdaptiveSettings(root),
      excluded:{astra:'Separate executor absent from the uploaded source snapshot.'},
      note:'Per-worker forecast and saved runtime timestamps differ. Runtime summaries are not live process checks; ready forecasts are not evidence of dispatch or progress.'};
    if(command==='report'){
      const file=resolve(root,'share/goal-planning-report.json');write(file,output);console.log('REPORT: '+file);
    }else console.log(JSON.stringify({...output,reports:reports.map(r=>({agent:r.agent,reportAvailable:r.reportAvailable,ageSeconds:r.ageSeconds,
      enabled:r.enabled,reportVersionMatches:r.reportVersionMatches,intentionPolicy:r.intentionPolicy,methodCounts:r.methodCounts,runtime:r.runtime,error:r.error,trainingMethods:r.trainingMethods,rate:r.xp?.confirmedRate,retiredIntentCandidates:r.retiredIntentCandidates,
      forecasts:r.forecasts?.map((f:any)=>({goal:f.goalId,status:f.status,next:f.next?.methodId,truncated:f.truncated})),path:r.path}))},null,2));
  }else throw new Error('Commands: status | report | shadow | intents on|off | confirm-xp --xp-rate N --confirm-uploaded-server | pilot --agent NAME --world WORLD --members true|false --xp-rate N --confirm-uploaded-server');
} catch(error){console.error('GOAL PLANNING: '+String(error));process.exitCode=1;}
