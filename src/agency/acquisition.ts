import { itemName,itemCount,itemMatches,itemFact,type ItemNeed } from './item-intents.ts';
import { chooseIncidentalGroundItem } from './incidental.ts';
import type { DropLead } from './drop-leads.ts';
import type { Catalogue,LiveState,Policy,Route,Task } from './world-model.ts';
import type { Memory,Method } from './types.ts';
import type { LiveCandidate } from './live-adapter.ts';

export type AcquisitionSource={key:string;kind:'bank'|'shop'|'ground'|'gather'|'drop';item:ItemNeed;
  position?:{x:number;z:number;level:number};entityId?:number;entityName?:string;at?:number;
  evidence:string;confidence:'observed'|'remembered'|'unverified';cost?:number};
export type AcquisitionHint=AcquisitionSource;
export type NeededItem=ItemNeed & {parentKey:string;reason:string;at:number};
export type AcquisitionMemory={need?:NeededItem;shops:AcquisitionSource[];sightings:AcquisitionSource[];
  incidental?:{lastAt?:number;cooldowns:Record<string,number>;ids:Record<string,number>};
  lastResolution?:{at:number;item:ItemNeed;evidence:string};leads?:AcquisitionSource[];blocker?:string};
export const emptyAcquisition=():AcquisitionMemory=>({shops:[],sightings:[]});
const valid=(p:any)=>p&&[p.x,p.z,p.level].every(Number.isInteger);
const at=(s:LiveState,p:AcquisitionSource['position'])=>valid(p)&&s.player?.level===p!.level&&Math.max(Math.abs(s.player.worldX-p!.x),Math.abs(s.player.worldZ-p!.z))<=2;
const option=(e:any,regex:RegExp)=>(e?.optionsWithIndex??[]).find((o:any)=>Number.isInteger(o.opIndex)&&regex.test(String(o.text)));
/** A remembered merchant stock is attributed only to a matching observed Trade action. */
export function rememberAcquisitionSources(memory:AcquisitionMemory,before:LiveState,after:LiveState,action:LiveCandidate,now:number):void {
  if(action.type!=='interactNpc'||before.shop?.isOpen===true||after.shop?.isOpen!==true)return;
  const npc=(before.nearbyNpcs??[]).find((n:any)=>n.index===action.fields?.npcIndex);
  if(!npc||!/^trade$/i.test(String((npc.optionsWithIndex??[]).find((o:any)=>o.opIndex===action.fields?.optionIndex)?.text)))return;
  const location={x:npc.x??npc.tileX,z:npc.z??npc.tileZ,level:before.player?.level};if(!valid(location))return;
  const merchant=npc.id+':'+location.x+':'+location.z;
  memory.shops=memory.shops.filter(s=>!s.key.startsWith('shop:'+merchant+':'));
  for(const item of after.shop?.shopItems??[])if(Number.isInteger(item.id)&&Number(item.count)>0)
    memory.shops.push({key:'shop:'+merchant+':'+item.id,kind:'shop',item:{id:item.id,name:String(item.name),minimum:1},position:location,
      entityId:npc.id,entityName:String(npc.name),at:now,cost:Number.isFinite(item.buyPrice)?item.buyPrice:undefined,
      confidence:'remembered',evidence:`own-trade-stock:${before.tick}->${after.tick}:${item.id}`});
  memory.shops=memory.shops.slice(-256);
}
export function observeAcquisitionSources(memory:AcquisitionMemory,state:LiveState,now:number):void {
  // These positions come from this character's own observations, not another agent's save.
  for(const n of state.nearbyNpcs??[])if(Number.isInteger(n.id)&&option(n,/^attack$/i)) {
    const position={x:n.x??n.tileX,z:n.z??n.tileZ,level:state.player?.level};if(!valid(position))continue;
    const key='seen-npc:'+n.id;
    memory.sightings=memory.sightings.filter(s=>s.key!==key);
    memory.sightings.push({key,kind:'drop',entityId:n.id,entityName:String(n.name),position,at:now,
      item:{name:'unknown',minimum:1},confidence:'observed',evidence:`own-npc-sighting:${state.tick}:${n.id}`});
  }
  memory.sightings=memory.sightings.slice(-128);
}
export function acquisitionSources(state:LiveState,bank:any[],memory:AcquisitionMemory,need:ItemNeed,
  drops:DropLead[],hints:AcquisitionHint[],now:number):AcquisitionSource[] {
  const result:AcquisitionSource[]=[];
  const present=(rows:any[])=>rows?.filter(i=>itemMatches(i,need)&&Number(i.count??1)>0)??[];
  if(present(state.bank?.isOpen===true?state.bank.items:bank).length)
    result.push({key:'bank:'+itemFact(need),kind:'bank',item:need,confidence:state.bank?.isOpen===true?'observed':'remembered',evidence:'own-bank-stock; fresh bank view required for withdrawal'});
  for(const i of present(state.groundItems))if(Number.isInteger(i.id)) {
    const position={x:i.x??i.tileX,z:i.z??i.tileZ,level:state.player?.level};if(!valid(position))continue;
    result.push({key:'ground:'+i.id+':'+position.x+':'+position.z,kind:'ground',item:need,position,confidence:'observed',evidence:`own-ground-item:${state.tick}:${i.id}`});
  }
  if(state.shop?.isOpen===true)for(const i of present(state.shop.shopItems))
    result.push({key:'current-shop:'+i.id,kind:'shop',item:need,confidence:'observed',evidence:`own-current-stock:${state.tick}:${i.id}`,cost:Number(i.buyPrice)});
  result.push(...memory.shops.filter(s=>need.id!==undefined&&s.item.id!==undefined?s.item.id===need.id:itemName(s.item.name)===itemName(need.name)).map(s=>({...s,item:need})));
  if(itemName(need.name)==='logs') {
    for(const tree of state.nearbyLocs??[])if(/^tree$/i.test(String(tree.name))&&option(tree,/^chop(?: down|-down)?$/i)) {
      const position={x:tree.x,z:tree.z,level:state.player?.level};if(!valid(position))continue;
      result.push({key:'gather:logs:'+tree.id+':'+tree.x+':'+tree.z,kind:'gather',entityId:tree.id,entityName:String(tree.name),position,item:need,
        confidence:'unverified',evidence:`own-tree-option:${state.tick}; logs recipe is an existing controller hypothesis`});
    }
  }
  for(const lead of drops.filter(d=>itemName(d.item)===itemName(need.name))) {
    const sites=[...memory.sightings,...hints.filter(h=>h.kind==='drop')].filter(s=>itemName(s.entityName)===itemName(lead.monster));
    for(const site of sites)result.push({...site,key:'drop:'+lead.file+':'+site.key,item:need,confidence:'unverified',
      evidence:`${lead.sourceUrl}#${lead.symbol}; unverified drop lead; ${site.evidence}`});
  }
  result.push(...hints.filter(h=>h.kind!=='drop'&&itemName(h.item.name)===itemName(need.name)).map(h=>({...h,item:need})));
  return [...new Map(result.map(s=>[s.key,s])).values()].slice(0,32);
}
/** Acquisition remains a support plan under the original objective. Owning items in a
 * bank is not the same fact as carrying them, and visiting a shop never satisfies it. */
