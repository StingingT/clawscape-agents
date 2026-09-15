import {test,expect} from 'bun:test';
import {recoverableExecutorBlock} from '../src/replanning.ts';

test('missing tool and exhausted local leads replan instead of freezing the session',()=>{
  for(const reason of ['MISSING_TOOL_ROUTE','MISSING_TOOL_OR_SUPPLY_ROUTE','PUBLIC_LEAD_NOT_CONFIRMED','REPEATED_NO_EFFECT','ROUTE_OSCILLATION','TRAINING_LEADS_EXHAUSTED'])
    expect(recoverableExecutorBlock(reason)).toBe(true);
});

test('safety and reconciliation blockers never auto-retire the selected goal',()=>{
  for(const reason of ['OUTCOME_UNCONFIRMED','STALE_OBSERVATION','UNRESOLVED_THREAT','STATE_CONTEXT_CHANGED','DEATH_RECOVERY_UNSUPPORTED'])
    expect(recoverableExecutorBlock(reason)).toBe(false);
});
