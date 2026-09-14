import type { Memory } from '../../src/agency/types.ts';
/** Deliberate prior experiment for guard tests; not the live role-only default. */
export function seedBuildExperiment(memory: Memory): Memory {
  memory.ambition = {version:1,id:'combat-build-experiment',name:'Fixture build comparison',chosenAt:1,
    reason:'Compare a restricted build against a recorded personal trial baseline.',
    evidence:['own-completed-objective:1:fixture-training'],history:[],alternatives:[]};
  return memory;
}
