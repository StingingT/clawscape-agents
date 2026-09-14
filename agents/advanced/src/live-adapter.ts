import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ActionCommand, Config, Observation, Intent } from './contracts.ts';
import type { Adapter } from './arbiter.ts';
import { projectSnapshot } from './observer.ts';
import { callSkill } from '../../../src/skill-cli';

export type LiveConfig = z.infer<typeof Config>;
type Reply = Record<string, any>;
const same = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Ordinary owner CLI only. Passwords/tokens/descriptors never enter the observation. */
export class CliSession {
  private readonly localIncarnation = crypto.randomUUID();
  readonly root: string;
  readonly home: string;
  constructor(readonly config: LiveConfig, root: string) {
    if (config.character !== 'astra') throw new Error('ASTRA_ONLY');
    this.root = resolve(root,config.game_root);
    if (!config.cli_home) throw new Error('CLI_HOME_REQUIRED');
    this.home = resolve(root,config.cli_home);
    let auth: any;
    try { auth = JSON.parse(readFileSync(join(this.home,'config.jsonl'),'utf8')); }
    catch { throw new Error('CLI_HOME_CONFIGURATION_MISSING_OR_INVALID'); }
    if (new URL(auth.server).origin !== new URL(config.world).origin || !auth.token) throw new Error('OWNER_WORLD_CONFIGURATION_REQUIRED');
  }
  async command(args: string[], timeoutMs = 8000): Promise<Reply> {
    // Share the maintained HTTPS CLI transport while retaining Astra's own
    // planner, journal, arbiter and learning policy.
    return callSkill('astra', args, this.home);
  }
  /** Local client incarnation, NOT a claimed authoritative server epoch. */
  incarnation(): string {
    // HTTPS CLI no longer creates the old local gateway descriptor. A new
    // controller instance intentionally invalidates local entity continuity.
    return this.localIncarnation;
  }
}

export function primitive(i: Intent,o: Observation): {type:string; fields:Record<string,unknown>} {
  const find = (ref:string) => {
    const e = o.entities.find(e => e.ref === ref);
    if (!e) throw new Error('TARGET_GONE');
    return e;
  };
  switch(i.operation) {
    case 'move': return {type:'walkTo',fields:{x:i.destination.x,z:i.destination.z,running:true}};
    case 'close_interface': return {type:o.shop_open?'closeShop':'closeModal',fields:{}};
    case 'accept_design': return {type:'acceptCharacterDesign',fields:{}};
    case 'style': return {type:'setCombatStyle',fields:{style:i.style_index}};
    case 'dialogue': return {type:'clickDialogOption',fields:{optionIndex:i.option_index}};
    case 'deposit': case 'withdraw': return {type:i.operation==='deposit'?'bankDeposit':'bankWithdraw',fields:{slot:i.slot,amount:i.amount}};
    case 'eat': case 'equip': {
      const option = o.inventory.find(x=>x.slot===i.slot&&x.id===i.item_id)?.options
        .find(p=>i.operation==='eat'?/^eat$/i.test(p.text):/^(wield|wear)$/i.test(p.text));
      if (!option) throw new Error('ITEM_OPTION_CHANGED');
      return {type:'useInventoryItem',fields:{slot:i.slot,optionIndex:option.index}};
    }
    case 'pickup': {
      const e=find(i.entity_ref); if(e.kind!=='ground_item') throw new Error('TARGET_KIND');
      return {type:'pickupItem',fields:{x:e.position.x,z:e.position.z,itemId:e.content_id}};
    }
    case 'use_on_item': return {type:'useItemOnItem',fields:{sourceSlot:i.slot,targetSlot:i.target_slot}};
    case 'use_on_object': {
      const e=find(i.entity_ref); if(e.kind!=='object') throw new Error('TARGET_KIND');
      return {type:'useItemOnLoc',fields:{itemSlot:i.slot,x:e.position.x,z:e.position.z,locId:e.content_id}};
    }
    case 'interact': {
      const e=find(i.entity_ref);
      if(e.kind==='npc'&&e.index!==null) return {type:'interactNpc',fields:{npcIndex:e.index,optionIndex:i.option_index}};
      if(e.kind==='object') return {type:'interactLoc',fields:{x:e.position.x,z:e.position.z,locId:e.content_id,optionIndex:i.option_index}};
      throw new Error('TARGET_KIND');
    }
  }
}

/** Local best-effort continuity only; unavailable server generations stay explicit. */
export function revalidate(c: ActionCommand, before: Observation | undefined, now: Observation, maxAgeMs:number): string|null {
  if(!before || now.observed_at-before.observed_at>maxAgeMs || before.seq>now.seq
    || before.session_id!==now.session_id || before.life_id!==now.life_id || before.profile_id!==now.profile_id
    || before.world!==now.world || before.character!==now.character) return 'STALE_STATE';
  const i=c.intent;
  if(i.operation==='move' && !same(before.position,now.position)) return 'MOVED_SINCE_PLAN';
  if('entity_ref' in i) {
    const a=before.entities.find(e=>e.ref===i.entity_ref), b=now.entities.find(e=>e.ref===i.entity_ref);
    if(!a||!b||a.content_id!==b.content_id||a.index!==b.index||a.kind!==b.kind) return 'TARGET_GONE';
    if(a.kind!=='npc'&&!same(a.position,b.position)) return 'TARGET_CHANGED';
  }
  if('slot' in i) {
    const a=(i.operation==='withdraw'?before.bank.items:before.inventory)?.find(x=>x.slot===i.slot);
    const b=(i.operation==='withdraw'?now.bank.items:now.inventory)?.find(x=>x.slot===i.slot);
    if(!a||!b||a.id!==b.id||b.id!==i.item_id||a.count!==b.count) return 'ITEM_CHANGED_SINCE_PLAN';
  }
  if(i.operation==='dialogue'&&!same(before.dialog,now.dialog)) return 'INTERFACE_CHANGED';
  return null;
}

