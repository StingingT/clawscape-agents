import { bankAt, foodCount, productionDialog, skillLevel, type Action, type EconomyMemory } from '../progression-policy';

// Exact 2004 object identities: unstrung and usable bows share display names.
// Evidence: content/pack/{obj,npc,loc}.pack, skill_crafting/spinning,
// skill_fletching/stringing, and maps m47_54, m48_53, m45_53.
export const BOWS=[
  {input:50,output:841,level:5,name:'Shortbow'}, {input:48,output:839,level:10,name:'Longbow'},
  {input:54,output:843,level:20,name:'Oak shortbow'}, {input:56,output:845,level:25,name:'Oak longbow'},
  {input:60,output:849,level:35,name:'Willow shortbow'}, {input:58,output:847,level:40,name:'Willow longbow'},
  {input:64,output:853,level:50,name:'Maple shortbow'}, {input:62,output:851,level:55,name:'Maple longbow'},
  {input:68,output:857,level:65,name:'Yew shortbow'}, {input:66,output:855,level:70,name:'Yew longbow'},
  {input:72,output:861,level:80,name:'Magic shortbow'}, {input:70,output:859,level:85,name:'Magic longbow'},
] as const;
export const BOW_SITES={sheep:{x:3051,z:3517,level:0},wheel:{x:3082,z:3430,level:0},flax:{x:2889,z:3424,level:0},shop:{x:3218,z:3415,level:0}};
type Phase='prepare'|'shear'|'wool'|'flax'|'spin'|'load'|'string'|'deposit'|'complete';
export type BowMemory={active?:boolean;trialComplete?:boolean;phase?:Phase;input?:number;output?:number;target?:number;made?:number;
  started?:number;completedAt?:number;life?:number;lastProgress?:number;failed?:number;reason?:string;cooldownUntil?:number;
  missing?:{key:string;tick:number;count:number}; inputValue?:number|null;stringsValue?:number|null;cost?:number;
  samples?:Record<number,{units:number;seconds:number;inputValue:number|null;stringsValue:number|null;cost:number;at:number}[]>;
  verified?:{wool:number;strings:number;bows:number};};
