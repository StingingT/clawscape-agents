# Verified source findings for the prerequisite-planning design

Review date: 2026-09-22.

## Scope and limitations

Inspected the mounted `clawscape-agent-integration-source.zip`, the payload of `Clawscape_Source_Integration_20260921_1.zip`, and `source-catalogue-report.json`. These are uploaded snapshots, not a read of the current Windows filesystem or live server. No code or persisted player memory has been changed. The skill and runtime-design documents are proposals, not an implemented patch.

The user's latest instruction is that acquisition and development decisions be generic and self-selected. The old fishing destination is discussed below only to locate its source, not to prescribe or blacklist it.

## 1. There is already a recursive planner to extend

`src/agency/director.ts` contains `makePlan`, which recursively achieves requirements, consumes projected resources, maintains lineage and bounds search. `Director.attach` translates lineage into support goals under the parent. This supports extending the current architecture rather than creating a competing planner.

Its current selection sorts available methods by a local method score and returns a feasible recursive construction. This is not evidence that all complete acquisition approaches have been compared for minimum total preparation/execution cost.

Lines 52–59:

```text
52: export function makePlan(memory: Memory, view: Observation, goal: Opportunity, methods: Method[]): Plan | undefined {
53:   validateView(memory, view);
54:   if (!outcomeTarget(goal.target)) return;
55:   const candidates = methods.filter(m => available(memory, view, m))
56:     .sort((a, b) => methodScore(memory, view.context, a) - methodScore(memory, view.context, b) || a.id.localeCompare(b.id));
57:   let facts = { ...view.facts };
58:   let plan: Plan = { steps: [], costGp: 0, lossBoundGp: 0, durationMs: 0 };
59:   let visits = 0;
```
Lines 88–89:

```text
88:   return achieve(goal.target, new Set()) && fits(plan, view.budget) ? plan : undefined;
89: }
```
Lines 106–110:

```text
106:   private attach(goal: Goal, plan: Plan, view: Observation, purpose: SupportGoal['purpose'] = 'prerequisite'): Decision {
107:     const nodes = new Map<string, SupportGoal>((goal.supportGoals ?? []).filter(n=>met(view.facts,n.target)).slice(-8).map(n => [n.id, { ...n, status:'satisfied' as const }]));
108:     for (const step of plan.steps) {
109:       step.goalKey = goal.key;
110:       const lineage = step.lineage ?? [goal.target];
```

## 2. The old fishing lead is in source, not necessarily only in saved memory

In `src/agent.ts`, `WORLD_ROUTES` includes `karamjaLobsterFishing`. The agent passes the entries of `WORLD_ROUTES` to its agency as route leads. The name in the user's message differs slightly; this is the exact matching source identifier.

Lines 130–130:

```text
130:   karamjaLobsterFishing: { x: 2923, z: 3179 },
```
Lines 1681–1681:

```text
1681:     routes:Object.entries(WORLD_ROUTES).map(([id,p])=>({id,...p,level:0,evidence:'bundled route lead; arrival not yet personally verified'})),
```

`src/agency/world-model.ts` copies seed routes into route knowledge and considers eligible unvisited routes as survey opportunities. These gates do not prove the particular destination is selected now; they establish a source path by which a bundled direction can become a candidate. This review did not inspect a current saved goal proving which trigger is responsible for the user's latest observation.

Lines 156–156:

```text
156:   for (const r of seedRoutes) if (Number.isInteger(r.x) && Number.isInteger(r.z) && Number.isInteger(r.level)) k.routes[r.id] ??= r;
```
Lines 286–296:

```text
286:   for (const route of Object.values(k.routes).filter(r => meaningfulFrontierRoute(r) && r.level === Number(state.player?.level ?? 0) && !k.visited[r.id]
287:     // Previously generated routes must pass the same gate; generation-only gating leaks stale probes.
288:     && (!r.id.startsWith('local-probe:')||probeEligible(r))
289:     && (!k.routeFailures?.[r.id] || k.routeFailures[r.id]!.retryAt<=now || k.routeFailures[r.id]!.context!==capabilityContext(state) || k.routeFailures[r.id]!.learningRevision<(memory.learningRevision??0))).slice(0,64)) {
290:     const surveyId='survey:'+route.id;
291:     if(learned.exhausted.has(surveyId)||learned.exhausted.has(route.id))continue;
292:     const before=opportunities.length;
293:     add({id:surveyId,kind:'exploration',route},'exploration','visited:'+route.id,1,1,
294:        learned.noveltyPressure?'Known production/gathering routes are exhausted at this progress boundary; verify a different sourced frontier lead.':'Visit a sourced lead and verify it personally; path assessment and arrival are required.', learned.noveltyPressure?'unlock':'frontier');
295:     if(route.id.startsWith('local-probe:')&&opportunities.length>before)opportunities.at(-1)!.priority='maintenance';
296:   }
```

