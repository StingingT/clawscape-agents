import { skillLevel, woodSites, fletchingRecipe, foodCount, type EconomyMemory, type Action } from '../progression-policy';
import { canMine } from './metalworking';
import { BOWS } from './bowmaking';
import { toolPlan } from './tool-progression';

export type WorkTrack='woodworking'|'metalworking';
export type WorkIntent={id:string;track:WorkTrack;site?:string;mode:'logs'|'fletch'|'metal'|'finish';inputId:number;inputName:string;outputId:number;recipe?:string;toolTargetId?:number;reason:string};
export type ProductionNeed={goal:string;outputId:number;quantity:number;expires:number;verified:boolean;downstreamReady:boolean;benefit:'equipment'|'profitable-order'};
export type Economics={revenue:number|null;materialCost:number|null;supplyCost:number|null;expectedLoss:number|null;seconds:number|null;saleable:boolean};
export type Opportunity={intent:WorkIntent;economics:Economics;usefulNeed?:ProductionNeed;blocked?:string};
type Price={price:number;at:number;verifiedSale:boolean};
type Cycle={id:string;started:number;produced:number;gathered:number;sold:boolean;expenses:number;loss:number;bankedInputs:boolean;incompleteStart:boolean};
export type ObjectiveMemory={intent?:WorkIntent;prices:Record<number,Price>;samples:Record<string,{units:number;seconds:number;cost:number;loss:number;sold?:boolean;at:number}[]>;
  completed:number;lastProbe:number;trials?:Record<string,number>;cycle?:Cycle;needs:ProductionNeed[];decision?:any;blocked:Record<string,number>};
