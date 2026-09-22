const path=require('node:path'),fs=require('node:fs'),cp=require('node:child_process');
let modulePath;try{modulePath=require.resolve('typescript');}catch{modulePath=require.resolve('../agents/advanced/node_modules/typescript');}
const files=fs.readdirSync('src/team').filter(f=>f.endsWith('.ts')).map(f=>'src/team/'+f);
const r=cp.spawnSync(process.execPath,[path.join(path.dirname(modulePath),'tsc.js'),'--noEmit','--strict','--skipLibCheck',
  '--target','es2022','--module','nodenext','--moduleResolution','nodenext','--allowImportingTsExtensions',
  '--typeRoots',path.resolve('agents/advanced/node_modules/@types'),'--types','node',...files,'scripts/team.ts'],{stdio:'inherit'});
if(r.error)throw r.error;process.exitCode=r.status??1;