const total=(items:any[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+Number(i.count),0);
const at=(s:any,p:any)=>s.player.level===p.level&&Math.max(Math.abs(s.player.worldX-p.x),Math.abs(s.player.worldZ-p.z))===0;
const a=(id:string,type:string,fields:any={},waitTicks=2):Action=>({id:'economy-bow-'+id,type,fields,waitTicks});
const material=(id:number)=>[1737,1759,1779,1777].includes(id)||BOWS.some(b=>b.input===id);
export const bowReserve=(m:EconomyMemory):Record<number,number>=>m.bowmaking?.active&&m.bowmaking.input!==undefined?{[m.bowmaking.input]:Math.max(0,(m.bowmaking.target??8)-(m.bowmaking.made??0)),1777:Math.max(0,(m.bowmaking.target??8)-(m.bowmaking.made??0))}:{};
export function bowBlocked(m:EconomyMemory,reason:string,now=Date.now()) {
  const b=m.bowmaking??={};b.active=false;b.reason=reason;b.cooldownUntil=now+10*60_000;
  if(m.objectives?.intent?.mode==='finish')m.objectives.blocked[m.objectives.intent.id]=b.cooldownUntil;
  m.goal='bowmaking-blocked';m.reason=reason;
}
export function bowNext(s:any,m:EconomyMemory,blocked:(id:string)=>boolean=()=>false,now=Date.now(),foodTarget=0):Action[]{
  const intent=m.objectives?.intent;if(intent?.mode!=='finish')return [];
  const b=m.bowmaking??={},inv=s.inventory??[],bank=s.bank?.isOpen?s.bank.items??[]:m.bankItems??[];
  const count=(id:number)=>total(inv,id),all=(id:number)=>count(id)+total(bank,id),remaining=()=>Math.max(0,b.target!-b.made!);
  const close=()=>[a('close','closeModal',{},1)];
  const useBank=()=>bankAt(s,undefined,blocked,m.bankCooldowns??={});
  const fail=(reason:string)=>{bowBlocked(m,reason,now);return s.shop?.isOpen||s.bank?.isOpen?close():[a('deferred','wait',{},3)];};
  if((b.cooldownUntil??0)>now)return [a('cooldown','wait',{},5)];
  if(!b.active){
    const recipe=BOWS.find(r=>r.input===intent.inputId&&r.output===intent.outputId&&skillLevel(s,'fletching')>=r.level);
    if(!recipe||all(recipe.input)<=0)return fail('No usable unstrung stock; retain the finishing goal until inputs exist');
    const price=m.objectives!.prices[recipe.input],strings=m.objectives!.prices[1777];
    Object.assign(b,{active:true,phase:'prepare',input:recipe.input,output:recipe.output,target:Math.min(8,all(recipe.input)),made:0,started:now,lastProgress:now,life:s.player.lifeId,failed:0,cost:0,
      inputValue:price&&now-price.at<30*60_000?price.price:null,
      stringsValue:all(1777)>0?(strings&&now-strings.at<30*60_000?strings.price:null):0});
    delete m.processing;delete m.product;delete m.harvest;delete m.selling;
  }
  if(b.life!==s.player.lifeId||s.player.isDead)return fail('Life changed during bowmaking; reassess supplies before another trial');
  if(now-(b.lastProgress??now)>8*60_000)return fail('No verified bowmaking progress for eight minutes; defer this chain');
  m.goal='bowmaking-'+b.phase;
  m.reason=b.reason=`Crafting ${skillLevel(s,'crafting')}/10; finish ${b.made}/${b.target} ${intent.inputName} using flax bowstrings, not wool`;
  const needWool=skillLevel(s,'crafting')<10;
  const needsStrings=all(1777)<remaining();
  // Spinning opens the observed skill_multi2 interface. Select the material's
  // own Make-10 component from the current observation; never guess a
  // component id or send another OPLOCU while the interface is open.
  if((b.phase==='wool'||b.phase==='spin')&&s.interface?.isOpen){
    const label=b.phase==='wool'?'Wool':'Flax',option=productionDialog(s.interface.options??[],label);
    if(option?.componentId)return [a(b.phase==='wool'?'spin-wool':'spin-flax','clickComponent',{componentId:option.componentId},3)];
    return fail('Spinning interface did not expose the observed material and Make 10 option');
  }
  // A bank/shop is an actionable transaction even when the client exposes it
  // as a modal. Only dismiss an unknown modal: repeatedly waiting for an
  // interface that reports neither bank, shop, nor a spin panel cannot make
  // bowmaking progress.
  if(s.modalOpen&&!s.bank?.isOpen&&!s.shop?.isOpen&&!s.interface?.isOpen&&b.phase!=='complete')return [a('close-stalled-interface','closeModal',{},1)];
  const visit=(key:keyof typeof BOW_SITES)=>{
    const p=BOW_SITES[key];if(!at(s,p))return [a('route-'+key,'walkTo',p)];
    if(b.missing?.key!==key)b.missing={key,tick:s.tick,count:0};
    if(b.missing.tick!==s.tick){b.missing.tick=s.tick;b.missing.count++;}
    return b.missing.count>=3?fail('Reached '+key+' hint but no usable target was observed'):[a('inspect-'+key,'wait',{},4)];
  };
  if(s.bank?.isOpen){
    m.bankItems=bank;
    // Preserve tools/food. Deposit other material and old products first; once
    // loading starts, do not redeposit the ingredient just withdrawn.
    if(b.phase==='deposit'||b.phase==='prepare'){
      const row=inv.find((i:any)=>material(i.id)||i.id===b.output||/^(.*logs|logs|.*ore|.*bar|arrow shaft)$/i.test(i.name));
      // Never bank CoinCrafter's starter wieldable bow unless it is the actual
      // output of this batch and new bows have been made.
      if(row&&row.id!==b.input&&!(row.id===b.output&&b.made===0))return [a('deposit-material','bankDeposit',{slot:row.slot,amount:count(row.id)})];
      if(b.phase==='deposit'&&b.made!>=b.target!){b.phase='complete';return close();}
      b.phase='load';
    }
    const required=new Set(needWool&&needsStrings?[1737]:needsStrings?[1779,1777]:[b.input!,1777]);
    const clutter=inv.find((i:any)=>material(i.id)&&!required.has(i.id)||i.id===b.output&&b.made!>0);
    if(clutter)return [a('bank-spare-material','bankDeposit',{slot:clutter.slot,amount:count(clutter.id)})];
    // Two non-stackable ingredients per bow. Keep a compact travel kit, banking
    // spare tools rather than discarding them to make room for a paired batch.
    const spare=inv.find((i:any)=>[841,1351,1265,1438,946].includes(i.id)&&i.id!==b.input&&i.id!==b.output);
    if(spare)return [a('bank-spare-tool','bankDeposit',{slot:spare.slot,amount:count(spare.id)})];
    const reserve=count(995)>100?inv.find((i:any)=>i.id===995):undefined;
    if(reserve)return [a('secure-cash','bankDeposit',{slot:reserve.slot,amount:count(995)-100})];
    const money=bank.find((i:any)=>i.id===995);
    if(count(995)<10&&!count(1735)&&money)return [a('tool-cash','bankWithdraw',{slot:money.slot,amount:Math.min(10-count(995),money.count)})];
    const food=bank.find((i:any)=>/^(cabbage|shrimps|anchovies|trout|salmon|bread|lobster|swordfish)$/i.test(i.name));
    if(foodCount(s)<foodTarget&&food&&inv.length<28)return [a('withdraw-food','bankWithdraw',{slot:food.slot,amount:Math.min(foodTarget-foodCount(s),food.count,28-inv.length)})];
    const tool=bank.find((i:any)=>i.id===1735);
    if(needWool&&needsStrings&&!count(1735)&&tool&&inv.length<28)return [a('withdraw-shears','bankWithdraw',{slot:tool.slot,amount:1})];
    let desired:number|undefined,quantity=0;
    if(needWool&&needsStrings){desired=1737;quantity=8;}
    else if(needsStrings){desired=1779;quantity=remaining()-all(1777);}
    else if(count(1777)<remaining()){desired=1777;quantity=remaining();}
    else {desired=b.input;quantity=remaining();}
    const row=bank.find((i:any)=>i.id===desired);
    if(row&&quantity>count(desired!)&&inv.length<28)return [a('withdraw-input','bankWithdraw',{slot:row.slot,amount:Math.min(quantity-count(desired!),row.count,28-inv.length)})];
    b.phase=needWool&&needsStrings?(count(1737)>0?'wool':'shear'):count(1777)>=remaining()?(count(b.input!)>=remaining()?'string':'load'):count(1779)>0?'spin':'flax';
    return close();
  }
  if(s.shop?.isOpen){
    if(needWool&&needsStrings&&!count(1735)){
      const row=s.shop.shopItems?.find((i:any)=>i.id===1735&&i.count>0&&i.buyPrice>0&&i.buyPrice<=count(995)-5&&i.buyPrice<=10);
      if(row&&inv.length<28)return [a('buy-shears','shopBuy',{slot:row.slot,amount:1,itemId:row.id,expectedPrice:row.buyPrice})];
      return fail('No affordable shears in the observed general store; preserve cash and defer');
    }
    return close();
  }
  if(b.phase==='complete')return close(); // completion is committed only after the closing observation
  if(b.phase==='prepare'||b.phase==='deposit')return useBank();
  if(foodCount(s)<1)return fail('Bowmaking travel needs carried food; replenish supplies before retrying');
  if(Number(s.player.animId??-1)>=0)return [a('working','wait',{},3)];
  if(b.made!>=b.target!){b.phase='deposit';return useBank();}
  if(count(1777)>0&&count(b.input!)>0){
    b.phase='string';return [a('string','useItemOnItem',{sourceSlot:inv.find((i:any)=>i.id===1777).slot,targetSlot:inv.find((i:any)=>i.id===b.input).slot},3)];
  }
  if(!needsStrings){b.phase='load';return useBank();}
  if(needWool){
    if(count(1737)>0&&(count(1737)>=8||b.phase==='wool'||inv.length>=28))b.phase='wool';
    else b.phase='shear';
    if(b.phase==='shear'){
      if(!count(1735)){
        if(all(1735)||count(995)<6)return useBank();
        const npc=s.nearbyNpcs?.find((n:any)=>/^Shop keeper$|^Shop assistant$/i.test(n.name)&&n.reachable===true&&n.optionsWithIndex?.some((o:any)=>/^trade$/i.test(o.text)));
        if(npc)return [a('trade-tools','interactNpc',{npcIndex:npc.index,optionIndex:npc.optionsWithIndex.find((o:any)=>/^trade$/i.test(o.text)).opIndex})];
        return visit('shop');
      }
      if(inv.length>=28){b.phase='prepare';return useBank();}
      const sheep=s.nearbyNpcs?.filter((n:any)=>n.id===43&&n.reachable===true&&n.distance<=8&&n.x>=3043&&n.x<=3060&&n.z>=3507&&n.z<3520).sort((a:any,b:any)=>a.distance-b.distance)[0];
      if(!sheep)return visit('sheep');
      delete b.missing;return [a('shear','useItemOnNpc',{itemSlot:inv.find((i:any)=>i.id===1735).slot,npcIndex:sheep.index},3)];
    }
  }else b.phase=count(1779)>0?'spin':'flax';
  if(b.phase==='flax'){
    if(total(bank,1779)>0||total(bank,1777)>count(1777))return useBank();
    if(inv.length>=28){b.phase='prepare';return useBank();}
    const loc=s.nearbyLocs?.filter((l:any)=>l.id===2646&&l.reachable===true&&l.x>=2880&&l.x<=2895&&l.z>=3418&&l.z<=3444&&l.optionsWithIndex?.some((o:any)=>/^pick$/i.test(o.text))).sort((a:any,b:any)=>a.distance-b.distance)[0];
    if(!loc)return visit('flax');
    delete b.missing;return [a('pick-flax','interactLoc',{locId:loc.id,x:loc.x,z:loc.z,optionIndex:loc.optionsWithIndex.find((o:any)=>/^pick$/i.test(o.text)).opIndex},3)];
  }
  // Gather a whole bounded flax batch before the trip back to the wheel.
  if(b.phase==='spin'&&count(1779)+count(1777)<remaining()&&inv.length<28&&Math.abs(s.player.worldX-BOW_SITES.flax.x)<15){
    const loc=s.nearbyLocs?.find((l:any)=>l.id===2646&&l.reachable===true&&l.optionsWithIndex?.some((o:any)=>/^pick$/i.test(o.text)));
    if(loc)return [a('pick-flax','interactLoc',{locId:loc.id,x:loc.x,z:loc.z,optionIndex:loc.optionsWithIndex.find((o:any)=>/^pick$/i.test(o.text)).opIndex},3)];
    return [a('flax-respawn','wait',{},5)];
  }
  const input=b.phase==='wool'?1737:1779,row=inv.find((i:any)=>i.id===input);
  if(!row){b.phase='prepare';return useBank();}
  // Ground-floor wheel: no invented staircase option or Crafting Guild gate.
  const wheel=s.nearbyLocs?.find((l:any)=>l.id===2644&&l.x===3081&&l.z===3430&&l.reachable===true&&l.optionsWithIndex?.some((o:any)=>/^spin$/i.test(o.text)));
  if(!wheel||!at(s,BOW_SITES.wheel))return visit('wheel');
  delete b.missing;return [a(input===1737?'open-spin-wool':'open-spin-flax','useItemOnLoc',{itemSlot:row.slot,locId:wheel.id,x:wheel.x,z:wheel.z},3)];
}

export function validateBow(s:any,a:Action,before:any):boolean {
  if(!a.id.startsWith('economy-bow-'))return true;
  const f=a.fields??{},inv=s.inventory??[];
  const same=(slot:number)=>inv.find((i:any)=>i.slot===slot)?.id===before.inventory?.find((i:any)=>i.slot===slot)?.id;
  if(a.type==='useItemOnNpc')return same(f.itemSlot)&&inv.some((i:any)=>i.slot===f.itemSlot&&i.id===1735)&&s.nearbyNpcs?.some((n:any)=>n.index===f.npcIndex&&n.id===43&&n.reachable===true&&n.distance<=8&&n.z<3520);
  if(a.type==='useItemOnItem')return same(f.sourceSlot)&&same(f.targetSlot)&&inv.some((i:any)=>i.slot===f.sourceSlot&&i.id===1777)&&BOWS.some(r=>r.input===inv.find((i:any)=>i.slot===f.targetSlot)?.id&&skillLevel(s,'fletching')>=r.level);
  if(a.type==='clickComponent')return s.interface?.isOpen===true&&before.interface?.options?.some((o:any)=>o.componentId===f.componentId&&/^make 10/i.test(o.text));
  if(a.type==='useItemOnLoc')return same(f.itemSlot)&&inv.some((i:any)=>i.slot===f.itemSlot&&(i.id===1737||i.id===1779&&skillLevel(s,'crafting')>=10))&&s.player.level===0&&s.nearbyLocs?.some((l:any)=>l.id===2644&&l.x===f.x&&l.z===f.z&&l.reachable===true);
  if(a.type==='interactLoc')return s.player.level===0&&s.nearbyLocs?.some((l:any)=>l.id===f.locId&&l.x===f.x&&l.z===f.z&&l.reachable===true&&l.optionsWithIndex?.some((o:any)=>o.opIndex===f.optionIndex&&/^pick$/i.test(o.text)));
  if(a.type==='interactNpc')return s.nearbyNpcs?.some((n:any)=>n.index===f.npcIndex&&n.id===before.nearbyNpcs?.find((n:any)=>n.index===f.npcIndex)?.id&&n.reachable===true&&n.optionsWithIndex?.some((o:any)=>o.opIndex===f.optionIndex&&/^trade$/i.test(o.text)));
  if(a.type==='shopBuy')return s.shop?.isOpen===true&&s.shop.shopItems?.some((i:any)=>i.id===1735&&i.slot===f.slot&&i.count>0&&i.buyPrice===f.expectedPrice)&&total(inv,995)>=f.expectedPrice+5;
  if(/^bank(Withdraw|Deposit)$/.test(a.type)){
    const old=a.type==='bankWithdraw'?before.bank?.items:before.inventory,live=a.type==='bankWithdraw'?s.bank?.items:inv;
    const id=old?.find((i:any)=>i.slot===f.slot)?.id;
    return s.bank?.isOpen===true&&id!==undefined&&live?.some((i:any)=>i.slot===f.slot&&i.id===id)&&total(live??[],id)>=f.amount;
  }
  return true;
}
export function observeBow(before:any,after:any,a:Action,m:EconomyMemory,now=Date.now()){
  const b=m.bowmaking;if(!b?.active)return;
  if(before.player.lifeId!==after.player.lifeId||after.player.isDead){bowBlocked(m,'Life changed during bowmaking',now);return;}
  const inv=before.inventory??[],next=after.inventory??[],change=(id:number)=>total(next,id)-total(inv,id);
  b.verified??={wool:0,strings:0,bows:0};
  const key=a.id==='economy-bow-spin-wool'?'wool':a.id==='economy-bow-spin-flax'?'strings':a.id==='economy-bow-string'?'bows':undefined;
  const input=key==='wool'?1737:key==='strings'?1779:b.input!,output=key==='wool'?1759:key==='strings'?1777:b.output!;
  const made=key&&change(input)<0&&change(output)>0&&(key!=='bows'||change(1777)<0)?Math.min(-change(input),change(output)):0;
  if(made&&key){b.verified[key]+=made;if(key==='bows')b.made=(b.made??0)+made;b.lastProgress=now;b.failed=0;}
  else if(key){b.failed=(b.failed??0)+1;if(b.failed>=2)bowBlocked(m,'Repeated '+key+' action produced no verified input/output change',now);}
  if(a.id==='economy-bow-shear'&&change(1737)>0||a.id==='economy-bow-pick-flax'&&change(1779)>0||/^bank(Deposit|Withdraw)$/.test(a.type)&&JSON.stringify(inv)!==JSON.stringify(next)){b.lastProgress=now;b.failed=0;}
  if(a.id==='economy-bow-buy-shears'&&change(1735)>0&&change(995)<0){b.cost=(b.cost??0)-change(995);b.lastProgress=now;}
  if(a.type==='closeModal'&&before.bank?.isOpen&&!after.bank?.isOpen&&b.phase==='complete'){
    b.active=false;b.trialComplete=true;b.completedAt=now;
    const rows=(b.samples??={})[b.output!]??=[];
    rows.push({units:b.made!,seconds:(now-b.started!)/1000,inputValue:b.inputValue??null,stringsValue:b.stringsValue??null,cost:b.cost??0,at:now});
    b.samples[b.output!]=rows.slice(-5);m.reason='Verified finished-bow batch banked; compare net value before the next job';
    if(m.objectives){delete m.objectives.intent;delete m.objectives.cycle;m.objectives.completed++;}
  }
}
