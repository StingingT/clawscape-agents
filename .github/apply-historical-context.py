from pathlib import Path

def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != 1:
        raise RuntimeError(f'{path}: expected one exact anchor, found {n}: {old[:100]}')
    p.write_text(text.replace(old, new))

p='src/agency/live-adapter.ts'
replace(p,"import { effectState, progressHealth, PROGRESS_TIMEOUT_MS } from './progress.ts';", "import { effectState, progressHealth, PROGRESS_TIMEOUT_MS } from './progress.ts';\nimport { observeHistoricalContext, historicalActionIdentity, type HistoricalWindow } from './historical-context.ts';")
replace(p,'stationary?:QuietWindow; investigation?:','stationary?:QuietWindow; historicalWindow?:HistoricalWindow; investigation?:')
replace(p,"    if(!receipt||receipt.scope!=='task'||!pending||pending.commandId!==receipt.commandId||pending.status!=='unknown')return;\n    const now=this.clock();\n    if(!quarantineEligible(receipt.action,receipt.before,state,receipt.startedAt,now,reason))return;\n    const identity=transactionIdentity(receipt.action,receipt.before);if(!identity)return;", """    if(!receipt||receipt.scope!=='task'||this.document.safetyReceipt||!pending||pending.commandId!==receipt.commandId||pending.status!=='unknown')return;
    const now=this.clock();
    let historicalEvidence:string[]=[];
    if(!quarantineEligible(receipt.action,receipt.before,state,receipt.startedAt,now,reason)) {
      const historical=observeHistoricalContext(receipt.action,receipt.before,state,receipt.startedAt,now,this.observer,receipt.historicalWindow);
      receipt.historicalWindow=historical.window;
      receipt.investigation={at:now,reason:historical.reason,quietSince:historical.window?.since};
      if(!historical.settled){this.document.blocked=historical.reason;this.save();return;}
      historicalEvidence=historical.evidence;
    }
    const identity=historicalActionIdentity(receipt.action,receipt.before);if(!identity)return;""")
replace(p,"      'Future bank mutations for the affected item require a complete fresh bank snapshot.'];", "      ...(identity.kind==='bank'?['Future bank mutations for the affected item require a complete fresh bank snapshot.']:[]),\n      ...historicalEvidence];")
replace(p,"itemIds:identity.itemIds,reason,evidence,goalKey,active:true,originalReceipt:structuredClone(receipt),", "itemIds:identity.itemIds,reason,evidence,goalKey,active:identity.kind==='bank',originalReceipt:structuredClone(receipt),")
replace(p,"    if(this.director.memory.active)this.director.deferCurrent(now,'Historical bank transaction quarantined; replan only from fresh current state.',evidence);\n    this.document.blocked='Historical bank transaction quarantined; value-moving replay disabled until fresh bank accounting.';", """    if(this.director.memory.active)this.director.deferCurrent(now,'Historical action quarantined; replan only from fresh current state.',evidence);
    this.document.blocked=identity.kind==='bank'
      ?'Historical bank transaction quarantined; affected bank mutations require fresh accounting.'
      :'Historical navigation context quarantined; original effect unknown, old command permanently non-replayable.';""")
replace(p,'/** Preserve a historically unresolved bank mutation as audit state instead of inventing success/failure. */','/** Preserve a supported historical action as audit state, not success/failure.\n   * Bank mutations retain item-level accounting barriers; old navigation retains a permanent command ban. */')
replace(p,"    if(this.document.safetyReceipt)throw new Error('RECONCILE_SAFETY_ACTION_FIRST');\n    action=bindItems(action,state);", "    if(this.document.safetyReceipt)throw new Error('RECONCILE_SAFETY_ACTION_FIRST');\n    if(this.quarantinedTransaction(commandId))throw new Error('QUARANTINED_COMMAND_ID_CANNOT_BE_REUSED');\n    action=bindItems(action,state);")
replace(p,"    if(this.document.lastCommands.includes(commandId))return;\n    const safety=", "    if(this.document.lastCommands.includes(commandId)||this.quarantinedTransaction(commandId))return;\n    const safety=")
replace(p,"    if(verification.status!=='unknown' && (verification.evidence.length || verification.status==='rejected')) {", """    // A terminal, command-scoped navigation refusal ends this APPROACH now.
    // Loading, partial movement, danger and unknown dispatches do not qualify.
    const nav=receipt.execution?.navigation;
    if(!safety&&!this.document.receipt&&verification.status==='interrupted'&&verification.evidence.length
      &&nav?.status==='blocked'&&nav.movementDispatched===false
      &&['door-retry-budget','partial-path','empty-route','unverified-collision-coverage','transition-required'].includes(nav.reason??'')) {
      const routeId=receipt.methodId?.startsWith('survey:')?receipt.methodId.slice(7):undefined;
      const route=routeId?this.document.knowledge.routes[routeId]:undefined;
      if(route)this.deferSurvey(route,after,'NAVIGATION_APPROACH_EXHAUSTED: '+nav.reason);
      else if(this.director.memory.active?.plan?.steps[0]?.methodId===receipt.methodId)
        this.deferCurrent(after,'NAVIGATION_APPROACH_EXHAUSTED: '+nav.reason);
    }
    if(verification.status!=='unknown' && (verification.evidence.length || verification.status==='rejected')) {""")
