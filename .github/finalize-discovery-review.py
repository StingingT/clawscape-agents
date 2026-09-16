from pathlib import Path

def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f'{path}: expected one match, found {text.count(old)}: {old[:100]!r}')
    p.write_text(text.replace(old, new, 1))

p = 'src/agency/live-adapter.ts'
replace(p, '  /** Preserve a historically unresolved bank mutation as audit state instead of inventing success/failure. */',
'''  quarantinedTransaction(commandId:string):QuarantinedTransaction|undefined {
    const entry=this.document.transactionQuarantine?.find(q=>q.commandId===commandId);
    return entry&&structuredClone(entry);
  }
  /** Preserve a historically unresolved bank mutation as audit state instead of inventing success/failure. */''')
replace(p, '      itemIds:identity.itemIds,reason,evidence,goalKey,active:true};\n    this.document.transactionQuarantine=[...(this.document.transactionQuarantine??[]),entry].slice(-64);',
'''      itemIds:identity.itemIds,reason,evidence,goalKey,active:true,originalReceipt:structuredClone(receipt),
      observation:{tick:state.tick,sessionId:state.sessionId,character:state.character,world:state.world,
        worldEpoch:state.worldEpoch,profileId:state.profileId}};
    this.document.transactionQuarantine=[...(this.document.transactionQuarantine??[]),entry];''')
replace(p, "    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');\n    action=bindItems(action,state);",
"    if(this.document.receipt||this.document.safetyReceipt)throw new Error('RECONCILE_PENDING_ACTION_FIRST');\n    if(this.quarantinedTransaction(commandId))throw new Error('QUARANTINED_COMMAND_ID_CANNOT_BE_REUSED');\n    action=bindItems(action,state);")
replace(p, '      transactionQuarantine:(this.document.transactionQuarantine??[]).slice(-8),',
'      transactionQuarantine:(this.document.transactionQuarantine??[]).slice(-8).map(({originalReceipt,...brief})=>brief),')

p = 'agents/advanced/src/agency-bridge.ts'
replace(p, "  if(result.status==='SUCCEEDED'&&result.evidence.length)return {status:'verified',evidence:result.evidence};",
"  if(result.status==='CANCELLED'&&result.reason==='HISTORICALLY_UNRESOLVED_QUARANTINED')\n    return {status:'unknown',evidence:[],reason:result.reason};\n  if(result.status==='SUCCEEDED'&&result.evidence.length)return {status:'verified',evidence:result.evidence};")

p = 'agents/advanced/src/restart-journals.ts'
replace(p, "import { agencyState, agencyCandidate, arbiterVerification } from './agency-bridge.ts';",
"import { agencyState, agencyCandidate, arbiterVerification, observedVerification } from './agency-bridge.ts';\nimport { finalizeQuarantinedAction } from './transaction-quarantine.ts';")
replace(p, '    if(!unsettledResult(result))continue;',
'''    if(agency?.quarantinedTransaction(command.action_id)) {
      const retired=finalizeQuarantinedAction(store,agency,command.action_id);
      if(retired){report.resolved.push(command.action_id);continue;}
    }
    if(!unsettledResult(result))continue;''')
replace(p, "    if(row?.result.reason==='HISTORICALLY_UNRESOLVED_QUARANTINED') {\n      const q=agency.quarantinePendingTransaction(agencyState(second),row.result.reason);\n      if(q){report.resolved.push(receipt.commandId);continue;}\n    }\n", '')
replace(p, "    if(agency.pending(scope)&&scope==='task'&&proof.status==='unknown') {\n      const q=agency.quarantinePendingTransaction(agencyState(second),proof.reason??'historical attribution unavailable');\n      if(q&&row) {\n        const administrative={...row.result,status:'CANCELLED' as const,reason:'HISTORICALLY_UNRESOLVED_QUARANTINED',at:Date.now(),evidence:q.evidence};\n        store.result(administrative);store.append('transaction_quarantine',q.commandId,q);report.resolved.push(receipt.commandId);continue;\n      }\n    }",
'''    if(agency.pending(scope)&&scope==='task'&&proof.status==='unknown'&&row) {
      const current=agencyState(second);
      const observed=observedVerification(receipt.before,current,receipt.action);
      const q=agency.quarantinePendingTransaction(current,observed.reason??'');
      if(q&&finalizeQuarantinedAction(store,agency,q.commandId)) {
        report.unresolved=report.unresolved.filter(r=>r.commandId!==q.commandId);
        report.resolved.push(q.commandId);continue;
      }
    }''')

p = 'agents/advanced/src/live-cli.ts'
replace(p, "import {", "import {", ) if False else None
text=Path(p).read_text()
Path(p).write_text("import { finalizeQuarantinedAction } from './transaction-quarantine.ts';\n"+text)
replace(p, "          if(agency.pending(scope)&&scope==='task'&&proof.status==='unknown') {\n            const q=agency.quarantinePendingTransaction(agencyState(latest),proof.reason??'historical attribution unavailable');\n            if(q&&stored) {\n              store.result({...stored.result,status:'CANCELLED',reason:'HISTORICALLY_UNRESOLVED_QUARANTINED',at:Date.now(),evidence:q.evidence});\n              store.append('transaction_quarantine',q.commandId,q);\n            }\n          }",
'''          if(agency.pending(scope)&&scope==='task'&&proof.status==='unknown'&&stored) {
            const current=agencyState(latest);
            const observed=observedVerification(receipt.before,current,receipt.action);
            const q=agency.quarantinePendingTransaction(current,observed.reason??'');
            const retired=q&&finalizeQuarantinedAction(store,agency,q.commandId);
            if(retired&&receipt.before._advanced) {
              policy.retireReconciledOutcome(receipt.before._advanced,stored.command.intent,retired);
              store.append('live_policy_checkpoints',crypto.randomUUID(),policy.summary());
            }
          }''')

p = 'agents/advanced/src/live-policy.ts'
replace(p, "    const pending=this.state.uncertain;\n    if(!pending||result.status!=='CANCELLED'||!result.evidence.length\n      ||!['RECONCILED_TRANSIENT_INTERRUPTED','RECONCILED_DIALOGUE_CONTEXT_EXPIRED'].includes(result.reason)",
"""    const pending=this.state.uncertain;
    const bankQuarantine=['withdraw','deposit'].includes(intent.operation)
      &&result.reason==='HISTORICALLY_UNRESOLVED_QUARANTINED'
      &&result.evidence.includes(`historical-command-quarantined:${result.action_id}`);
    if(!pending||result.status!=='CANCELLED'||!result.evidence.length
      ||(!bankQuarantine&&!['RECONCILED_TRANSIENT_INTERRUPTED','RECONCILED_DIALOGUE_CONTEXT_EXPIRED'].includes(result.reason))""")
