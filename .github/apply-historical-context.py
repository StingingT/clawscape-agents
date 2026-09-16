from pathlib import Path

changed = {}
def edit(path, old, new):
    text = changed.get(path, Path(path).read_text())
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one guarded match, got {count}: {old[:100]}')
    changed[path] = text.replace(old, new, 1)

p = 'src/agency/live-adapter.ts'
edit(p, "import { randomUUID } from 'node:crypto';", "import { randomUUID } from 'node:crypto';\nimport { observeHistoricalContext, historicalWindowReady, historicalTraversal, type HistoricalWindow } from './historical-context.ts';")
edit(p, "stationary?:QuietWindow; investigation?:", "stationary?:QuietWindow; historical?:HistoricalWindow; investigation?:")
edit(p, '  transactionQuarantine?:QuarantinedTransaction[];', "  transactionQuarantine?:QuarantinedTransaction[];\n  historicalRetirements?:Array<{at:number;commandId:string;receipt:Receipt;reason:string;evidence:string[];lossAttribution:'unknown'}>;\n  discoveryRetryAt?:number;")
edit(p, "export type Verification = { recovery?:'investigate';", "export type Verification = { historical?:boolean; recovery?:'investigate';")
edit(p, "    const decision=this.director.next(catalogue.view,catalogue.opportunities,catalogue.methods);", """    const decision=this.director.next(catalogue.view,catalogue.opportunities,catalogue.methods);
    this.document.discoveryRetryAt=undefined;
    if(decision.type==='blocked'&&!this.director.memory.pending&&!this.director.memory.active&&catalogue.discoveryRetryAt) {
      this.document.discoveryRetryAt=catalogue.discoveryRetryAt;
      decision.reason+=' Local discovery is temporarily budgeted/cooling down; next eligibility '+new Date(catalogue.discoveryRetryAt).toISOString()+'. Feasible ordinary goals are still reconsidered on each observation.';
    }""")
edit(p, """    const now=this.clock();
    if(!quarantineEligible(receipt.action,receipt.before,state,receipt.startedAt,now,reason))return;
    const identity=transactionIdentity(receipt.action,receipt.before);if(!identity)return;
    const evidence=[`historical-command-quarantined:${receipt.commandId}`,`fresh-current-state:${state.tick}`,""", """    const now=this.clock();
    const identity=transactionIdentity(receipt.action,receipt.before);if(!identity)return;
    const quantity=Number(receipt.action.fields?.amount);
    if(!Number.isSafeInteger(quantity)||!(quantity>0||receipt.action.type==='bankDeposit'&&quantity===-1))return;
    let historicalEvidence:string[]=[];
    if(!quarantineEligible(receipt.action,receipt.before,state,receipt.startedAt,now,reason)) {
      const current=observeHistoricalContext(receipt.before,state,now,this.observer,receipt.historical);
      receipt.historical=current.window;
      receipt.investigation={at:now,reason:current.reason,quietSince:current.window?.since};
      this.document.blocked=current.reason;this.save();
      // A new current-context window, not the old server tick origin, establishes
      // administrative finality. The original value-moving effect stays unknown.
      if(!current.settled||!Number.isFinite(receipt.startedAt)||now-receipt.startedAt<120_000)return;
      historicalEvidence=current.evidence;
    }
    const evidence=[`historical-command-quarantined:${receipt.commandId}`,`fresh-current-state:${state.tick}`,...historicalEvidence,""")
edit(p, """    const result=observeQuietStep(r.action,r.before,state,this.clock(),this.observer,r.stationary);
    r.stationary=result.window;
    r.investigation={at:this.clock(),reason:result.reason,quietSince:result.window?.since};""", """    const result=observeQuietStep(r.action,r.before,state,this.clock(),this.observer,r.stationary);
    r.stationary=result.window;
    if(!result.settled&&historicalTraversal(r.action,r.before)) {
      const current=observeHistoricalContext(r.before,state,this.clock(),this.observer,r.historical,true);
      r.historical=current.window;
      if(current.window) {
        r.investigation={at:this.clock(),reason:current.reason,quietSince:current.window.since};
        this.document.blocked=current.reason;this.save();
        return current.settled?{status:'interrupted',recovery:'investigate',historical:true,
          reason:current.reason,evidence:['historical-context-retired',...current.evidence]}:undefined;
      }
    }
    r.investigation={at:this.clock(),reason:result.reason,quietSince:result.window?.since};""")
edit(p, "    if(this.quarantinedTransaction(commandId))throw new Error('QUARANTINED_COMMAND_ID_CANNOT_BE_REUSED');", """    if(this.quarantinedTransaction(commandId))throw new Error('QUARANTINED_COMMAND_ID_CANNOT_BE_REUSED');
    if(this.document.historicalRetirements?.some(r=>r.commandId===commandId))throw new Error('HISTORICAL_COMMAND_ID_CANNOT_BE_REUSED');""")