replace(p,"    this.document.blocked=decision.type==='blocked'?decision.reason:undefined;this.save();", """    if(decision.type==='blocked'&&!this.director.memory.active&&catalogue.discovery?.nextProbeAt!==undefined)
      decision.reason+=` Discovery is bounded: ${catalogue.discovery.reason}; next probe eligible at ${catalogue.discovery.nextProbeAt}. Normal objectives were reconsidered.`;
    this.document.blocked=decision.type==='blocked'?decision.reason:undefined;this.save();""")

p='src/agency/director.ts'
replace(p,"    goal.blocker = { at, reason, recheckAt: at + COOLDOWN_MS };", """    // Repeated diagnostics must not slide the same recheck deadline forever.
    // next() owns the bounded recheck counter and preserves it across polling.
    const previous=goal.blocker;
    goal.blocker = previous ? {...previous,reason} : {at,reason,recheckAt:at+30_000,attempts:0};""")
replace(p,"      stats.viability = 'temporarily-poor'; stats.cooldownUntil = at + COOLDOWN_MS;", "      stats.viability = 'temporarily-poor';\n      if(!previous)stats.cooldownUntil = at + COOLDOWN_MS;")

p='src/agency/world-model.ts'
replace(p,'tasks: Map<string, Task> };', 'tasks: Map<string, Task>; discovery?:{reason:string;nextProbeAt?:number} };')
replace(p,"  const discoveryBootstrap=health.lastProductiveAt===null||health.stalled||!!memory.active?.blocker;", """  const lastReview=memory.reviews.at(-1);
  // A successful discovery probe may continue its bounded episode. Ordinary
  // productive work still suppresses bootstrap (including persisted probes).
  const continuingDiscovery=lastReview?.result==='success'&&/^survey:local-probe:/.test(lastReview.goal.id)
    &&now>=lastReview.at&&now-lastReview.at<10*60_000
    &&(health.lastProductiveAt===null||health.lastProductiveAt<=lastReview.at);
  const discoveryBootstrap=health.lastProductiveAt===null||health.stalled||!!memory.active?.blocker||continuingDiscovery;""")
replace(p,"  return {view,opportunities,methods,tasks};", """  const probeReviews=memory.reviews.filter(r=>/^(?:survey:)?local-probe:/.test(r.goal.id)&&now>=r.at&&now-r.at<10*60_000).sort((a,b)=>a.at-b.at);
  const discovery=probeReviews.length>=2
    ?{reason:'local discovery attempt budget exhausted',nextProbeAt:probeReviews.at(-2)!.at+10*60_000}
    :!discoveryBootstrap&&health.lastProductiveAt!==null
      ?{reason:'bootstrap deferred after productive work',nextProbeAt:health.lastProductiveAt+5*60_000}
      :{reason:safeProbeState?'local discovery available':'current safety/observation state prevents discovery'};
  return {view,opportunities,methods,tasks,discovery};""")

p='agents/advanced/src/transaction-quarantine.ts'
replace(p,"import { transactionIdentity } from '../../../src/agency/transaction-quarantine.ts';", "import { historicalActionIdentity } from '../../../src/agency/historical-context.ts';")
replace(p,"    || !['withdraw', 'deposit'].includes(row.command.intent.operation)) throw new Error('QUARANTINE_EXECUTOR_IDENTITY_MISMATCH');", "    || !['withdraw','deposit','move','interact'].includes(row.command.intent.operation)) throw new Error('QUARANTINE_EXECUTOR_IDENTITY_MISMATCH');")
replace(p,"  if (transactionIdentity(action, agencyState(before))?.semanticKey !== q.semanticKey", "  if (historicalActionIdentity(action, agencyState(before))?.semanticKey !== q.semanticKey")
replace(p,"  store.db.transaction(() => {\n    store.append('transaction_quarantine'", """  const control=store.control();
  if(!['RECONCILING','RUNNING'].includes(control.mode)||control.disabled||control.expires<=Date.now())
    throw new Error('RECOVERY_LEASE_REQUIRED');
  store.db.transaction(() => {
    const current=store.control(),entry=store.action(commandId);
    if(current.lease!==control.lease||current.mode!==control.mode||current.disabled||current.expires<=Date.now()
      ||JSON.stringify(entry)!==JSON.stringify(row))throw new Error('RECOVERY_STATE_CHANGED');
    store.append('transaction_quarantine'""")

p='agents/advanced/src/restart-journals.ts'
replace(p,"else if(before&&['move','close_interface','style','dialogue'].includes(command.intent.operation))", "else if(before&&['move','close_interface','style','dialogue','interact','pickup','use_on_item','use_on_object'].includes(command.intent.operation))")
replace(p,"if(agency.pending(scope))report.unresolved.push({commandId:receipt.commandId,operation:receipt.action.type,reason:proof.reason??'Pending accounting or safety outcome.'});", """if(agency.pending(scope)) {
      const pending=agency.pending(scope)!;
      report.unresolved.push({commandId:receipt.commandId,operation:receipt.action.type,
        reason:pending.investigation?.reason??proof.reason??'Pending accounting or safety outcome.',
        settling:!!pending.historicalWindow});
    }""")

p='agents/advanced/src/live-policy.ts'
replace(p,"    const bankQuarantine=['withdraw','deposit'].includes(intent.operation)\n      &&result.reason==='HISTORICALLY_UNRESOLVED_QUARANTINED'", """    const bankQuarantine=(['withdraw','deposit'].includes(intent.operation)
      ||['move','interact'].includes(intent.operation)&&result.evidence.includes('historical-navigation-context'))
      &&result.reason==='HISTORICALLY_UNRESOLVED_QUARANTINED'""")
print('Historical context and exhausted-method integration applied.')