`src/agency/reconciliation.ts` excludes one older evidence format but otherwise accepts non-`observed:` route IDs as potentially meaningful frontiers. Thus a generic intent/provenance review is preferable to deleting one saved destination or globally banning one place.

Lines 15–20:

```text
15: export function meaningfulFrontierRoute(route: Route): boolean {
16:   const evidence=String(route.evidence);
17:   if(/^documented lead;/i.test(evidence))return false;
18:   if (!route.id.startsWith('observed:')) return true;
19:   return /^own-transition:\d+:\d+:(open|climb(?:-up|-down)?|enter|cross)$/i.test(evidence);
20: }
```

## 3. The source adapter has skill predicates, but activity flags are not XP yields

The integration package's `payload/src/agency/source-methods.ts` emits `level:<skill>` prerequisites. Its projected `xp:<activity>` value of one is explicitly documented as an activity flag. A training expansion must not mistake it for a verified XP-per-action value or assume it creates a level gain.

This is a limitation of the inspected interface, not a claim that all existing training code is absent. A proper prerequisite-training bridge needs authoritative XP/level rules, currently feasible training actions and verified progress receipts.

Lines 64–64:

```text
64:     if('skill'in r){if(skills[r.skill]===undefined)gaps.push('Unknown skill: '+r.skill);else if(skills[r.skill]<r.level)gaps.push(`${r.skill} requires ${r.level}, observed ${skills[r.skill]}`);return [[{fact:'level:'+r.skill,minimum:r.level}]];}
```
Lines 151–151:

```text
151:     if(activity)m.effects['xp:'+activity]=1; // Only a projected activity flag; actual XP remains observation-derived.
```

The same module deliberately distinguishes recipe knowledge from executor coverage. For example, its generic fallback reports an unintegrated executor rather than assuming that catalogue knowledge makes the action callable. This separation should be retained.

Lines 94–94:

```text
94:   return 'executor not integrated: '+sem.capability;
```

## 4. The shadow report confirms mixed blocker types

`source-catalogue-report.json` identifies itself as `source-catalogue-20260921.1`, in `shadow` mode, captured at `2026-09-21T21:17:11.655Z`. Stinger's final `source-restock-ammunition` plan is blocked. Its recorded blockers include both `smithing requires 30, observed 1` and `executor not integrated: smith-at-anvil`, as well as unresolved membership and local availability conditions.

These are distinct causes: character development can address a genuine level shortfall, but cannot implement the missing anvil adapter. The report does not prove that cooperative combat, all training methods or the old fishing goal are active. Its note explicitly says the worker reports have individual observation timestamps, not a synchronized snapshot.

## 5. Existing support-goal and safety contracts must be preserved

`src/agency/types.ts` already has `SupportGoal` with `parentId`, a target and evidence. `Observation.capabilities` is described as registered executable capabilities, not prose from another player. `Memory.preferences` describes roles as scoring preferences rather than capability restrictions. The proposed design extends those contracts and does not grant the model direct action authority.

## Reproducibility hashes

SHA-256 identifies the exact inspected bytes, not evidence that these are still the live versions.

| Artifact or file | SHA-256 |
|---|---|
| `clawscape-agent-integration-source.zip` | `802654f05d6fec0e1eb6c8c74f75565862aa6e75aa872fb1ffe7c741a5c97a98` |
| `Clawscape_Source_Integration_20260921_1.zip` | `6887e2af3ace27b55fdd676a8bcb016bc4a357b031d968c2494e14f649e4adc3` |
| `source-catalogue-report.json` | `3bc73e643be1c1a46bbb92df0bed9eb87f2b27091f9095b019f2c99f59fa7d28` |
| `src/agency/director.ts` | `68fb3f8826210175f616a336b4f86a7af6e2da892d760d73020d8a8d524a5e75` |
| `src/agent.ts` | `070c233ba454a77806d7a1965feb233dbe0c006a8e7031d898ff1557f88c3bba` |
| `src/agency/world-model.ts` | `e9241553fd6a1898578bbd47dac9311a3aa7f8512cee443eb8eb5dfa71b0292d` |
| `src/agency/reconciliation.ts` | `cf889151cad41bed5f0465ea993a0c560345199bb550572343bc05b6c365f203` |
| `payload/src/agency/source-methods.ts` | `c9ba4272de51f8992a6c41fb4802addb4e368c7407ce161e447710b33645ca68` |