export function assessThreat(o:Observation,previous?:Observation): Observation['danger'] {
  if(!o.activity || !o.position || o.hp===null) return {active:null,damage_margin:null};
  const a=o.activity;
  if(a.target_type==='player') return {active:true,damage_margin:null};
  const target=o.entities.find(e=>e.kind==='npc'&&e.index===a.target_index);
  const attackable=target?.options.some(p=>/^attack$/i.test(p.text));
  const known=target && /^(rat|chicken|goblin|cow|cow calf)$/i.test(target.name) && (target.combat_level??100)>0 && (target.combat_level??100)<=5;
  const freshDamage=(o.tick??-100)-a.last_damage_tick<=3&&a.last_damage_tick>=0;
  const lostHp=previous?.life_id===o.life_id && previous.hp!==null && previous.hp!==undefined && o.hp<previous.hp;
  if(lostHp && previous!.hp!-o.hp>2) return {active:true,damage_margin:null};
  if(attackable && !known || (freshDamage||lostHp)&&!known) return {active:true,damage_margin:null};
  // Pilot-only margin: two early-game <=2 damage hits plus one HP. This is a
  // conservative engineering allowance, not a measured death probability.
  return {active:false,damage_margin:5};
}

export class LiveAdapter implements Adapter {
  private seq=0;
  private lastTick:number|null=null;
  private freshAt:number|null=null;
  private history=new Map<number,Observation>();
  private refs=new Map<string,string>();
  private last?:Observation;
  private permit?:{intent:Intent;observation:Observation;expires:number};
  constructor(readonly cli:CliSession,private profile:string,initialSeq=0) {
    if(cli.config.mode!=='live'||cli.config.live_control!=='local-single-controller') throw new Error('LIVE_CONFIGURATION_REQUIRED');
    this.seq=initialSeq;
  }
  async snapshot():Promise<Observation> {
    const raw=await this.cli.command(['state']);
    const incarnation=this.cli.incarnation();
    const now=Date.now(),tick=typeof raw.state?.tick==='number'?raw.state.tick:null;
    const reset=this.last && (this.last.session_id!==incarnation || tick!==null&&this.lastTick!==null&&tick<this.lastTick);
    if(reset) {this.refs.clear();this.history.clear();this.freshAt=null;this.lastTick=null;}
    if(tick!==null&&this.lastTick!==null&&tick>this.lastTick) this.freshAt=now;
    this.lastTick=tick;
    const o=projectSnapshot(raw,{character:'astra',world:this.cli.config.world,session:incarnation,profile:this.profile,
      seq:++this.seq,now,freshAt:this.freshAt,keep:this.cli.config.keep_item_ids});
    const next=new Map<string,string>();
    for(const e of o.entities) {
      const key=[o.life_id,e.kind,e.content_id,e.index,e.kind==='npc'?'mobile':JSON.stringify(e.position)].join(':');
      e.ref=this.refs.get(key)??crypto.randomUUID();next.set(key,e.ref);
    }
    this.refs=next;
    for(const i of o.inventory) if(i.options.some(p=>/^eat$/i.test(p.text))) i.protected=true;
    // Ground items expose pickup reachability but have no options in SDK state.
    o.danger=assessThreat(o,this.last);
    o.unavailable=o.unavailable.filter(x=>x!=='threat-model');
    o.unavailable.push('pilot-only-threat-model','best-effort-local-entity-continuity');
    this.history.set(o.seq,o);
    for(const [seq,old] of this.history) if(now-old.observed_at>10000)this.history.delete(seq);
    this.last=o;
    return o;
  }
  validateCommand(c:ActionCommand,o:Observation) {return revalidate(c,this.history.get(c.based_on_snapshot),o,this.cli.config.max_stale_ms);}
  authorize(c:ActionCommand,o:Observation) {this.permit={intent:c.intent,observation:o,expires:Date.now()+500};}
  async dispatch(intent:Intent) {
    const permit=this.permit;this.permit=undefined;
    if(!permit||permit.expires<Date.now()||!same(permit.intent,intent)) throw new Error('ARBITER_AUTHORIZATION_REQUIRED');
    const p=primitive(intent,permit.observation);
    const result=await this.cli.command(['act',p.type,'--json',JSON.stringify(p.fields)]);
    return {success:result.success===true,phase:typeof result.phase==='string'?result.phase:'dispatch',
      reason:result.success===false?'CLIENT_REJECTED':undefined};
  }
}
