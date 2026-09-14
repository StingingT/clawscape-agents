# Version-checked static source edits. Not executed by the game controllers.
FILES = [
  {"path":'agents/advanced/src/live-cli.ts',"before":'baf392b38a4e8fd9c1cd7369d844b557754bd390',"after":'90b7a8da6daf9651f8019e6685bca19d2694723a',"edits":[
    {"start":13,"end":15,"text":r"""import { LiveAgency, isSelection, type Selection } from '../../../src/agency/live-adapter.ts';
import { agencyState, agencyCandidate, arbiterVerification, observedVerification, urgentDecision } from './agency-bridge.ts';
"""},
    {"start":24,"end":40,"text":r""""""},
    {"start":111,"end":114,"text":r"""  const oldAgencyFile=join(data,'agency-memory.json');
  if (existsSync(oldAgencyFile) && JSON.parse(readFileSync(oldAgencyFile,'utf8')).pending)
    throw new Error('LEGACY_AGENCY_INTENT_RECONCILIATION_REQUIRED');
  let agency:LiveAgency|undefined;
"""},
    {"start":141,"end":142,"text":r"""      navigation,agency:agency?.summary(),
"""},
    {"start":149,"end":150,"text":r"""    if(mode==='run') {
      policy.resumeFromObservation(latest);
      const settings=join(data,'agency-policy.json');
      agency=new LiveAgency(join(data,'agency-v2.json'),{agent:latest.character,world:latest.world,revision:profile.profile_id},{
        supported:['food','bank','equipment','combat','exploration'],preferences:{exploration:2,combat:1},
        policy:existsSync(settings)?JSON.parse(readFileSync(settings,'utf8')):{},
        routes:[{id:'documented-draynor-approach',x:3088,z:3226,level:0,evidence:'documented lead; still requires collision-safe travel and own arrival'},
          {id:'documented-goblin-area',x:3252,z:3230,level:0,evidence:'documented lead; no encounter claimed before observation'},
          {id:'documented-chicken-area',x:3232,z:3295,level:0,evidence:'documented lead; no encounter claimed before observation'}],
      });
    }
"""},
    {"start":165,"end":165,"text":r"""      let planned:Selection|undefined;
      let emergency=false;
"""},
    {"start":184,"end":185,"text":r"""      } else {
        if(!agency)throw new Error('AGENCY_NOT_INITIALIZED');
        // Reconcile the SAME journaled action. A later action cannot satisfy its receipt.
        await arbiter.reconcile();
        for (const scope of ['safety','task'] as const) {
          const receipt=agency.pending(scope);
          if(!receipt)continue;
          const stored=store.action(receipt.commandId);
          let proof=receipt.action.type==='wait'
            ? observedVerification(receipt.before,agencyState(latest),receipt.action)
            : stored ? arbiterVerification(receipt.commandId,stored.result)
            : {status:'rejected' as const,evidence:['No arbiter reservation exists; transport could not have started.']};
          if(proof.status==='unknown'){
            const observed=observedVerification(receipt.before,agencyState(latest),receipt.action);
            if(observed.status==='verified')proof=observed;
          }
          agency.record(receipt.commandId,agencyState(latest),proof);
        }
        if(agency.pending('safety')){publish('RECONCILING','Unresolved safety action');await sleep(700);continue;}
        const urgent=urgentDecision(latest);
        if(urgent) { decision=urgent; emergency=true; }
        else {
          if(agency.pending()){publish('RECONCILING','Unresolved exact command; no replay');await sleep(700);continue;}
          const selection=agency.plan(agencyState(latest));
          if(!isSelection(selection)){publish('BLOCKED',selection.type==='blocked'?selection.reason:'Reconciliation required');await sleep(700);continue;}
          planned=selection;
          decision=policy.next(latest,planned.task);
        }
      }
"""},
    {"start":190,"end":198,"text":r"""        if(agency){
          if(!agency.pending()&&!agency.pending('safety'))agency.blocked(decision.blocked);
          publish('BLOCKED',decision.blocked);await sleep(700);continue;
"""},
    {"start":199,"end":199,"text":r"""        publish('BLOCKED',decision.blocked);reason=decision.blocked;break;
"""},
    {"start":207,"end":208,"text":r"""        if(step.blocked){if(agency&&!agency.pending())agency.blocked(step.blocked);policy.recordOutcome(latest,latest,decision,'FAILED');publish('REPLANNING',step.blocked);failed++;await sleep(700);continue;}
"""},
    {"start":215,"end":215,"text":r"""        if(agency&&planned&&decision.wait){
          const before=latest,action=agencyCandidate(before,decision),commandId=crypto.randomUUID();
          agency.begin(planned,action,agencyState(before),commandId);
          await sleep(700);latest=await adapter.snapshot();
          agency.record(commandId,agencyState(latest),observedVerification(agencyState(before),agencyState(latest),action));
          policy.observe(before,latest);
          continue;
        }
"""},
    {"start":219,"end":228,"text":r"""      const commandId=crypto.randomUUID();
      // One ID links the Director intent, arbiter reservation, dispatch and result.
      if(agency){
        const action=agencyCandidate(before,decision);
        if(emergency) agency.beginSafety(action,agencyState(before),commandId);
        else {
          if(!planned)throw new Error('GOAL_SELECTION_REQUIRED');
          agency.begin(planned,action,agencyState(before),commandId);
        }
"""},
    {"start":232,"end":233,"text":r"""      const command={schema_version:'1.0',action_id:commandId,character:'astra',world:before.world,
"""},
    {"start":248,"end":253,"text":r"""      if(agency)agency.record(command.action_id,agencyState(latest),arbiterVerification(command.action_id,result));
"""},
  ]},
  {"path":'agents/advanced/src/live-policy.ts',"before":'9244c10d66cd8e55a92b555c87e83e4fa2dbabd7',"after":'f41e8727c2ad2d644b02b0654abf24fae1108280',"edits":[
    {"start":1,"end":1,"text":r"""import type { Task } from "../../../src/agency/world-model.ts";
"""},
    {"start":142,"end":143,"text":r"""  next(o: Observation, task?: Task): LiveDecision {
"""},
    {"start":209,"end":209,"text":r"""    // Strategic ownership: the Director has chosen the outcome before this
    // executor is asked for an action. No fallback to an unrelated activity.
    if (task) {
      switch (task.kind) {
        case 'food': return this.finish(o, supplied(o)
          ? {goal:task.id,reason:'Food reserve observed; Director will review the actual predicate.',wait:true}
          : this.supply(o));
        case 'bank': return this.finish(o, this.startBank(o));
        case 'equipment': return this.finish(o, this.equip(o) ?? {goal:task.id,reason:'Owned kit is equipped.',wait:true});
        case 'combat': {
          if (!supplied(o)) return this.finish(o, this.supply(o));
          const gear = this.equip(o);
          return this.finish(o, gear ?? this.training(o, task.skill));
        }
        case 'exploration':
          if (!task.route) return block(task.id, 'NO_SOURCED_ROUTE', 'No personal observation or documented lead supports this route.');
          return this.finish(o, {goal:task.id,reason:task.route.evidence,
            destination:{x:task.route.x,z:task.route.z,plane:task.route.level}});
        default: return block(task.id, 'UNSUPPORTED_TASK_EXECUTOR', 'This controller does not implement the selected capability.');
      }
    }
"""},
    {"start":640,"end":641,"text":r"""  private training(o: Observation, requestedSkill?: string): LiveDecision {
"""},
    {"start":645,"end":646,"text":r"""    if (requestedSkill && !names.includes(requestedSkill as Skill)) return block('training', 'UNSUPPORTED_TRAINING_SKILL', 'The executor supports only its observed melee styles.');
    const lagging = requestedSkill ? {name:requestedSkill as Skill,ratio:0,remaining:1} : names.map((name, i) => ({ name, ratio: levels[i]! / goals[i]!, remaining: goals[i]! - levels[i]! }))
"""},
    {"start":649,"end":650,"text":r"""    const styles = o.activity!.styles.filter(s => styleSkills(s.skill).includes(lagging.name) && (!requestedSkill || styleSkills(s.skill).length === 1))
"""},
  ]},
  {"path":'docs/AGENCY_REQUIREMENTS.md',"before":'7684cada1cc45f7ab069d6e7ca16813ca99076a5',"after":'22075aaf1ce2bca4af4b6bf4e4eab3e8a54ea8de',"edits":[
    {"start":0,"end":1,"text":r"""# Agent-owned goals: owner decisions and status
"""},
    {"start":2,"end":3,"text":r"""## Accepted requirements
"""},
    {"start":4,"end":10,"text":r"""Roles influence priorities but are not permanent classes. A self-selected objective and supporting evidence must explain a change of direction. Stinger may develop Defence for a more demanding encounter; CoinCrafter may pursue combat to obtain items outside known craftable collections.
"""},
    {"start":11,"end":12,"text":r"""Experiments must preserve essential supplies and bound affordable losses. PvP requires separate future rules and is currently denied. Agents remain independent; friendship and favors should eventually support voluntary reciprocity rather than compulsory resource sharing.
"""},
    {"start":13,"end":19,"text":r"""Knowledge stays individual. A future quiet file-report transport should share sourced claims, not make every agent instantly omniscient. Public chat and forums must not become repetitive status feeds. Paid API assistance is exceptional and requires owner approval; it is not the default planner.
"""},
    {"start":20,"end":21,"text":r"""Coverage should grow through supported experiments. Missing capabilities become explicit blockers/development requests, not invented game commands or uncontrolled live self-modification.
"""},
    {"start":22,"end":23,"text":r"""## Current implementation
"""},
    {"start":24,"end":25,"text":r"""The Director is now connected to both runtime controller families. Goal generation precedes concrete action selection; task plans retain measurable outcomes through preparation and partial results. Command IDs, atomic receipts, actual post-state and reconciliation are shared across execution and learning. See [AGENCY_INTEGRATION.md](AGENCY_INTEGRATION.md) for implementation details, tests, operational prerequisites and limits.
"""},
    {"start":26,"end":46,"text":r"""This is no longer the original disconnected draft. It is also not a completed autonomous-human-player simulation. Quiet report sharing, social reciprocity, cooperative expeditions, expanded mechanics and owner-reviewed paid-assistance requests remain later work. No live deployment or 24-hour endurance claim is made.
"""},
  ]},
  {"path":'package.json',"before":'8a90c3942334358029c6eca651738bf37656fce4',"after":'b9af4e62b60345b75ab50d571f9e7ddcdc89db87',"edits":[
    {"start":6,"end":7,"text":r"""    "test:agency": "node --experimental-strip-types --test tests/agency/*.test.ts",
    "test:integration": "node --experimental-strip-types scripts/test-agency-controller.cjs",
    "check:agency": "node scripts/check-agency.cjs"
"""},
  ]},
  {"path":'scripts/supervise.ts',"before":'668a468c661c1be9c9d6bc087719efb7fc0213af',"after":'d275a39f4e81cd7b5c15466bddbbc7379bdb37a9',"edits":[
    {"start":11,"end":12,"text":r""" {name:'astra',cwd:resolve(root,'agents/advanced'),args:['src/live-cli.ts','run','--seconds','900']},
"""},
  ]},
  {"path":'src/action-outcome.test.ts',"before":'53ddf17a9dd238540599965c529911d05e828e7c',"after":'713fc7095ec36da8f030fca6af6f9fe977cf4ede',"edits":[
    {"start":7,"end":8,"text":r""" test('bank transfer requires both sides to change',()=>{const before=state({bank:{isOpen:true,items:[{id:2,slot:4,count:5}]},inventory:[{id:2,slot:0,count:1}]});const after=state({bank:{isOpen:true,items:[{id:2,slot:4,count:6}]},inventory:[]});const v=verifyActionOutcome(before,after,{id:'bank-deposit',type:'bankDeposit',fields:{slot:0,amount:1}});expect(v.verified).toBe(true);});
"""},
  ]},
  {"path":'src/agency/director.ts',"before":'1d154a361621d91fee687530e00deddbfcfa5596',"after":'318f04836e2784baf7a985cac9717e0622bae1e0',"edits":[
    {"start":142,"end":142,"text":r"""  /** An executable method can discover a missing prerequisite without dispatching. */
  blocked(at: number, reason: string, evidence: string[] = []): void {
    if (this.memory.pending) throw new Error('RECONCILE_PENDING_ACTION_FIRST');
    this.review(at, 'partial', reason, evidence);
  }

"""},
    {"start":159,"end":160,"text":r"""    if (!['verified', 'progress', 'rejected', 'unknown'].includes(outcome.status) || !Number.isSafeInteger(outcome.sequence) || outcome.sequence <= 0
"""},
    {"start":165,"end":166,"text":r"""    if (outcome.status === 'unknown' || (['verified', 'progress'].includes(outcome.status) && !outcome.evidence.length)) {
"""},
    {"start":171,"end":172,"text":r"""    const preparation = outcome.status === 'progress';
    // A verified route leg/interface transition advances a method; it is not
    // a failed training trial and does not satisfy a quantitative goal.
    if (preparation) stats.preparationMs = (stats.preparationMs ?? 0) + outcome.elapsedMs;
    else { stats.attempts++; stats.productive += Number(productive); stats.rejected += Number(outcome.status === 'rejected'); }
"""},
    {"start":173,"end":176,"text":r"""    if (!preparation) stats.cooldownUntil = productive ? 0 : outcome.at + COOLDOWN_MS;
    goal.attempts++; goal.noProgress = productive || preparation ? 0 : goal.noProgress + 1;
"""},
  ]},
  {"path":'src/agency/types.ts',"before":'95fff2ed313085a904e10357f4f581fb3031550c',"after":'124bb98311ecfff7c21399bd1b8ce101b8c787da',"edits":[
    {"start":67,"end":67,"text":r"""  preparationMs?: number;
"""},
    {"start":104,"end":105,"text":r"""  status: 'verified' | 'progress' | 'rejected' | 'unknown';
"""},
  ]},
  {"path":'src/training/discovery.test.ts',"before":'eebb8a603cbdffc52d1c3b5a2ce41b0adea35130',"after":'6917b8311568916886aaebd09d5fd81b82e48204',"edits":[
    {"start":105,"end":106,"text":r"""test('ranged Stinger can replace a stale commitment without a mandatory highest-tier target', fixture(async (d, _file, _clock) => {
"""},
    {"start":124,"end":126,"text":r"""  expect(ranged.memory.commitment?.siteId).toBe('barbarians');
  expect(action.fields?.trainingSite).toBe('barbarians');
"""},
    {"start":133,"end":134,"text":r"""test('strong comparable measured performance can outweigh an untested higher-tier prior', fixture(async d => {
"""},
    {"start":139,"end":140,"text":r"""  expect(action.fields?.trainingSite).toBe('cows');
"""},
    {"start":168,"end":169,"text":r"""test('completed encounter evidence changes the preferred site rather than a hardcoded tier bonus', fixture(async d => {
"""},
    {"start":172,"end":173,"text":r"""  expect((await d.next(s, route))[0].fields?.trainingSite).toBe('chickens');
"""},
    {"start":217,"end":217,"text":r"""
test('costly repeated higher-tier outcomes overcome its exploration bonus', fixture(async d => {
  const s=state(),key='melee:Iron scimitar:def0:skill2';
  d.memory.sites.cows.stats[key]={encounters:10,kills:10,productive:10,xp:500,ticks:100,damage:0,food:0,ammo:0,escapes:0,deaths:0};
  d.memory.sites.barbarians.stats[key]={encounters:10,kills:0,productive:0,xp:10,ticks:1000,damage:500,food:100,ammo:0,escapes:5,deaths:2};
  expect((await d.next(s,route))[0].fields?.trainingSite).toBe('cows');
}));
"""},
  ]},
  {"path":'src/training/discovery.ts',"before":'2a67ccb894e49b81160eeaaf39484f79a5a6b640',"after":'2339286a4f6ff7a1abaaa3589afc4e8870aa9343',"edits":[
    {"start":188,"end":198,"text":r"""    // Harder monsters are trials, not mandates. Sparse comparable evidence
    // gets a small, decaying bonus; measured risk and throughput remain decisive.
    const tierBias = (site: Site) => 1 / Math.sqrt(1 + (site.stats[context(s,this.ranged)]?.encounters ?? 0));
"""},
  ]},
]
