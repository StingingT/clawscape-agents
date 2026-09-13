import { writeFileSync, renameSync } from 'node:fs';

// Windows scanners/readers can briefly hold the destination without delete
// sharing. Retry replacement, preserving the previous complete checkpoint.
export function saveGoalJson(file:string,value:unknown,replace=renameSync) {
  const tmp=file+'.'+process.pid+'.tmp';
  writeFileSync(tmp,JSON.stringify(value,null,2));
  const delay=new Int32Array(new SharedArrayBuffer(4));
  for(let attempt=0;;attempt++) {
    try {replace(tmp,file);return;}
    catch(error:any) {
      if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=8)throw error;
      Atomics.wait(delay,0,0,10*(attempt+1));
    }
  }
}
