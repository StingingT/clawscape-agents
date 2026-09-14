import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverLegacyJournals } from '../../src/agency/journal-recovery.ts';

const identity={agent:'clawscout',world:'clawscape'};
const state=(tick=100)=>({character:'clawscout',world:'clawscape',sessionId:'new-local-session',worldEpoch:'world-1',inGame:true,tick,
  player:{lifeId:1,respawnCount:0,hp:30,maxHp:30,worldX:10,worldZ:10,level:0,animId:-1,combat:{inCombat:false,targetType:'none'}},
  inventory:[],equipment:[],skills:[],bank:{isOpen:false},dialog:{isOpen:false}});
const action=(patch:any={})=>({commandId:'clawscout-123-bank-for-fishing-tool-funds',actionId:'bank-for-fishing-tool-funds',
  type:'walkTo',fields:{x:100,z:100,level:0},status:'outcome-unknown',startedAt:'1970-01-01T00:00:00.001Z',
  beforeState:{...state(1),sessionId:'old-local-session'},...patch});
const write=(dir:string,value:any)=>writeFileSync(join(dir,'action-intent.json'),JSON.stringify(value));
function fixture(run:(dir:string)=>void){const dir=mkdtempSync(join(tmpdir(),'navigation-legacy-'));try{write(dir,action());run(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function recover(dir:string,now:number,tick:number,patch:any={}){
  return recoverLegacyJournals(dir,identity,{apply:true,now,state:{...state(tick),...patch},stable:{...state(tick+1),...patch}});
}

test('legacy bank-navigation retires as interrupted only after a measured quiet window, never success',()=>fixture(dir=>{
  const original=readFileSync(join(dir,'action-intent.json'),'utf8');
  assert.equal(recover(dir,1_000,100).ready,false);
  assert.equal(recover(dir,16_000,130).ready,false);
  const result=recover(dir,31_000,160);
  assert.equal(result.ready,true);assert.equal(result.entries[0]?.outcome,'interrupted');
  assert.match(result.entries[0]!.reason,/no arrival, failure, or success inferred/);
  assert.equal(readFileSync(join(dir,'action-intent.json'),'utf8'),original);
  const entry=result.entries[0]!;
  assert.equal(readFileSync(join(dir,'journal-backups',`action-intent.json.${entry.sha256}.json`),'utf8'),original);
  assert.equal(recoverLegacyJournals(dir,identity,{apply:true}).ready,true);
}));

test('all four role labels use exact navigation type rather than a name-based exception',()=>{
  for(const agent of ['clawscout','stinger','coincrafter','featherer'])fixture(dir=>{
    const s=state();s.character=agent;
    write(dir,action({commandId:`${agent}-123-resource-route-chickens`,beforeState:{...s,tick:1}}));
    for(const [now,tick] of [[1_000,100],[31_000,160]]){
      const result=recoverLegacyJournals(dir,{agent,world:'clawscape'},{apply:true,now,state:{...s,tick},stable:{...s,tick:tick+1}});
      assert.equal(result.ready,now===31_000);
    }
  });
});

test('names resembling routes cannot clear a withdrawal, purchase, production, pickup, or dialogue',()=>{
  for(const type of ['bankWithdraw','bankDeposit','shopBuy','shopSell','useItemOnItem','clickDialogOption','pickupItem','interactNpc'])fixture(dir=>{
    write(dir,action({type,fields:{slot:1,amount:1}}));
    recover(dir,1_000,100);const result=recover(dir,1_000_000,200);
    assert.equal(result.ready,false);assert.equal(result.entries[0]?.outcome,undefined);
    assert.equal(existsSync(join(dir,'journal-backups')),false);
  });
});

test('old failed/quarantined navigation is interrupted without converting transactions to rejection',()=>fixture(dir=>{
  write(dir,action({status:'failed',failure:'stale non-mutating intent quarantined after restart'}));
  recover(dir,1_000,100);assert.equal(recover(dir,31_000,160).entries[0]?.outcome,'interrupted');
}));

test('movement or activity during settling resets the window',()=>fixture(dir=>{
  recover(dir,1_000,100);
  const moving={player:{...state().player,worldX:11}};
  assert.equal(recover(dir,31_000,160,moving).ready,false);
  assert.equal(recover(dir,46_000,190,moving).ready,false);
  assert.equal(recover(dir,61_000,220,moving).ready,true);
}));

test('missing idle evidence, combat and disconnected observations never retire navigation',()=>{
  for(const patch of [{inGame:false},{player:{...state().player,animId:undefined}},
    {player:{...state().player,combat:{inCombat:true}}},{player:{...state().player,combat:{}}},
    {player:{...state().player,lifeId:undefined}},{player:{...state().player,hp:0}}])fixture(dir=>{
    recover(dir,1_000,100);assert.equal(recover(dir,31_000,160,patch).ready,false);
    assert.equal(recover(dir,32_000,180).ready,false,'invalid observation must discard the accumulated idle window');
  });
});

test('changed actor, world, epoch, life or plane does not establish safe retirement',()=>{
  for(const patch of [{character:'stinger'},{world:'other'},{worldEpoch:'world-2'},
    {player:{...state().player,lifeId:2}},{player:{...state().player,level:1}},
    {player:{...state().player,respawnCount:1}}])fixture(dir=>{
    recover(dir,1_000,100);assert.equal(recover(dir,31_000,160,patch).ready,false);
  });
});

test('a local-session change starts a fresh window but does not permanently block pure navigation',()=>fixture(dir=>{
  recover(dir,1_000,100);
  assert.equal(recover(dir,31_000,160,{sessionId:'third-local-session'}).ready,false);
  assert.equal(recover(dir,61_000,220,{sessionId:'third-local-session'}).ready,true);
}));

test('clock rollback, long observation gaps and replayed ticks cannot complete the window',()=>{
  for(const [now,tick] of [[0,160],[90_000,160],[31_000,100]])fixture(dir=>{
    recover(dir,1_000,100);assert.equal(recover(dir,now,tick).ready,false);
  });
});

test('settlement does not carry between controller instances or changed journal contents',()=>fixture(dir=>{
  recover(dir,1_000,100);
  const reportFile=join(dir,'legacy-recovery.json'),report=JSON.parse(readFileSync(reportFile,'utf8'));
  report.entries[0].navigation.observer='previous-controller';writeFileSync(reportFile,JSON.stringify(report));
  assert.equal(recover(dir,31_000,160).ready,false);
  write(dir,action({commandId:'clawscout-new-navigation'}));
  assert.equal(recover(dir,61_000,220).ready,false);
}));

test('retiring navigation preserves real goals/memory and only accounts known synthetic duplicate bookkeeping',()=>fixture(dir=>{
  const synthetic={schema:1,...identity,pending:{commandId:'old-click',method:{effects:{'goal:bank':1},prerequisites:[]}},active:{target:{fact:'goal:bank'}}};
  const current={active:{id:'independent-goal'},learning:{wood:5}};
  writeFileSync(join(dir,'agency-memory.json'),JSON.stringify(synthetic));
  writeFileSync(join(dir,'agency-v2.json'),JSON.stringify(current));
  recover(dir,1_000,100);assert.equal(recover(dir,31_000,160).ready,true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'agency-v2.json'),'utf8')),current);
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'agency-memory.json'),'utf8')),synthetic);
}));

test('a settled legacy navigation cannot overrule another pending executor transaction',()=>fixture(dir=>{
  recover(dir,1_000,100);
  const r=recoverLegacyJournals(dir,identity,{apply:true,now:31_000,state:state(160),stable:state(161),executorSettled:false});
  assert.equal(r.entries[0]?.outcome,'interrupted');assert.equal(r.ready,false);
}));

test('inspection-only mode writes no settlement history, backups or altered original',()=>fixture(dir=>{
  recoverLegacyJournals(dir,identity,{now:1_000,state:state(),stable:state(101)});
  assert.equal(existsSync(join(dir,'legacy-recovery.json')),false);
  assert.equal(existsSync(join(dir,'journal-backups')),false);
}));
