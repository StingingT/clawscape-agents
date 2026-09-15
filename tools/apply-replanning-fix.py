from pathlib import Path

def rep(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'anchor missing: {path}')
    p.write_text(s.replace(old,new,1))

rep('agents/advanced/src/live-cli.ts',
"import { agencyState, agencyCandidate, arbiterVerification, observedVerification, urgentDecision } from './agency-bridge.ts';",
"import { agencyState, agencyCandidate, arbiterVerification, observedVerification, urgentDecision } from './agency-bridge.ts';\nimport { recoverableExecutorBlock } from './replanning.ts';")

rep('agents/advanced/src/live-cli.ts',
"""        if(agency){
          if(!agency.pending()&&!agency.pending('safety'))agency.blocked(decision.blocked);
          publish('BLOCKED',decision.blocked);await sleep(700);continue;
        }""",
"""        if(agency){
          if(!agency.pending()&&!agency.pending('safety')) {
            if(recoverableExecutorBlock(decision.blocked)) {
              agency.deferCurrent(agencyState(latest),decision.blocked);
              publish('REPLANNING',decision.blocked);await sleep(700);continue;
            }
            agency.blocked(decision.blocked);
          }
          publish('BLOCKED',decision.blocked);await sleep(700);continue;
        }""")

Path('agents/advanced/src/replanning.ts').write_text("""const RECOVERABLE_EXECUTOR_BLOCKS = new Set([
  'MISSING_TOOL_ROUTE',
  'MISSING_TOOL_OR_SUPPLY_ROUTE',
  'PUBLIC_LEAD_NOT_CONFIRMED',
  'REPEATED_NO_EFFECT',
  'ROUTE_OSCILLATION',
  'TRAINING_LEADS_EXHAUSTED',
]);

/** Executor-local dead ends are evidence against the current bounded attempt,
 * not a reason to freeze the whole autonomous session. Safety, stale-state,
 * reconciliation and unknown-outcome blockers deliberately remain terminal. */
export const recoverableExecutorBlock = (reason:string):boolean => RECOVERABLE_EXECUTOR_BLOCKS.has(reason);
""")

Path('agents/advanced/tests/replanning.test.ts').write_text("""import {test,expect} from 'bun:test';
import {recoverableExecutorBlock} from '../src/replanning.ts';

test('missing tool and exhausted local leads replan instead of freezing the session',()=>{
  for(const reason of ['MISSING_TOOL_ROUTE','MISSING_TOOL_OR_SUPPLY_ROUTE','PUBLIC_LEAD_NOT_CONFIRMED','REPEATED_NO_EFFECT','ROUTE_OSCILLATION','TRAINING_LEADS_EXHAUSTED'])
    expect(recoverableExecutorBlock(reason)).toBe(true);
});

test('safety and reconciliation blockers never auto-retire the selected goal',()=>{
  for(const reason of ['OUTCOME_UNCONFIRMED','STALE_OBSERVATION','UNRESOLVED_THREAT','STATE_CONTEXT_CHANGED','DEATH_RECOVERY_UNSUPPORTED'])
    expect(recoverableExecutorBlock(reason)).toBe(false);
});
""")