const count=(items:any[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+Number(i.count),0);
const HORIZON=30*60_000;
export function objectives(m:EconomyMemory):ObjectiveMemory{return m.objectives??={prices:{},samples:{},completed:0,lastProbe:0,needs:[],blocked:{}};}
export function netProfitPerHour(e:Economics):number|null {
  if(!e.saleable||![e.revenue,e.materialCost,e.supplyCost,e.expectedLoss,e.seconds].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)||!(e.seconds!>0))return null;
  return (e.revenue!-e.materialCost!-e.supplyCost!-e.expectedLoss!)*3600/e.seconds!;
}
export function chooseOpportunity(choices:Opportunity[],old:WorkIntent|undefined,now:number,probe=false):Opportunity|undefined {
  const eligible=choices.filter(c=>!c.blocked),demand=eligible.filter(c=>c.usefulNeed?.verified&&c.usefulNeed.downstreamReady&&c.usefulNeed.quantity>0&&c.usefulNeed.expires>now);
  // A validated, finite equipment/material order can use a maxed skill. A
  // hypothetical customer or unfinished downstream chain is not such an order.
  if(demand.length)return demand.find(c=>c.intent.id===old?.id)??demand[0];
  const scored=eligible.map(c=>({c,score:netProfitPerHour(c.economics)}));
  if(probe){const unknown=scored.find(c=>c.score===null&&c.c.intent.id!==old?.id);if(unknown)return unknown.c;}
  const ranked=scored.filter(c=>c.score!==null).sort((a,b)=>b.score!-a.score!);
  const current=ranked.find(c=>c.c.intent.id===old?.id);
  if(ranked[0]&&ranked[0].score!>0){
    // Small quote changes must not cause repeated cross-world trips.
    if(current&&current.score!>=ranked[0].score!*.85)return current.c;
    return ranked[0].c;
  }
  // Unknown is not profitable and negative profit is not a reason to grind a
  // tier. Retain a supported baseline or try an unmeasured safe alternative.
  return scored.find(c=>c.score===null&&c.c.intent.id===old?.id)?.c??scored.find(c=>c.score===null)?.c;
}
const woods:Record<string,{input:number;name:string;short:number;long:number}>= {
  Tree:{input:1511,name:'Logs',short:50,long:48},Oak:{input:1521,name:'Oak logs',short:54,long:56},
  Willow:{input:1519,name:'Willow logs',short:60,long:58},Yew:{input:1515,name:'Yew logs',short:68,long:66},
};
export function workOpportunities(s:any,m:EconomyMemory,now=Date.now()):Opportunity[]{
  const memory=objectives(m),result:Opportunity[]=[];
  const add=(intent:WorkIntent,blocked?:string)=>{
    const samples=(memory.samples[intent.id]??[]).filter(v=>now-v.at<24*3600_000).slice(-5);
    const units=samples.reduce((n,v)=>n+v.units,0),seconds=samples.reduce((n,v)=>n+v.seconds,0),price=memory.prices[intent.outputId];
    const fresh=price&&now-price.at<HORIZON;
    // Rates cover the observed gathering/processing/bank cycle. Sale travel
    // overhead is conservatively estimated until an end-to-end seller exists.
    const saleOverhead=120;
    const economics:Economics={revenue:fresh&&units>0?price.price*units:null,materialCost:0,
      supplyCost:units>0?samples.reduce((n,v)=>n+v.cost,0):null,expectedLoss:units>0?samples.reduce((n,v)=>n+v.loss,0):null,
      seconds:units>0?seconds+saleOverhead*samples.filter(v=>!v.sold).length:null,saleable:!!fresh};
    const need=memory.needs.find(n=>n.outputId===intent.outputId&&count([...(s.inventory??[]),...(m.bankItems??[])],intent.outputId)<n.quantity);
    result.push({intent,economics,usefulNeed:need,blocked:blocked??((memory.blocked[intent.id]??0)>now?'recent action failure':undefined)});
  };
  const tools=toolPlan(s,m.bankItems??[]);
  if(tools) {
    add({id:`tool-chain:axe-${tools.finalAxe.tier}-stage-${tools.stage.tier}`,track:'metalworking',mode:'metal',
      inputId:tools.stage.barId,inputName:tools.stage.barName,outputId:tools.stage.axeId,toolTargetId:tools.finalAxe.axeId,
      reason:tools.reason});
  }
  const sites=woodSites(s,false);
  for(const site of sites){
    const w=woods[site.tree]!;const recipe=fletchingRecipe(w.name,skillLevel(s,'fletching'));
    const common={track:'woodworking' as const,site:site.name,inputId:w.input,inputName:w.name};
    // Preserve the existing supported production baseline while prices/rates
    // are unknown; higher-tier preference here is a prior, not a profit claim.
    if(recipe){
      const short=/short/i.test(recipe),outputId=/shafts/i.test(recipe)?52:short?w.short:w.long;
      add({...common,id:site.name+':fletch:'+outputId,mode:'fletch',outputId,recipe,reason:'Produce saleable kit inputs; compare measured cycle return'},(m.siteCooldowns?.[site.name]??0)>now?'resource cooldown':undefined);
      // Finished-gear input orders may need shortbows even when the ordinary
      // training recipe would choose a longbow. All downstream checks persist.
      if(!short&&recipe!=='Arrow Shafts'&&memory.needs.some(n=>n.outputId===w.short))add({...common,id:site.name+':fletch:'+w.short,mode:'fletch',outputId:w.short,recipe:(site.tree==='Tree'?'':site.tree+' ')+'Short Bow',reason:'Bounded input for a verified equipment/production goal'});
    }
    add({...common,id:site.name+':logs',mode:'logs',outputId:w.input,reason:'Sell useful raw materials when processing would reduce return'},(m.siteCooldowns?.[site.name]??0)>now?'resource cooldown':undefined);
  }
  const iron=skillLevel(s,'mining')>=15&&skillLevel(s,'smithing')>=15;
  add({id:iron?'metal:iron':'metal:bronze',track:'metalworking',mode:'metal',inputId:iron?440:436,inputName:iron?'Iron ore':'Copper ore',outputId:iron?(skillLevel(s,'smithing')>=20?40:1203):(skillLevel(s,'smithing')>=5?39:1205),reason:'Test a mining/smithing production chain for future profitable goods'},
    !canMine(s)?'Needs a usable carried pickaxe':undefined);
  for(const bow of [...BOWS].reverse())if(skillLevel(s,'fletching')>=bow.level&&count([...(s.inventory??[]),...(m.bankItems??[])],bow.input)>0){
    const intent:WorkIntent={id:'finish-bow:'+bow.input,track:'woodworking',mode:'finish',inputId:bow.input,inputName:bow.name,outputId:bow.output,reason:'Unlock Crafting 10 and measure finished bows against unstrung sales'};
    add(intent,(m.bowmaking?.cooldownUntil??0)>now?'Bowmaking recovery cooldown':undefined);
    const rows=(m.bowmaking?.samples?.[bow.output]??[]).filter(r=>now-r.at<24*3600_000),units=rows.reduce((n,r)=>n+r.units,0),price=memory.prices[bow.output];
    result[result.length-1]!.economics={revenue:price&&now-price.at<HORIZON&&units>0?price.price*units:null,
      materialCost:units>0&&rows.every(r=>r.inputValue!==null&&r.stringsValue!==null)?rows.reduce((n,r)=>n+(r.inputValue!+r.stringsValue!)*r.units,0):null,
      supplyCost:units>0?rows.reduce((n,r)=>n+r.cost,0):null,expectedLoss:units>0?0:null,
      seconds:units>0?rows.reduce((n,r)=>n+r.seconds+120,0):null,saleable:!!price&&now-price.at<HORIZON};
  }
  return result;
}
export function selectWork(s:any,m:EconomyMemory,now=Date.now()):WorkIntent|undefined {
  const memory=objectives(m),choices=workOpportunities(s,m,now);
  memory.needs=memory.needs.filter(n=>n.expires>now);
  // No level-99 check: only a safe bank/batch boundary permits a new job.
  const boundary=!s.shop?.isOpen&&!s.dialog?.isOpen&&!s.modalOpen&&Number(s.player?.animId??-1)<0
    &&!(s.inventory??[]).some((i:any)=>/^(.*logs|logs|.*ore|.*bar|.*arrowheads|.*dagger)$/i.test(i.name)||[48,50,54,56,58,60,66,68].includes(i.id));
  if(!memory.intent&&!boundary&&m.metal?.phase){
    const resume=choices.find(c=>c.intent.track==='metalworking'&&!c.blocked);
    if(resume){memory.intent={...resume.intent,reason:'Finish the pre-existing metal batch before comparing a new job'};memory.decision={at:now,chosen:memory.intent,reason:'Resume existing batch; no new production-rate sample'};return memory.intent;}
  }
  const current=choices.find(c=>c.intent.id===memory.intent?.id);
  // A blocked prerequisite yields to another feasible production objective.
  // Its cooldown remains in memory so later income or unlocks can revive it.
  if(memory.intent?.mode==='finish'&&m.bowmaking?.active&&!current?.blocked)return memory.intent;
  if(memory.intent&&!boundary&&(!current||!current.blocked))return memory.intent;
  const probe=boundary&&memory.completed-memory.lastProbe>=5;
  const trialCount=(id:string)=>(memory.trials?.[id]??0)+(memory.samples[id]?.length??0);
  const ordered=probe?[...choices].sort((a,b)=>trialCount(a.intent.id)-trialCount(b.intent.id)):choices;
  // Owner-requested initial unlock/finishing trial, bounded by eight bows and
  // persistent failure limits. It starts at a batch boundary, never at level 99.
  const firstFinish=boundary&&!m.bowmaking?.trialComplete?choices.find(c=>c.intent.mode==='finish'&&!c.blocked):undefined;
  const toolChoice=boundary?choices.find(c=>c.intent.id.startsWith('tool-chain:')&&!c.blocked):undefined;
  const chosen=firstFinish??toolChoice??chooseOpportunity(ordered,memory.intent,now,probe);
  if(probe)memory.lastProbe=memory.completed;
  if(probe&&chosen)(memory.trials??={})[chosen.intent.id]=(memory.trials?.[chosen.intent.id]??0)+1;
  if(chosen){
    if(memory.intent?.id!==chosen.intent.id){delete memory.cycle;delete m.harvest;delete m.processing;delete m.product;delete m.metal;}
    memory.intent={...chosen.intent};
    const rate=netProfitPerHour(chosen.economics);
    memory.intent.reason=chosen.intent.id.startsWith('tool-chain:')?chosen.intent.reason:
      chosen.usefulNeed?.verified&&chosen.usefulNeed.downstreamReady?'Supply '+chosen.usefulNeed.goal:
      rate!==null?`Estimated net ${Math.round(rate)} gp/hour from observed production and fresh prices; includes provisional sale travel allowance`:
      firstFinish?'Bounded Crafting unlock and finished-bow trial; compare measured net value afterward':probe?'Bounded alternative production trial; profitability is unknown':'Continue supported production while collecting price/throughput evidence; profitability is unknown';
    memory.decision={at:now,objective:'Grow sustainable net wealth; skills and tools are investments',chosen:memory.intent,estimatedNetGpHour:rate,
      alternatives:choices.map(c=>({id:c.intent.id,estimatedNetGpHour:netProfitPerHour(c.economics),blocked:c.blocked??null})),notAnInflationOrOptimalityClaim:true};
  }else {delete memory.intent;memory.decision={at:now,objective:'Grow sustainable net wealth',blocker:'No currently supported productive opportunity'};}
  if(memory.intent&&!memory.cycle)memory.cycle={id:memory.intent.id,started:now,produced:0,gathered:0,sold:false,expenses:0,loss:0,bankedInputs:false,
    incompleteStart:count(s.inventory??[],memory.intent.inputId)>0||count(s.inventory??[],memory.intent.outputId)>0};
  return memory.intent;
}
export function observeWork(before:any,after:any,a:Action,m:EconomyMemory,now=Date.now()){
  const memory=objectives(m),intent=memory.intent,cycle=memory.cycle;
  if(after.shop?.isOpen)for(const i of after.shop.playerItems??[]){
    if(!(i.sellPrice>0)||!Number.isFinite(i.sellPrice))continue;
    if(!/general/i.test(after.shop.name??after.shop.shopName??'')&&!after.shop.shopItems?.some((r:any)=>r.id===i.id))continue;
    memory.prices[i.id]={price:i.sellPrice,at:now,verifiedSale:false};
  }
  const cashChange=count(after.inventory??[],995)-count(before.inventory??[],995);
  if(a.type==='shopSell'){
    const item=before.inventory?.find((i:any)=>i.slot===a.fields?.slot),sold=item?count(before.inventory,item.id)-count(after.inventory??[],item.id):0;
    if(item&&sold>0&&cashChange>0)memory.prices[item.id]={price:cashChange/sold,at:now,verifiedSale:true};
  }
  if(!intent||!cycle)return;
  if(intent.mode==='finish')return; // Multi-input cycle accounting belongs to observeBow.
  if(before.player?.lifeId!==after.player?.lifeId||after.player?.isDead){delete memory.cycle;memory.blocked[intent.id]=now+10*60_000;return;}
  const delta=count(after.inventory??[],intent.outputId)-count(before.inventory??[],intent.outputId);
  if(!/^(bank|shop|useEquipment|useInventory|pickup|interactGround)/.test(a.type)){
    if(delta>0)cycle.produced+=delta;
    cycle.gathered+=Math.max(0,count(after.inventory??[],intent.inputId)-count(before.inventory??[],intent.inputId));
  }
  if(a.type==='shopBuy'&&cashChange<0)cycle.expenses-=cashChange;
  if(a.type==='bankWithdraw'&&count(after.inventory??[],intent.inputId)>cycle.gathered)cycle.bankedInputs=true;
  if(a.type==='shopSell'&&delta<0&&cashChange>0)cycle.sold=true;
  if(a.type==='closeModal'&&(before.bank?.isOpen&&!after.bank?.isOpen||before.shop?.isOpen&&!after.shop?.isOpen)&&cycle.produced>0){
    if(!cycle.incompleteStart&&!cycle.bankedInputs&&now>cycle.started){
      const rows=memory.samples[intent.id]??=[];rows.push({units:cycle.produced,seconds:(now-cycle.started)/1000,cost:cycle.expenses,loss:cycle.loss,sold:cycle.sold,at:now});memory.samples[intent.id]=rows.slice(-5);
    }
    memory.completed++;delete memory.cycle;
  }
}
