/** Local controls and bounded report export. Never launches a model or game process. */
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ADAPTIVE_CONFIG, ADAPTIVE_AGENTS, defaultAdaptiveSettings, readAdaptiveSettings } from '../src/training/adaptive-settings.ts';
import { readAdaptiveReport } from '../src/training/adaptive-runtime.ts';
import { ADAPTIVE_VERSION } from '../src/training/adaptive-combat.ts';
const root=resolve(import.meta.dirname,'..'),[cmd='status',...args]=process.argv.slice(2);
const write=(p:string,d:any)=>{mkdirSync(dirname(p),{recursive:true});const t=p+'.'+randomUUID()+'.tmp';writeFileSync(t,JSON.stringify(d,null,2)+'\n');renameSync(t,p);};
const option=(key:string)=>{const i=args.indexOf('--'+key);return i>=0?args[i+1]:undefined;};
const num=(key:string,fallback:number,min:number,max:number)=>{const n=Number(option(key)??fallback);if(!Number.isInteger(n)||n<min||n>max)throw new Error('--'+key+' must be '+min+'..'+max);return n;};
try{
  let settings=readAdaptiveSettings(root);
  if(!existsSync(resolve(root,ADAPTIVE_CONFIG)))throw new Error('Install the adaptive patch before using this CLI.');
  if(cmd==='observe'){settings.recording=true;settings.decisions='shadow';settings.experiments='shadow';delete settings.pilot;write(resolve(root,ADAPTIVE_CONFIG),settings);
    console.log('OBSERVE: passive contextual recording on. Ranking feedback and deliberate equipment tests shadow. Intention and source controls unchanged.');}
  else if(cmd==='off'){settings={...defaultAdaptiveSettings(),recording:false};write(resolve(root,ADAPTIVE_CONFIG),settings);console.log('Adaptive recording/feedback/tests disabled; saved evidence and ordinary gameplay preserved.');}
  else if(cmd==='decisions'){
    if(args.length!==1||!['on','off'].includes(args[0]))throw new Error('Usage: decisions on|off');
    settings.decisions=args[0]==='on'?'on':'shadow';settings.recording=true;write(resolve(root,ADAPTIVE_CONFIG),settings);
    console.log('DECISIONS: '+settings.decisions+'. Uses personal comparable evidence to rank existing safe choices; experiments remain '+settings.experiments+'.');
  }else if(cmd==='pilot'){
    const agent=option('agent');if(!ADAPTIVE_AGENTS.includes(agent as any))throw new Error('Select one integrated agent with --agent NAME.');
    const minutes=num('minutes',5,1,10);settings.recording=true;settings.experiments='pilot';
    settings.pilot={id:randomUUID(),agent:agent!,expiresAt:Date.now()+minutes*60_000,maxEncounters:num('max-encounters',4,1,12),maxFood:num('max-food',2,0,10),
      maxSupplyDecrease:num('max-supplies',30,0,120),maxLevelStep:num('max-level-step',10,1,10)};
    write(resolve(root,ADAPTIVE_CONFIG),settings);console.log(JSON.stringify({settings,note:'Only carried, requirement-checked gear on an already sampled eligible benchmark. No target or item forced. Pending actions still reconcile normally.'},null,2));
  }else if(cmd==='status'||cmd==='report'){
    const paths={clawscout:'online',stinger:'stinger',coincrafter:'coincrafter',featherer:'featherer'};
    const shared=ADAPTIVE_AGENTS.map(agent=>{const p=resolve(root,'data/shared/combat-evidence',agent+'.json');try{
      if(!existsSync(p))return {agent,available:false};if(statSync(p).size>4*1024*1024)throw new Error('shared read size limit');
      const d=JSON.parse(readFileSync(p,'utf8'));if(d.agent!==agent||d.version!==1)throw new Error('shared identity mismatch');
      return {agent,available:true,profile:d.profile,at:d.at,samples:d.samples?.length??0,note:d.note};
    }catch(e){return {agent,available:false,error:String(e)};}});
    const report={version:ADAPTIVE_VERSION,capturedAt:new Date().toISOString(),settings,reports:Object.entries(paths).map(([a,p])=>readAdaptiveReport(root,a,p)),shared,
      excluded:{astra:'Separate advanced executor is not patched.'},note:'Saved-state measurements, not synchronized live status. No data is not evidence of zero damage or a completed test.'};
    if(cmd==='report'){const file=resolve(root,'share/combat-learning-report.json');write(file,report);console.log('REPORT: '+file);}else console.log(JSON.stringify(report,null,2));
  }else throw new Error('Commands: observe | off | decisions on|off | pilot --agent NAME | status | report');
}catch(error){console.error('COMBAT LEARNING: '+String(error));process.exitCode=1;}
