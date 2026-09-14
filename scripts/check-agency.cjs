const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
let modulePath;
try{modulePath=require.resolve('typescript');}catch{modulePath=require.resolve('../agents/advanced/node_modules/typescript');}
const ts=require(modulePath);
const files=['src/agent.ts','src/agency/live-adapter.ts','src/agency/world-model.ts','src/agency/director.ts','src/action-outcome.ts',
  'agents/advanced/src/live-cli.ts','agents/advanced/src/live-policy.ts','agents/advanced/src/agency-bridge.ts','scripts/supervise.ts','scripts/astra.ts','src/runtime-paths.ts','src/agency/legacy.ts',
  'agents/advanced/src/startup.ts','agents/advanced/src/arbiter.ts','agents/advanced/src/store.ts','src/navigation/controller.ts'];
for(const file of files){
  const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  if(source.parseDiagnostics.length)throw new Error(file+': '+source.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')).join('\n'));
}
const shared=fs.readFileSync('src/agent.ts','utf8'),episode=shared.slice(shared.indexOf('async function runEpisode()'));
if(episode.indexOf('const planned=agency.plan(state)')<0||episode.indexOf('agency.plan(state)')>episode.indexOf('actionsForTask(state,planned.task)'))throw new Error('GOAL_MUST_PRECEDE_EXECUTOR');
if(episode.includes('agency.choose(')||episode.includes('agencyFacts('))throw new Error('LEGACY_ACTION_FIRST_ADAPTER_REINTRODUCED');
const advanced=fs.readFileSync('agents/advanced/src/live-cli.ts','utf8');
if(!advanced.includes('decision=policy.next(latest,planned.task)')||advanced.includes('agencyMethod(decision)')||advanced.includes('goal:${decision.goal}'))throw new Error('ASTRA_NOT_GOAL_FIRST');
const compiler=path.join(path.dirname(modulePath),'tsc.js');
const roots=path.resolve('agents/advanced/node_modules/@types');
const result=cp.spawnSync(process.execPath,[compiler,'--noEmit','--strict','--skipLibCheck','--target','es2022','--module','nodenext',
  '--moduleResolution','nodenext','--allowImportingTsExtensions','--typeRoots',roots,'--types','node',
  'src/agency/live-adapter.ts','src/action-outcome.ts','agents/advanced/src/agency-bridge.ts','src/runtime-paths.ts','src/agency/legacy.ts','agents/advanced/src/startup.ts'],{stdio:'inherit'});
if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
console.log('Both controller entry points parse; goal-first structural checks and scoped strict TypeScript checks passed.');