edit(p, """    if(this.document.safetyReceipt)throw new Error('RECONCILE_SAFETY_ACTION_FIRST');
    action=bindItems(action,state);""", """    if(this.document.safetyReceipt)throw new Error('RECONCILE_SAFETY_ACTION_FIRST');
    if(this.quarantinedTransaction(commandId)||this.document.historicalRetirements?.some(r=>r.commandId===commandId))throw new Error('HISTORICAL_COMMAND_ID_CANNOT_BE_REUSED');
    action=bindItems(action,state);""")
edit(p, "    if(this.document.lastCommands.includes(commandId))return;", "    if(this.document.lastCommands.includes(commandId)||this.document.historicalRetirements?.some(r=>r.commandId===commandId)||this.quarantinedTransaction(commandId))return;")
edit(p, """    if(!receipt||receipt.commandId!==commandId)throw new Error('OUTCOME_WITHOUT_MATCHING_INTENT');
    if(verification.status==='verified') {""", """    if(!receipt||receipt.commandId!==commandId)throw new Error('OUTCOME_WITHOUT_MATCHING_INTENT');
    const historical=verification.historical===true&&verification.status==='interrupted'
      &&verification.evidence.includes('historical-context-retired')&&historicalTraversal(receipt.action,receipt.before)
      &&historicalWindowReady(receipt.before,after,this.clock(),this.observer,receipt.historical,true);
    if(verification.historical&&!historical)verification={status:'unknown',evidence:[],reason:'Historical retirement requires this controller\'s measured current-context window.'};
    if(historical) {
      this.document.historicalRetirements=[...(this.document.historicalRetirements??[]),
        {at:this.clock(),commandId,receipt:structuredClone(receipt),reason:verification.reason??'historical context ended',
         evidence:[...verification.evidence],lossAttribution:'unknown'}];
      // These are administrative charges, NOT a claim that no loss/death occurred.
      // Unattributable historical losses remain explicitly unknown in the audit.
      metrics={spentGp:0,lostGp:0,deaths:0,elapsedMs:Math.max(0,this.clock()-receipt.startedAt)};
    }
    if(verification.status==='verified') {""")
edit(p, "    const deaths=Number(after.player?.lifeId!==receipt.before.player?.lifeId);", "    const deaths=historical?0:Number(after.player?.lifeId!==receipt.before.player?.lifeId);")
edit(p, """    this.save();
  }
  summary() {""", """    // A terminally exhausted navigation attempt is a refusal of this approach,
    // not authority to keep the same exploration goal idle for another timeout.
    const nav=receipt.execution?.navigation,active=this.director.memory.active;
    if(!safety&&!this.document.receipt&&!this.document.safetyReceipt&&active&&verification.status==='interrupted'
      &&verification.evidence.length&&nav?.status==='blocked'
      &&/^(door-retry-budget|empty-route|partial-path|unverified-collision-coverage|transition-required|no-progress|leg-timeout)$/.test(nav.reason??'')) {
      const routeId=receipt.methodId?.startsWith('survey:')?receipt.methodId.slice(7):undefined;
      const route=routeId?this.document.knowledge.routes[routeId]:undefined;
      if(route)this.deferSurvey(route,after,'EXHAUSTED_NAVIGATION: '+nav.reason);
      else if(active.domain==='exploration'&&active.id===receipt.methodId)this.deferCurrent(after,'EXHAUSTED_NAVIGATION: '+nav.reason);
    }
    this.save();
  }
  summary() {""")
edit(p, "      transactionQuarantine:(this.document.transactionQuarantine??[]).slice(-8).map(({originalReceipt,...brief})=>brief),", """      transactionQuarantine:(this.document.transactionQuarantine??[]).slice(-8).map(({originalReceipt,...brief})=>brief),
      historicalRetirements:(this.document.historicalRetirements??[]).slice(-8).map(({receipt,...brief})=>brief),
      discoveryRetryAt:this.document.discoveryRetryAt,""")

p='src/agency/director.ts'
edit(p, "    goal.blocker = { at, reason, recheckAt: at + COOLDOWN_MS };", """    // Re-reporting the same refusal must not move its deadline indefinitely.
    // Only a changed cause starts a new bounded investigation window.
    const previous=goal.blocker;
    goal.blocker=previous?.reason===reason?previous:{at,reason,recheckAt:at+30_000,attempts:0};""")
edit(p, "      stats.viability = 'temporarily-poor'; stats.cooldownUntil = at + COOLDOWN_MS;", "      stats.viability = 'temporarily-poor'; if(previous?.reason!==reason)stats.cooldownUntil = at + COOLDOWN_MS;")

