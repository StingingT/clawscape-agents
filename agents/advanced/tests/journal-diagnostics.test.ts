import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { reconcileAstraJournals } from '../src/restart-journals.ts';
import { describeJournalAction } from '../src/journal-diagnostics.ts';
import { inspectAstraJournal } from '../../../scripts/astra-recovery-report.ts';
import type { Observation, ActionCommand, ActionResult } from '../src/contracts.ts';
const observation=(seq=10):Observation=>({schema_version:'1.0',character:'astra',world:'fixture',profile_id:'fixture',world_epoch:'epoch',session_id:'private-client-id',
  seq,tick:seq,observed_at:Date.now(),fresh_at:Date.now(),provenance:'simulation',connected:true,position:{x:10,z:10,plane:0},hp:30,max_hp:30,life_id:1,respawns:0,
  skills:[],capacity:28,inventory:[],equipment:[],bank:{open:false,items:null},shop_open:false,
  dialog:{open:true,waiting:false,text:'Choose an option',options:[{index:1,text:'Continue quest'}]},entities:[],feedback:[],danger:{active:false,damage_margin:2},unavailable:[],
  activity:{animation:-1,target_index:-1,target_type:'none',last_damage_tick:-1,modal_open:true,modal_id:42,style:null,styles:[],design_open:false,events:[]}});
const command=(lease:string,id='dialogue-1'):ActionCommand=>({schema_version:'1.0',action_id:id,character:'astra',world:'fixture',profile_id:'fixture',world_epoch:'epoch',
  session_id:'old-private-client',lease,plan_id:'fixture-plan',based_on_snapshot:1,expires_at:1,intent:{operation:'dialogue',option_index:1}});
const result=(id='dialogue-1'):ActionResult=>({schema_version:'1.0',action_id:id,status:'FAILED',reason:'OUTCOME_UNKNOWN',at:1,evidence:[]});
function fixture(f:(store:Store,root:string,lease:string)=>void){const root=mkdtempSync(join(tmpdir(),'journal-diagnostic-')),store=new Store(join(root,'journal.sqlite'));
  try{f(store,root,store.acquireRecovery('fixture-owner',Date.now()));}finally{store.close();rmSync(root,{recursive:true,force:true});}}
test('five unknown dialogues remain unresolved but report their original choices and checkpoints',()=>fixture((store,root,lease)=>{
  for(let n=1;n<=5;n++){const id='dialogue-'+n;store.createAction(command(lease,id),result(id));store.append('action_checkpoints',id,{action_id:id,before:observation(1)});}
  const report=reconcileAstraJournals(store,root,observation(10),observation(11));expect(report.ready).toBe(false);expect(report.unresolved).toHaveLength(5);
  for(const row of report.unresolved){expect(row.details?.before?.dialogue?.selectedText).toBe('Continue quest');expect(row.details?.checkpointCount).toBe(1);expect(row.details?.replayAuthorized).toBe(false);}
  expect(store.unsettled()).toHaveLength(5);expect(store.pending()).toHaveLength(0);
  for(const row of store.allActions())expect(row.result).toEqual(result(row.command.action_id));
}));
test('closed current dialogues do not establish a historical reward result',()=>fixture((store,root,lease)=>{
  store.createAction(command(lease),result());store.append('action_checkpoints','dialogue-1',{action_id:'dialogue-1',before:observation(1)});
  const first=observation(10),second=observation(11);for(const s of [first,second]){s.session_id='new-client';s.dialog.open=false;s.activity!.modal_open=false;}
  const r=reconcileAstraJournals(store,root,first,second);expect(r.ready).toBe(false);expect(r.unresolved[0]?.settling).toBe(false);
}));
test('missing or ambiguous original checkpoints are reported, never reconstructed from a later observation',()=>{
  const c=command('private-lease'),r=result();expect(describeJournalAction(c,r,[]).before).toBe(null);
  const matches=[{action_id:c.action_id,before:observation(1)},{action_id:c.action_id,before:observation(2)}];
  const d=describeJournalAction(c,r,matches);expect(d.checkpointCount).toBe(2);expect(d.before).toBe(null);expect(d.replayAuthorized).toBe(false);
});
test('read-only exporter includes unresolved failed actions and never changes control, results or creates absent journals',()=>fixture((store,root,lease)=>{
  store.createAction(command(lease),result());store.append('action_checkpoints','dialogue-1',{action_id:'dialogue-1',before:observation(1)});
  const control=store.control(),original=store.action('dialogue-1'),file=join(root,'journal.sqlite'),bytes=readFileSync(file);
  const report=inspectAstraJournal(file);expect(report.unresolvedCount).toBe(1);expect(report.readOnly).toBe(true);expect(report.truncated).toBe(false);
  expect(store.control()).toEqual(control);expect(store.action('dialogue-1')).toEqual(original);expect(readFileSync(file)).toEqual(bytes);
  const absent=join(root,'absent.sqlite');expect(()=>inspectAstraJournal(absent)).toThrow('EXISTING');expect(existsSync(absent)).toBe(false);
  const text=JSON.stringify(report);expect(text).not.toContain(lease);expect(text).not.toContain('private-client');expect(text).not.toContain('private-client-id');
}));
test('diagnostic text is bounded and credential-looking data is redacted',()=>{
  const c=command('private-lease'),r=result(),before=observation(1);before.dialog.text='token=PRIVATE';before.dialog.options[0]!.text='password=PRIVATE';r.reason='authorization=PRIVATE';
  const text=JSON.stringify(describeJournalAction(c,r,[{action_id:c.action_id,before}]));expect(text).not.toContain('PRIVATE');expect(text).toContain('[redacted]');
});
