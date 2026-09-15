from pathlib import Path


def rep(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    s = p.read_text()
    actual = s.count(old)
    assert actual == count, (path, "expected", count, "found", actual, old[:120])
    p.write_text(s.replace(old, new, count))


# 1) Director: executor-level dead ends can replan without erasing a strategic parent support chain.
rep(
    "src/agency/director.ts",
    """  /** Refresh the food dependency, not the strategic objective or a pending receipt. */
  reviseFoodNeed(target:number,at:number):void {""",
    """  /** An executor can prove that the selected method has no current action even though planning was feasible.
   * Support/investigation dead ends preserve the strategic parent; a direct goal is reviewed as partial
   * and receives the normal bounded cooldown before it can compete again. */
  deferActive(at:number,reason:string,evidence:string[]=[]):void {
    if(this.memory.pending)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    const goal=this.memory.active;if(!goal)return;
    this.blocked(at,reason,evidence);
    if(goal.requestedSupport){delete goal.requestedSupport;delete goal.plan;return;}
    if(goal.investigation){delete goal.investigation;delete goal.plan;return;}
    this.review(at,'partial',reason,evidence);
  }

  /** Refresh the food dependency, not the strategic objective or a pending receipt. */
  reviseFoodNeed(target:number,at:number):void {""",
)

# 2) LiveAgency wrapper shared by standard agents and Astra.
rep(
    "src/agency/live-adapter.ts",
    """  blocked(reason:string):void {
    this.director.blocked(this.clock(),reason);this.document.blocked=reason;this.save();
  }
""",
    """  deferCurrent(state:LiveState,reason:string):void {
    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    this.director.deferActive(this.clock(),reason,[`own-executor-dead-end:${state.tick??'unknown'}`]);
    delete this.document.route;this.document.blocked=reason;this.save();
  }
  blocked(reason:string):void {
    this.director.blocked(this.clock(),reason);this.document.blocked=reason;this.save();
  }
""",
)

# 3) Shared catalogue can select a personally known owned equipment upgrade.
rep(
    "src/agency/world-model.ts",
    """    'xp:production': ['smithing','fletching','crafting'].reduce((n,k) => n + XP(state,k), 0),
    'xp:gathering': ['woodcutting','mining','fishing'].reduce((n,k) => n + XP(state,k), 0) };""",
    """    'gear-ready': state.gearUpgradeAvailable===true ? 0 : 1,
    'xp:production': ['smithing','fletching','crafting'].reduce((n,k) => n + XP(state,k), 0),
    'xp:gathering': ['woodcutting','mining','fishing'].reduce((n,k) => n + XP(state,k), 0) };""",
)
rep(
    "src/agency/world-model.ts",
    """      priority: ['food','ammunition','equipment','bank','funds'].includes(task.kind) ? 'maintenance' : 'strategic' });""",
    """      priority: ['food','ammunition','bank','funds'].includes(task.kind) ? 'maintenance' : 'strategic' });""",
)
rep(
    "src/agency/world-model.ts",
    """  add({id:'equip-usable-weapon',kind:'equipment'},'combat','weapon',1,1,
    'Equip a personally owned usable weapon before attempting combat.', 'need');
""",
    """  add({id:'equip-usable-weapon',kind:'equipment'},'combat','weapon',1,1,
    'Equip a personally owned usable weapon before attempting combat.', 'need');
  if(state.gearUpgradeAvailable===true) add({id:'equip-owned-upgrade',kind:'equipment'},'combat','gear-ready',1,1,
    'Use a personally observed owned equipment upgrade when it improves the current kit; do not invent an item, slot, price or source.', 'need');
""",
)

# 4) Standard controller: discover gear from current inventory/equipment and recently verified bank contents.
p = Path("src/agent.ts")
s = p.read_text()
old = """const work: { foodBatch?: FoodBatch; fishing?: FishingPreparation; economy?: EconomyMemory; resource?: { goal?: string; site?: string; lastBankAt?: number }; autonomy?: AutonomyMemory; learning?: Json & { food?: FoodExperience }; appearance?: AppearanceMemory; foodWithdrawalPending?: boolean | 'raw'; fishingToolFundingUntil?: number; fishingToolTradeAttempted?: boolean; pickpocketStreak?: number; bankReturn?: { x: number; z: number; level: number }; bankReturnReady?: boolean; bankItems?: Json[]; failures: Record<string, { until: number; count: number }> } = (() => {"""
new = """const work: { foodBatch?: FoodBatch; fishing?: FishingPreparation; economy?: EconomyMemory; resource?: { goal?: string; site?: string; lastBankAt?: number }; autonomy?: AutonomyMemory; learning?: Json & { food?: FoodExperience }; appearance?: AppearanceMemory; foodWithdrawalPending?: boolean | 'raw'; fishingToolFundingUntil?: number; fishingToolTradeAttempted?: boolean; pickpocketStreak?: number; bankReturn?: { x: number; z: number; level: number }; bankReturnReady?: boolean; bankItems?: Json[]; productionNoStep?: {key:string;count:number;at:number}; failures: Record<string, { until: number; count: number }> } = (() => {"""
assert old in s
s = s.replace(old, new, 1)
marker = """const defensiveGoals = new EquipmentGoals(resolve(dataDir,'defensive-equipment-goals.json'),gearCatalog,'defender',false);
defensiveGoals.seedBank(work.economy?.bankItems ?? work.bankItems ?? []);
"""
helper = marker + """
function gearLossRisk(state:GameState):boolean {
  const combat=state.player?.combat as Json|undefined;
  const danger=(state as any).danger;
  return combat?.targetType==='player'||danger?.pvp===true||danger?.playerThreat===true;
}
function refreshGearSignal(state:GameState):void {
  if(gearLossRisk(state)){(state as any).gearUpgradeAvailable=false;return;}
  const recentBank=Date.now()-Number(equipmentGoals.memory.bankCheckedAt??0)<=30*60_000?equipmentGoals.memory.bank:[];
  const bank=state.bank?.isOpen===true&&Array.isArray(state.bank.items)?state.bank.items:recentBank;
  const owned=[...(state.inventory??[]),...(state.equipment??[]),...(bank??[])];
  const equipped=state.equipment??[];
  const families=build==='ranged-magic'?['bow','legs','hands']:
    role==='economy'?['melee','axe','pickaxe']:['melee','shield','body'];
  const current=(family:string)=>Math.max(0,...gearCatalog.items.filter(g=>g.family===family&&usable(g,state)&&
    (g.tool?[...(state.inventory??[]),...equipped]:equipped).some((i:any)=>i.id===g.id)).map(g=>g.quality));
  const best=(family:string)=>Math.max(0,...gearCatalog.items.filter(g=>g.family===family&&usable(g,state)&&owned.some((i:any)=>i.id===g.id)).map(g=>g.quality));
  (state as any).gearUpgradeAvailable=families.some(f=>best(f)>current(f));
}
function noteProductionNoStep(task:Task):boolean {
  work.economy??={bankItems:work.bankItems??[]};
  const memory=objectives(work.economy),now=Date.now(),intent=memory.intent?.id??'none';
  const key=`${task.id}:${intent}`;
  const previous=work.productionNoStep;
  const count=previous?.key===key&&now-previous.at<=60_000?previous.count+1:1;
  work.productionNoStep={key,count,at:now};
  if(count<3){saveWork();return false;}
  if(memory.intent){memory.blocked[memory.intent.id]=now+5*60_000;delete memory.intent;delete memory.cycle;}
  delete work.productionNoStep;saveWork();return true;
}
"""
assert marker in s
s = s.replace(marker, helper, 1)
old = """    case 'equipment': return gearCandidates(state);"""
new = """    case 'equipment': {
      if(gearLossRisk(state))return [];
      const immediate=gearCandidates(state);if(immediate.length)return immediate;
      const next=await equipmentGoals.next(state,(from,to)=>navigator!.assess(from,to));
      return next?[next as Candidate]:[];
    }"""
assert old in s
s = s.replace(old, new, 1)
old = """      const result=economyNext(state,work.economy,id=>!actionReady(work.failures[id]));
      saveWork(); return result;"""
new = """      const result=economyNext(state,work.economy,id=>!actionReady(work.failures[id]));
      if(result.length)delete work.productionNoStep;
      saveWork(); return result;"""
assert old in s
s = s.replace(old, new, 1)
old = """    state=stateFrom(await cliCall(['state']));
    training?.observe(state);
    agency.catalogue(state);"""
new = """    state=stateFrom(await cliCall(['state']));
    refreshGearSignal(state);
    training?.observe(state);
    agency.catalogue(state);"""
assert old in s
s = s.replace(old, new, 1)
old = """      if(planned.task.kind==='exploration'&&planned.task.route){
        agency.deferSurvey(planned.task.route,state,'Selected survey has no feasible current executor step from the current context.');
      } else if(!agency.summary().blocked && !agency.summary().acquisition?.need) agency.blocked('Selected task has no feasible current executor step: '+planned.task.id);
      await cliCall(['wait','2']);continue;"""
new = """      if(planned.task.kind==='exploration'&&planned.task.route){
        agency.deferSurvey(planned.task.route,state,'Selected survey has no feasible current executor step from the current context.');
      } else if(planned.task.kind==='production') {
        if(noteProductionNoStep(planned.task))agency.deferCurrent(state,'Production executor produced no actionable step after three fresh attempts; preserve evidence, cool down this method, and replan.');
      } else if(!agency.summary().blocked && !agency.summary().acquisition?.need) agency.blocked('Selected task has no feasible current executor step: '+planned.task.id);
      await cliCall(['wait','2']);continue;"""
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# 5) Astra: replan a direct blocked goal after its bounded recheck, and let combat compete with exploration.
p = Path("agents/advanced/src/live-cli.ts")
s = p.read_text()
old = """        supported:['food','bank','equipment','combat','exploration'],preferences:{exploration:2,combat:1},"""
new = """        supported:['food','bank','equipment','combat','exploration'],preferences:{exploration:-1,combat:2},"""
assert old in s
s = s.replace(old, new, 1)
old = """          const selection=agency.plan(agencyState(latest));
          if(!isSelection(selection)){publish('BLOCKED',selection.type==='blocked'?selection.reason:'Reconciliation required');await sleep(700);continue;}
          planned=selection;
          decision=policy.next(latest,planned.task);"""
new = """          const selection=agency.plan(agencyState(latest));
          if(!isSelection(selection)){
            const summary:any=agency.summary(),goal:any=summary.goal;
            if(selection.type==='blocked'&&goal?.blocker?.recheckAt&&Date.now()>=goal.blocker.recheckAt&&!agency.pending()&&!agency.pending('safety')){
              agency.deferCurrent(agencyState(latest),'Blocked objective exhausted its bounded recheck without an executable method; temporarily retire it and select another supported goal.');
              publish('REPLANNING','Blocked goal cooled down; selecting another supported objective.');await sleep(350);continue;
            }
            publish('BLOCKED',selection.type==='blocked'?selection.reason:'Reconciliation required');await sleep(700);continue;
          }
          planned=selection;
          decision=policy.next(latest,planned.task);"""
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)

