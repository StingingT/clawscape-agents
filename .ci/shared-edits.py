# Version-checked static source edits. Not executed by the game controllers.
FILES = [
  {"path":'src/agent.ts',"before":'6782c1793fead8c1981cc583b89958f6d8535c3d',"after":'6bf263edfdcff7833d5031113f1617d821daf1fe',"edits":[
    {"start":20,"end":21,"text":r""""""},
    {"start":44,"end":45,"text":r"""import { LiveAgency, isSelection, type Selection, type Verification } from './agency/live-adapter.ts';
import type { Task, TaskKind, Route } from './agency/world-model.ts';
import { randomUUID } from 'node:crypto';
"""},
    {"start":97,"end":100,"text":r"""// Public forum posting is optional. Quiet local learning is the default.
const forumEnabled = process.argv.includes('--forum') && !process.argv.includes('--no-social');
"""},
    {"start":694,"end":695,"text":r""""""},
    {"start":958,"end":959,"text":r"""  const tripFood = agency?.policy.foodTarget ?? (character==='clawscout'?Math.max(3,learnedFoodReserve(foodMemory)):learnedFoodReserve(foodMemory));
"""},
    {"start":1068,"end":1069,"text":r"""  if ((state.inventory?.length ?? 0) >= 28) return [];
"""},
    {"start":1331,"end":1332,"text":r"""function gearCandidates(state: GameState, selectedSkill?: string): Candidate[] {
"""},
    {"start":1397,"end":1398,"text":r"""  const desiredSkill = selectedSkill ?? (build === "ranged-magic" ? "ranged" : meleeTrainingSkill(attackLevel, strengthLevel));
"""},
    {"start":1401,"end":1402,"text":r"""    const forbidden = selectedSkill ? ['prayer'] : build === 'ranged-magic' ? ['defence', 'prayer', 'attack', 'strength'] : ['defence', 'prayer'];
"""},
    {"start":1446,"end":1447,"text":r"""function productionCandidates(state: GameState, requestedFood = false): Candidate[] {
"""},
    {"start":1455,"end":1456,"text":r"""  if (!requestedFood && role === 'economy' && !economyNeedsFood(state)) return [];
"""},
    {"start":1458,"end":1459,"text":r"""  const requiredFood = agency?.policy.foodTarget ?? (character==='clawscout'?Math.max(3,learnedFoodReserve(foodMemory)):learnedFoodReserve(foodMemory));
"""},
    {"start":2144,"end":2175,"text":r"""/** Task-specific executors are asked for actions only AFTER the Director chooses a goal. */
async function actionsForTask(state: GameState, task: Task): Promise<Candidate[]> {
  if (state.player?.isDead === true) return [];
  if (state.player?.combat?.inCombat === true) return [{id:'continue-combat',type:'wait',waitTicks:2}];
  if (state.modalOpen === true && state.inventory?.length === 0) return [{id:'accept-design',type:'acceptCharacterDesign',waitTicks:2}];
  if (state.dialog?.isOpen === true) {
    if(task.kind==='production'&&work.economy){
      const metal=metalDialog(state,work.economy);if(metal)return [metal];
      const product=work.economy.product&&productionDialog(state.dialog.options??[],work.economy.product);
      if(product&&Number.isInteger(product.index))return [{id:'select-planned-product',type:'clickDialogOption',fields:{optionIndex:product.index},waitTicks:4}];
    }
    return dialogCandidates(state);
  }
  if ((state.inventory?.length ?? 0) === 0) {
    const guide=(state.nearbyNpcs??[]).find(n=>/runescape guide|tutorial guide/i.test(String(n.name))&&n.reachable===true);
    if(guide)return [{id:'tutorial-guide',type:'talkToNpc',fields:{npcIndex:guide.index},waitTicks:3}];
  }
  if (state.bank?.isOpen === true) { const transaction=bankingCandidates(state);return transaction.length?transaction:[{id:'close-bank',type:'closeModal',waitTicks:1}]; }
  switch(task.kind) {
    case 'food': return productionCandidates(state,true);
    case 'ammunition': return [...quiverRefill(state), ...ammoCandidates(state), ...arrowProductionCandidates(state), ...safeAmmoSupplyCandidates(state)];
    case 'bank': return bankingCandidates(state);
    case 'equipment': return gearCandidates(state);
    case 'combat': {
      if(!state.combatStyle?.styles?.some((s:any)=>s.trainsSkills?.some((k:string)=>k.toLowerCase()===task.skill)))return [];
      const gear=gearCandidates(state,task.skill);
      if(gear.length)return gear;
      return training ? training.next(state,(from,to)=>navigator!.assess(from,to)) : [];
    }
    case 'production': {
      work.economy ??= {bankItems:work.bankItems??[]};
      selectWork(state,work.economy);
      const result=economyNext(state,work.economy,id=>!actionReady(work.failures[id]));
      saveWork(); return result;
    }
    case 'gathering': return [...economyCandidates(state),...localEconomyDiscovery(state)];
    case 'exploration': {
      if(!task.route)return [];
      const route=await navigator!.assess(position(state),task.route);
      if(route.status==='loading-map')return [{id:'observe-map-load',type:'wait',waitTicks:2}];
      if(route.status!=='ready')return [];
      return [{id:task.id,type:'walkTo',fields:{...task.route,running:true,reason:task.route.evidence},waitTicks:2}];
"""},
    {"start":2177,"end":2203,"text":r"""}

function urgentAgencyAction(state:GameState):Candidate|undefined {
  const heal=foodCandidates(state)[0];
  if(heal) return state.bank?.isOpen||state.shop?.isOpen||state.dialog?.isOpen
    ? {id:'close-interface-to-heal',type:'closeModal',waitTicks:1}:heal;
  if(state.player?.combat?.targetType==='player' || combatDisposition(state,false,build==='ranged-magic')==='recover')
    return {id:'emergency-retreat',type:'retreat',waitTicks:2};
}
function verification(value:ReturnType<typeof verifyActionOutcome>):Verification {
  return {status:value.verified?'verified':value.uncertain?'unknown':'rejected',evidence:value.evidence,reason:value.reason};
}
async function executeAgencyAction(state:GameState,action:Candidate):Promise<{next:GameState;result:Json}> {
  if(action.type==='walkTo'||action.type==='retreat') {
    const trip=action.type==='retreat'?await navigator!.escape(state):await navigator!.step({x:Number(action.fields?.x),z:Number(action.fields?.z),level:Number(action.fields?.level??0)},state);
    const next=trip.state.tick===state.tick?stateFrom(await cliCall(['wait','2'])):trip.state;
    return {next,result:{navigation:trip.navigation}};
  }
  if(action.type==='wait') {
    const result=await cliCall(['wait',String(action.waitTicks)]);return {next:stateFrom(result),result};
  }
  const fields:Json={...action.fields,reason:action.fields?.reason??action.id};
  for(const key of ['trainingSite','goalMethod','defensiveGoal','expectedItemId','evidence','id'])delete fields[key];
  if(action.type==='shopBuy'||action.type==='shopSell'){delete fields.itemId;delete fields.expectedPrice;}
  const type=action.type==='closeModal'&&state.shop?.isOpen?'closeShop':action.type;
  const result=await cliCall(['act',type,'--json',JSON.stringify(fields)]);
  return {next:stateFrom(await cliCall(['wait',String(action.waitTicks)])),result};
}
function observeAgencyResult(before:GameState,after:GameState,action:Candidate):void {
  work.learning??={};work.learning.food??={};
  recordFoodExperience(work.learning.food,before,after,action.id);
  recordObservedDrops(work.learning,before,after,action.id);
  training?.afterAction(before,after,action);
  if(action.fields?.defensiveGoal)defensiveGoals.after(before,after,action);
  else equipmentGoals.after(before,after,action);
  if(work.economy){observeWork(before,after,action,work.economy);observeBow(before,after,action,work.economy);}
  if(after.bank?.isOpen===true)work.bankItems=after.bank.items as Json[];
  if(before.bank?.isOpen===true && after.bank?.isOpen===false){delete work.foodWithdrawalPending;if(work.foodBatch?.phase==='bank')delete work.foodBatch;}
  delete work.failures[action.id];saveWork();
}

async function runEpisode(): Promise<void> {
  if(!agency)throw new Error('AGENCY_NOT_INITIALIZED');
  await cliCall(['connect']);
  let state=stateFrom(await cliCall(['state']));
  // The legacy ledger is never converted to "failed" merely to permit another mutation.
  const legacy=loadActionIntent(actionIntentPath);
  if(legacy && ['pending','outcome-unknown'].includes(legacy.status)) {
    const check=legacy.beforeState?verifyActionOutcome(legacy.beforeState,state,legacy):undefined;
    if(!check?.verified)throw new Error('LEGACY_ACTION_RECONCILIATION_REQUIRED:'+legacy.commandId);
    finishActionIntent(actionIntentPath,legacy,'verified',check.evidence);
  }
  for(let step=0;step<steps;step++) {
    state=stateFrom(await cliCall(['state']));
    training?.observe(state);
    const safetyPending=agency.pending('safety');
    if(safetyPending) {
      const check=verifyActionOutcome(safetyPending.before,state,safetyPending.action);
      agency.record(safetyPending.commandId,state,verification(check));
      if(agency.pending('safety')){await cliCall(['wait','2']);continue;}
    }
    // Safety can preempt a goal but cannot overwrite its pending action or choose ordinary work.
    const emergency=urgentAgencyAction(state);
    if(emergency) {
      const commandId=agency.beginSafety(emergency,state,randomUUID());
      try {
        const {next,result}=await executeAgencyAction(state,emergency);
        agency.record(commandId,next,verification(verifyActionOutcome(state,next,emergency,result)));
        state=next;
      } catch(error) {
        agency.record(commandId,state,{status:'unknown',evidence:[],reason:String(error)});
"""},
    {"start":2204,"end":2213,"text":r""""""},
    {"start":2215,"end":2227,"text":r"""    const pending=agency.pending();
    if(pending) {
      const check=verifyActionOutcome(pending.before,state,pending.action);
      agency.record(pending.commandId,state,verification(check));
      if(agency.pending()) {
        console.log(JSON.stringify({agency:'reconciling',commandId:pending.commandId,reason:check.reason}));
        await cliCall(['wait','2']);continue;
      }
      if(check.verified)observeAgencyResult(pending.before,state,pending.action as Candidate);
"""},
    {"start":2228,"end":2273,"text":r"""    // No legacy action candidates or synthetic per-click goals are constructed before this selection.
    const planned=agency.plan(state);
    if(!isSelection(planned)) {
      console.log(JSON.stringify({agency:planned.type,detail:planned,goal:agency.summary().goal}));
      await cliCall(['wait','3']);continue;
"""},
    {"start":2274,"end":2318,"text":r"""    const options=available(await actionsForTask(state,planned.task));
    if(!options.length){agency.blocked('Selected task has no feasible current executor step: '+planned.task.id);continue;}
    const action=choose(stateKey(state),options);
    // One-item purchases use the current quoted price; no unbounded bulk purchase estimate.
    if(action.type==='shopBuy')action.fields={...action.fields,amount:1};
    const fresh=stateFrom(await cliCall(['state']));
    if(urgentAgencyAction(fresh)){state=fresh;continue;}
    if(action.fields?.trainingSite&&!training?.validateAction(fresh,action)){state=fresh;continue;}
    if(action.id.startsWith('goal-')&&!equipmentGoals.validate(fresh,action)){state=fresh;continue;}
    if(!validateMetal(fresh,action,state)||!validateBow(fresh,action,state)||!validateFishing(fresh,action,state)){state=fresh;continue;}
    state=fresh;
    const commandId=randomUUID();
    try { agency.begin(planned,action,state,commandId); }
    catch(error) { if(!agency.pending())agency.blocked('Pre-dispatch validation refused '+action.id+': '+String(error));else throw error;continue; }
    training?.beforeAction(state,action);
"""},
    {"start":2319,"end":2477,"text":r"""      const {next,result}=await executeAgencyAction(state,action);
      const check=verifyActionOutcome(state,next,action,result);
      agency.record(commandId,next,verification(check));
      if(check.verified)observeAgencyResult(state,next,action);
      appendFileSync(experiencePath,JSON.stringify({at:new Date().toISOString(),commandId,goal:planned.decision.goal.id,
        method:planned.method.id,action,outcome:verification(check)})+'\n');
      console.log(JSON.stringify({agency:'step',commandId,goal:agency.summary().goal,outcome:verification(check)}));
      state=next;
    } catch(error) {
      // A transport exception does not prove the server rejected the command.
      agency.record(commandId,state,{status:'unknown',evidence:[],reason:String(error)});
      console.error(JSON.stringify({agency:'outcome-unknown',commandId,error:String(error).slice(0,240)}));
"""},
    {"start":2479,"end":2481,"text":r"""  // Optional public conversation is explicitly enabled, quiet by default, and independent of goal ownership.
  if(forumEnabled&&!agency.pending()&&!agency.pending('safety')&&!urgentAgencyAction(state)){try{await syncForum(state);}catch(error){console.error(JSON.stringify({forum:'deferred',error:String(error).slice(0,160)}));}}
"""},
    {"start":2485,"end":2485,"text":r"""  try {
"""},
    {"start":2487,"end":2488,"text":r"""    training = new TrainingDiscovery(resolve(dataDir, 'training-knowledge.json'), character, loadCatalog(), build === 'ranged-magic', false);
"""},
    {"start":2489,"end":2490,"text":r"""  const oldAgencyPath=resolve(dataDir,'agency-memory.json');
  if(existsSync(oldAgencyPath)&&JSON.parse(readFileSync(oldAgencyPath,'utf8')).pending)
    throw new Error('LEGACY_AGENCY_INTENT_REQUIRES_RECONCILIATION');
  const policyPath=resolve(dataDir,'agency-policy.json');
  const policy=existsSync(policyPath)?JSON.parse(readFileSync(policyPath,'utf8')):{};
  agency = new LiveAgency(resolve(dataDir,'agency-v2.json'), {agent:character,world:process.env.CLAWSCAPE_SERVER??'clawscape',revision:gearCatalog.namespace}, {
    policy:{foodTarget:Math.max(3,learnedFoodReserve(work.learning?.food)),...policy},
    supported:['food','ammunition','equipment','bank','combat','production','gathering','exploration'],
    preferences:role==='economy'?{crafting:2,gathering:1}:role==='resource'?{gathering:2}:{combat:2},
    routes:Object.entries(WORLD_ROUTES).map(([id,p])=>({id,...p,level:0,evidence:'bundled route lead; arrival not yet personally verified'})),
  });
"""},
    {"start":2495,"end":2496,"text":r""""""},
    {"start":2508,"end":2509,"text":r"""  } finally { navigator?.close(); peerMarket?.close(); releaseController(); }
"""},
  ]},
]