p='src/agency/world-model.ts'
edit(p, "import { progressHealth } from './progress.ts';", "import { progressHealth, PROGRESS_TIMEOUT_MS } from './progress.ts';")
edit(p, "export type Catalogue = { view: Observation;", "export type Catalogue = { discoveryRetryAt?:number; view: Observation;")
edit(p, "  return {view,opportunities,methods,tasks};", """  // A bounded discovery cooldown is not missing implementation or a reason to
  // suppress normal productive opportunities. Surface its next eligibility.
  const budgetTimes=memory.reviews.filter(r=>/^(?:survey:)?local-probe:/.test(r.goal.id)&&now-r.at<10*60_000)
    .map(r=>r.at).sort((a,b)=>b-a);
  const budgetReadyAt=budgetTimes.length>=2?budgetTimes[1]!+10*60_000:now;
  const bootstrapReadyAt=discoveryBootstrap?now:(health.lastProductiveAt??now)+PROGRESS_TIMEOUT_MS;
  const nextProbeAt=Math.max(budgetReadyAt,bootstrapReadyAt);
  const discoveryRetryAt=supported.includes('exploration')&&safeProbeState&&nextProbeAt>now?nextProbeAt:undefined;
  return {view,opportunities,methods,tasks,discoveryRetryAt};""")

p='agents/advanced/src/transient-recovery.ts'
edit(p, "import { randomUUID } from 'node:crypto';", "import { randomUUID } from 'node:crypto';\nimport { historicalTraversal, observeHistoricalContext, type HistoricalWindow } from '../../../src/agency/historical-context.ts';")
edit(p, "{observer:string;lease:string;window?:QuietWindow}", "{observer:string;lease:string;window?:QuietWindow;historical?:HistoricalWindow}")
edit(p, """  saved.window=quiet.window;states.set(command.action_id,saved);
  if(!quiet.settled)return {settling:!!quiet.window,reason:quiet.reason};
  const reason=dialogue""", """  saved.window=quiet.window;
  const historical=!dialogue&&!quiet.settled&&historicalTraversal(action,agencyState(before))
    ?observeHistoricalContext(agencyState(before),agencyState(after),now,saved.observer,saved.historical,true):undefined;
  saved.historical=historical?.window;states.set(command.action_id,saved);
  if(!quiet.settled&&!historical?.settled)return {settling:!!quiet.window||!!historical?.window,reason:historical?.window?historical.reason:quiet.reason};
  const reason=historical?.settled?historical.reason:dialogue""")
edit(p, "at:now,evidence:[reason]};", "at:now,evidence:historical?.settled?['historical-context-retired',...historical.evidence]:[reason]};")

p='agents/advanced/src/agency-bridge.ts'
edit(p, "return {status:'interrupted',recovery:'investigate',evidence:result.evidence,reason:result.reason};", "return {status:'interrupted',recovery:'investigate',historical:result.evidence.includes('historical-context-retired'),evidence:result.evidence,reason:result.reason};")

p='agents/advanced/src/restart-journals.ts'
edit(p, "  const checkpoints=store.records<{action_id:string;before:Observation}>('action_checkpoints');", """  // Observe both journals in parallel; neither may claim the other's unmeasured
  // window, and a restart must not restart one only after the other settles.
  if(agency)for(const scope of ['safety','task'] as const){const r=agency.pending(scope);if(r)agency.settleStep(r.commandId,agencyState(second));}
  const checkpoints=store.records<{action_id:string;before:Observation}>('action_checkpoints');""")
edit(p, "else if(before&&['move','close_interface','style','dialogue'].includes(command.intent.operation))", "else if(before&&['move','close_interface','style','dialogue','interact','pickup','use_on_item','use_on_object'].includes(command.intent.operation))")
edit(p, "if(agency.pending(scope))report.unresolved.push({commandId:receipt.commandId,operation:receipt.action.type,reason:proof.reason??'Pending accounting or safety outcome.'});", """if(agency.pending(scope))report.unresolved.push({commandId:receipt.commandId,operation:receipt.action.type,
      reason:agency.pending(scope)?.investigation?.reason??proof.reason??'Pending accounting or safety outcome.',
      settling:!!agency.pending(scope)?.historical});""")

p='agents/advanced/src/live-cli.ts'
edit(p, "        await arbiter.reconcile();", """        for(const scope of ['safety','task'] as const){const r=agency.pending(scope);if(r)agency.settleStep(r.commandId,agencyState(latest));}
        await arbiter.reconcile();""")
edit(p, "mode,status,live:latest?.connected===true,goal:activeGoal,reason:why,", "mode,status,live:latest?.connected===true,goal:agency?.summary().goal?.id??(agency?'selecting-next-goal':activeGoal),reason:why,")

for path,text in changed.items():
    Path(path).write_text(text)
print('Applied guarded edits:', ', '.join(changed))