# 6) Tests: Director deferral.
p = Path("tests/agency/director.test.ts")
s = p.read_text()
s += """

test('executor dead end retires a direct goal for bounded replanning',()=>{
  const d=new Director(createMemory(identity));
  const v=view({x:0},{capabilities:['exploration']});
  const g=goal({id:'survey:test',domain:'exploration',target:{fact:'x',minimum:1},source:'frontier'});
  const m=method({id:'survey:test',capability:'exploration',domain:'exploration',effects:{x:1}});
  const first=d.next(v,[g],[m]);assert.equal(first.type,'execute');
  d.deferActive(1100,'no executor',['own']);
  assert.equal(d.memory.active,undefined);assert.equal(d.memory.reviews.at(-1)?.result,'partial');
});
"""
p.write_text(s)

# New shared catalogue test file.
Path("tests/agency/gear-readiness.test.ts").write_text("""import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogue, emptyKnowledge, defaultPolicy } from '../../src/agency/world-model.ts';
import { createMemory } from '../../src/agency/director.ts';

test('personally known owned gear upgrade becomes an equipment opportunity',()=>{
  const identity={agent:'a',world:'w',revision:'r'};
  const state:any={gearUpgradeAvailable:true,capacity:28,player:{hp:10,worldX:0,worldZ:0,level:0,lifeId:1},inventory:[],equipment:[{id:1,name:'Bronze sword',count:1}],skills:[],combatStyle:{styles:[]}};
  const c=buildCatalogue(identity,state,emptyKnowledge(),defaultPolicy,['equipment'],createMemory(identity),1000);
  assert.equal(c.opportunities.some(o=>o.id==='equip-owned-upgrade'),true);
});
""")

# Astra combat task must emit an actual attack intent for a safe observed target.
p = Path("agents/advanced/tests/agency-policy.test.ts")
s = p.read_text()
s += """

test('Director combat task initiates a fresh safe observed enemy instead of only observing it',()=>{
  const o=observed();
  o.skills=o.skills.map(s=>['attack','strength','defence'].includes(s.name.toLowerCase())?{...s,current:10,base:10,xp:1000}:s);
  o.hp=10;o.max_hp=10;o.inventory=[];
  o.activity!.style=0;o.activity!.styles=[{index:0,name:'Accurate',skill:'attack'}];o.activity!.target_type='none';o.activity!.target_index=-1;
  o.entities=[{kind:'npc',ref:'goblin-7',index:7,content_id:100,name:'Goblin',position:{x:o.position!.x+1,z:o.position!.z,plane:o.position!.plane},reachable:true,options:[{index:2,text:'Attack'}],combat_level:2,hp:5,max_hp:5,in_combat:false}];
  const d=new LivePolicy().next(o,{id:'train-attack',kind:'combat',skill:'attack',foodTarget:0});
  expect(d.intent?.operation).toBe('interact');expect((d.intent as any)?.entity_ref).toBe('goblin-7');
});
"""
p.write_text(s)
