// Read-only collision checks; never opens or controls a game session.
import { Navigator } from '../src/navigation/controller';
import { resolve } from 'node:path';
const noActions=async()=>{throw new Error('Read-only route probe cannot act');};
const nav=new Navigator({state:noActions,act:noActions,wait:noActions},resolve(import.meta.dir,'../.tmp-build/bow-routes-readonly.json'));
try {
  await nav.prepare();
  const bank={x:3094,z:3491,level:0};
  const stops=[['shop',3080,3510],['sheep',3051,3517],['wheel-east',3082,3430],['wheel-south',3081,3429],['flax',2889,3424]] as const;
  for(const [name,x,z] of stops){const p={x,z,level:0};console.log(JSON.stringify({name,fromBank:await nav.assess(bank,p),toBank:await nav.assess(p,bank),liveVerified:false}));}
}finally{nav.close();}
