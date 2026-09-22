import {test,expect} from 'bun:test';
import {boundedInteractionRetirement,BOUNDED_INTERACTION_RECONCILIATION_MS,type Receipt} from '../../src/agency/live-adapter.ts';

const state=(tick=20,lifeId=1):any=>({
  inGame:true,tick,character:'clawscout',world:'clawscape',worldEpoch:1,profileId:'profile',
  player:{worldX:3057,worldZ:3483,level:0,lifeId,isDead:false}
});
const receipt=(type='interactLoc'):Receipt=>({
  commandId:'historical-command',scope:'task',startedAt:1000,
  action:{id:'discover',type,fields:{locId:2641,x:3057,z:3483,optionIndex:1}},
  before:state(10,1)
});

test('bounded fresh investigation retires an unattributable interaction without claiming success or failure',()=>{
  const result=boundedInteractionRetirement(receipt(),state(30,1),1000+BOUNDED_INTERACTION_RECONCILIATION_MS);
  expect(result?.status).toBe('interrupted');
  expect(result?.recovery).toBe('investigate');
  expect(result?.historical).toBeUndefined();
  expect(result?.evidence.join(' ')).toContain('old command retired without replay');
  expect(result?.reason).toContain('outcome remains unknown');
});

test('interaction is not retired before the bounded investigation horizon',()=>{
  expect(boundedInteractionRetirement(receipt(),state(30,1),
    1000+BOUNDED_INTERACTION_RECONCILIATION_MS-1)).toBeUndefined();
});

test('a stale character-design acknowledgement cannot hold a worker forever',()=>{
  const r=receipt('acceptCharacterDesign');
  r.action={id:'accept-design',type:'acceptCharacterDesign',waitTicks:2};
  const result=boundedInteractionRetirement(r,state(30,1),1000+BOUNDED_INTERACTION_RECONCILIATION_MS);
  expect(result?.status).toBe('interrupted');
  expect(result?.recovery).toBe('investigate');
  expect(result?.reason).toContain('outcome remains unknown');
});

test('life and world identity changes prevent administrative retirement',()=>{
  expect(boundedInteractionRetirement(receipt(),state(30,2),200000)).toBeUndefined();
  const changed=state(30,1);changed.worldEpoch=2;
  expect(boundedInteractionRetirement(receipt(),changed,200000)).toBeUndefined();
});

test('transactions and dialogue choices remain outside bounded interaction retirement',()=>{
  for(const type of ['shopBuy','shopSell','bankDeposit','bankWithdraw','clickDialogOption'])
    expect(boundedInteractionRetirement(receipt(type),state(30,1),200000)).toBeUndefined();
});
