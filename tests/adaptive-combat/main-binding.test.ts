import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as nodeModule from 'node:module';
import {runInNewContext} from 'node:vm';
import {state} from './fixtures.ts';
const source=readFileSync(resolve(import.meta.dirname,'../../src/agent.ts'),'utf8');
const start=source.indexOf('async function actionsForTask('),end=source.indexOf('\nfunction urgentAgencyAction(',start);
assert.ok(start>=0&&end>start);
const block=source.slice(start,end);
const js=process.versions.bun?new (globalThis as any).Bun.Transpiler({loader:'ts'}).transformSync(block):(nodeModule as any).stripTypeScriptTypes(block,{mode:'transform'});
const obtain=(investigation:any,ready=true)=>{
 const calls:string[]=[];const env={stateProvesAcknowledgementStillRequired:()=>false,training:{equipmentTrial:()=>{calls.push('review-equipment');return investigation;},
 next:()=>{calls.push('training-next');return [{id:'attack',type:'interactNpc'}];}},gearCandidates:()=>{calls.push('static-gear');return [{id:'static-upgrade',type:'useInventoryItem'}];},
 navigator:{assess:()=>({status:'ready'})},agency:{sourceActions:()=>[{id:'source',type:'wait'}]},bankAt:()=>[],position:()=>({x:1,z:1,level:0})};
 return {fn:runInNewContext(js+'\nactionsForTask',env),calls};
};
test('actual main task dispatcher respects an approved carried-kit experiment before a static tier upgrade',async()=>{
 const a={id:'experiment',type:'useInventoryItem'},x=obtain({holdEquipment:true,action:a});const result=await x.fn(state(),{kind:'combat',skill:'strength'});
 assert.equal(result[0].id,'experiment');assert.deepEqual(x.calls,['review-equipment']);
});
test('actual main dispatcher holds a measured configuration instead of undoing every experimental swap',async()=>{
 const x=obtain({holdEquipment:true}),r=await x.fn(state(),{kind:'combat',skill:'strength'});assert.equal(r[0].id,'attack');
});
test('when no experimental or learned preference applies original equipment logic remains available',async()=>{
 const x=obtain({holdEquipment:false}),r=await x.fn(state(),{kind:'combat',skill:'strength'});assert.equal(r[0].id,'static-upgrade');
});
test('ongoing combat and death preempt experimental candidate generation in the real function',async()=>{
 const x=obtain({holdEquipment:true,action:{id:'never'}}),s=state();s.player.combat.inCombat=true;
 assert.equal((await x.fn(s,{kind:'combat',skill:'strength'}))[0].type,'wait');assert.equal(x.calls.length,0);
 s.player.isDead=true;assert.equal((await x.fn(s,{kind:'combat',skill:'strength'})).length,0);
});
test('unknown combat skill execution does not create experimental equipment actions',async()=>{
 const x=obtain({holdEquipment:true,action:{id:'never'}});assert.equal((await x.fn(state(),{kind:'combat',skill:'magic'})).length,0);assert.equal(x.calls.length,0);
});
test('main preflight still validates marked learning actions before Director begin',()=>{
 const a=source.indexOf('if(action.fields?.trainingSite&&!training?.validateAction(fresh,action))'),b=source.indexOf('agency.begin(planned,action,state,commandId)',a),c=source.indexOf('training?.beforeAction(state,action)',b);
 assert.ok(a>=0&&b>a&&c>b);assert.match(source,/training\?\.afterAction\?\.\(state,next,emergency\)/);
});
