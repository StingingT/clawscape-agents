// Supervised CoinCrafter check. His normal controller MUST be stopped first.
import {resolve} from 'node:path';
import {productionDialog} from '../src/progression-policy';
const root=resolve(import.meta.dir,'..');
async function cli(args:string[]) {
 const p=Bun.spawn([process.execPath,resolve(root,'../tmp/clawscape/src/cli.ts'),'--character','coincrafter',...args],{cwd:root,stdout:'pipe',stderr:'pipe',env:{...process.env,CLAWSCAPE_HOME:resolve(root,'data/online-home')}});
 const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code)throw new Error(err||'CLI failed');const v=JSON.parse(out);if(v.success===false)throw new Error(v.message);return v;
}
let s=(await cli(['state'])).state;
if(!s.dialog?.isOpen)throw new Error('Expected the already-observed Fletching chooser');
const option=productionDialog(s.dialog.options,'Arrow Shafts');
if(!option)throw new Error('No observed shaft button');
await cli(['act','clickDialogOption','--json',JSON.stringify({optionIndex:option.index,reason:'verify completed batch, not dispatch alone'})]);
for(let i=0;i<8;i++) {s=(await cli(['wait','2'])).state;console.log(JSON.stringify({tick:s.tick,anim:s.player.animId,fletching:s.skills.find((x:any)=>x.name==='Fletching'),items:s.inventory.filter((x:any)=>!/^Logs$/i.test(x.name)).map((x:any)=>({name:x.name,count:x.count})),dialog:s.dialog.options,messages:s.gameMessages.slice(-2)}));}
