import { Navigator } from '../src/navigation/controller';
import { resolve } from 'node:path';
const noActions=async()=>{throw new Error('Read-only probe cannot act');};
const nav=new Navigator({state:noActions,act:noActions,wait:noActions},resolve(import.meta.dir,'../.tmp-build/metal-route-readonly.json'));
try {
  await nav.prepare();
  const stops=[{name:'bank',x:3185,z:3436,level:0},{name:'mine',x:3285,z:3365,level:0},{name:'furnace',x:3229,z:3255,level:0},{name:'anvil',x:3187,z:3425,level:0},{name:'bank',x:3185,z:3436,level:0}];
  for(let i=1;i<stops.length;i++){const result=await nav.assess(stops[i-1]!,stops[i]!);console.log(JSON.stringify({from:stops[i-1]!.name,to:stops[i]!.name,...result,liveVerified:false}));if(result.status!=='ready')process.exitCode=1;}
}finally{nav.close();}