export function addAcquisition(c:Catalogue,state:LiveState,bank:any[],m:AcquisitionMemory,memory:Memory,
  policy:Policy,drops:DropLead[],hints:AcquisitionHint[],now:number):void {
  // Opportunism is subordinate to the current objective. With no existing dependency,
  // a valuable observed ground resource may become one small acquisition support step.
  // The evaluator is generic: it uses carrying cost, collection/stack/equipment value
  // and personal observation rather than a hard-coded creature or drop list.
  if(!m.need&&memory.active&&!memory.pending&&!memory.active.requestedSupport&&state.player?.combat?.inCombat!==true) {
    m.incidental??={cooldowns:{},ids:{}};m.incidental.cooldowns??={};m.incidental.ids??={};
    const choice=now-(m.incidental.lastAt??0)>=30_000?chooseIncidentalGroundItem(state,now,m.incidental.cooldowns):undefined;
    if(choice) {
      m.incidental.lastAt=now;m.incidental.cooldowns[choice.key]=now+120_000;
      if(choice.need.id!==undefined)m.incidental.ids[String(choice.need.id)]=now;
      m.need={...choice.need,parentKey:memory.active.key,reason:choice.reason,at:now};
      memory.active.requestedSupport={target:{fact:itemFact(choice.need),minimum:choice.need.minimum},reason:choice.reason,evidence:choice.evidence};
    }
  }
  const need=m.need;if(!need||need.parentKey!==memory.active?.key){delete m.need;return;}
  c.view.facts[itemFact(need)]=itemCount(state.inventory,need);
  if(c.view.facts[itemFact(need)]!>=need.minimum){m.lastResolution={at:now,item:need,evidence:`fresh-carried-items:${state.tick}`};delete m.need;delete m.blocker;return;}
  const sources=acquisitionSources(state,bank,m,need,drops,hints,now);m.leads=sources;
  m.blocker=sources.length?undefined:'No supported source located yet; retain the item requirement and research/discover a source. No item or route is invented.';
  for(const source of sources) {
    const id='acquire:'+source.key,combat=source.kind==='drop';
    const prerequisites:Method['prerequisites']=combat?[{fact:'weapon',minimum:1},{fact:'food',minimum:policy.foodTarget}]:[];
    if(source.kind==='gather')prerequisites.push({fact:'axe',minimum:1});
    c.methods.push({id,capability:'acquisition',domain:combat?'combat':'gathering',prerequisites,
      effects:{[itemFact(need)]:Math.max(1,need.minimum-itemCount(state.inventory,need))},costGp:0,
      lossBoundGp:combat?policy.combatLossBoundGp??0:0,risk:combat?(policy.combatLossBoundGp===undefined?'unknown':'bounded'):'safe',
      durationMs:30000+(source.position?Math.max(Math.abs(state.player.worldX-source.position.x),Math.abs(state.player.worldZ-source.position.z))*600:0)});
    c.tasks.set(id,{id,kind:'acquisition',acquisition:{need,source}});
  }
  if(sources.length&&!c.view.capabilities.includes('acquisition'))c.view.capabilities.push('acquisition');
}
export type AcquisitionPort={bank:(state:any)=>LiveCandidate[];route:(destination:{x:number;z:number;level:number})=>Promise<{destination?:{x:number;z:number;level:number};reason?:string;status:string}>;canFight:(npc:any)=>boolean};
export async function acquisitionActions(state:LiveState,task:Task,port:AcquisitionPort):Promise<{actions:LiveCandidate[];reason?:string}> {
  const request=task.acquisition;if(!request)return {actions:[],reason:'Missing semantic item requirement.'};
  const {need,source}=request,remaining=Math.max(0,need.minimum-itemCount(state.inventory,need));
  if(!remaining)return {actions:[]};
  const fail=(reason:string)=>({actions:[],reason});
  const action=(type:string,fields:Record<string,any>={},waitTicks=2)=>({actions:[{id:task.id+':'+type,type,fields,waitTicks}]});
  const travel=async()=>{
    if(!source.position)return fail('Source no longer visible and no verified location lead is available.');
    const path=await port.route(source.position);
    return path.status==='ready'&&path.destination?action('walkTo',{...path.destination,reason:source.evidence}):fail(path.reason??'Source route unavailable');
  };
  if(source.kind!=='bank' && state.bank?.isOpen===true)return action('closeModal');
  if(source.kind!=='shop' && state.shop?.isOpen===true)return action('closeShop');
  if(source.kind==='bank') {
    if(state.bank?.isOpen!==true)return {actions:port.bank(state)};
    const row=(state.bank.items??[]).find((i:any)=>itemMatches(i,need)&&i.count>0);
    return row?action('bankWithdraw',{slot:row.slot,amount:Math.min(remaining,row.count)}):fail('Fresh bank inspection: required item is no longer present.');
  }
  if(source.kind==='shop') {
    if(state.shop?.isOpen===true){
      const row=(state.shop.shopItems??[]).find((i:any)=>itemMatches(i,need)&&i.count>0&&Number.isFinite(i.buyPrice)&&i.buyPrice>=0);
      return row?action('shopBuy',{slot:row.slot,amount:1}):fail('Fresh shop inspection: item absent, out of stock or price unknown.');
    }
    const npc=(state.nearbyNpcs??[]).find((n:any)=>n.reachable===true&&(source.entityId!==undefined?n.id===source.entityId:itemName(n.name)===itemName(source.entityName)));
    const op=option(npc,/^trade$/i);
    return npc&&op?action('interactNpc',{npcIndex:npc.index,optionIndex:op.opIndex}):at(state,source.position)?fail('Merchant lead inspected; no reachable matching Trade option is currently visible.'):travel();
  }
  if(source.kind==='ground'||source.kind==='drop') {
    const row=(state.groundItems??[]).find((i:any)=>itemMatches(i,need)&&i.reachable===true);
    if(row)return action('pickupItem',{itemId:row.id,x:row.x??row.tileX,z:row.z??row.tileZ});
    if(source.kind==='ground')return at(state,source.position)?fail('Ground source inspected; item is not currently visible.'):travel();
    const npc=(state.nearbyNpcs??[]).find((n:any)=>(source.entityId===undefined||n.id===source.entityId)&&itemName(n.name)===itemName(source.entityName)
      && n.reachable===true&&n.inCombat!==true&&n.hp!==0&&port.canFight(n));
    const op=option(npc,/^attack$/i);
    return npc&&op?action('interactNpc',{npcIndex:npc.index,optionIndex:op.opIndex}):at(state,source.position)?fail('Drop lead needs an available supported encounter; no kill/drop is presumed.'):travel();
  }
  const loc=(state.nearbyLocs??[]).find((l:any)=>(source.entityId===undefined||l.id===source.entityId)&&/^tree$/i.test(l.name)&&l.reachable===true);
  const op=option(loc,/^chop(?: down|-down)?$/i);
  return loc&&op?action('interactLoc',{locId:loc.id,x:loc.x,z:loc.z,optionIndex:op.opIndex},5):at(state,source.position)?fail('Gathering lead inspected; no usable resource is currently visible.'):travel();
}