import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTeamManager} from '../../src/team/manager.ts';

function fixture(){
  const r=mkdtempSync(join(tmpdir(),'team-lifecycle-'));
  mkdirSync(join(r,'data','supervisor'),{recursive:true});
  return r;
}

test('closed manager stays closed while a new Overseer process gets a fresh lifecycle', async()=>{
  const r=fixture();
  try{
    const oldManager=createTeamManager(r);
    await oldManager.close();
    expect(()=>oldManager.start('clawscout')).toThrow('TEAM_STOPPING');

    const newManager=createTeamManager(r);
    let message='';
    try{newManager.start('clawscout');}catch(e){message=(e as Error).message;}
    expect(message).not.toBe('TEAM_STOPPING');
    await newManager.close();
  }finally{
    rmSync(r,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});