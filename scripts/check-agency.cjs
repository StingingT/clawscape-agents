const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
let modulePath;
try{modulePath=require.resolve('typescript');}catch{modulePath=require.resolve('../agents/advanced/node_modules/typescript');}
const ts=require(modulePath);
const files=['src/agency/item-intents.ts','src/agency/acquisition.ts','src/agency/drop-leads.ts','src/combat-evidence.ts','scripts/status-export.ts','scripts/refresh-drop-leads.ts','src/agency/trip-logistics.ts','agents/advanced/src/transient-recovery.ts','src/agency/build-guides.ts','src/agency/build-rules.ts','src/training/guide-leads.ts','src/training/discovery.ts','src/training/catalog.ts','scripts/agency-status.ts','src/agency/development.ts','src/agency/step-retry.ts','src/agent.ts','src/agency/live-adapter.ts','src/agency/world-model.ts','src/agency/director.ts','src/action-outcome.ts',
  'agents/advanced/src/live-entry.ts','agents/advanced/src/startup.ts','agents/advanced/src/restart-journals.ts','src/agency/journal-recovery.ts',
  'agents/advanced/src/live-navigation.ts','agents/advanced/src/live-map-worker.ts','agents/advanced/src/collision-startup.ts',
  'agents/advanced/src/live-cli.ts','agents/advanced/src/live-policy.ts','agents/advanced/src/agency-bridge.ts','scripts/supervise.ts'];
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
  'scripts/status-export.ts','scripts/refresh-drop-leads.ts','tests/agency/adaptive-trip.test.ts','tests/agency/build-guides.test.ts','scripts/agency-status.ts','tests/agency/hierarchy.test.ts','tests/agency/development-retry.test.ts','src/agency/live-adapter.ts','src/action-outcome.ts','agents/advanced/src/agency-bridge.ts','src/agency/journal-recovery.ts','agents/advanced/src/startup.ts','agents/advanced/src/live-navigation.ts','agents/advanced/src/collision-startup.ts'],{stdio:'inherit'});
if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
console.log('Both controller entry points parse; goal-first structural checks and scoped strict TypeScript checks passed.');
