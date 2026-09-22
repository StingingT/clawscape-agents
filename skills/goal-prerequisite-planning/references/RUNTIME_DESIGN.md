# Clawscape prerequisite planning — runtime design

Status: proposed extension, 2026-09-22. Not an installation patch. No runtime behavior or live memories were changed while preparing this package.

## 1. Keep one planner

Extend the existing `Director.makePlan`, `SupportGoal` lineage and acquisition interfaces. Do not add an independent LLM controller or a second task queue that competes with the Director. Existing source-catalogue checks, action receipts, build rules and reconciliation remain authoritative.

The conceptual pattern is hierarchical task decomposition: alternative methods reduce a task into prerequisites until an executable leaf is found. The University of Maryland's SHOP project describes that general pattern; it is conceptual background, not a dependency or a claim that Clawscape implements SHOP. [External reference B, below.]

The new skill is a reasoning contract, not an executor. A compatible skill format does not establish that this Bun game runtime discovers, loads or follows it. Runtime changes are required. The YAML/Markdown packaging follows the basic Agent Skills file structure; no client-specific installation path is assumed. [External reference A, below.]

## 2. Separate strategic possibilities from immediate dispatch

Maintain three independent questions for every method:

1. Is its world rule known and applicable to this server/profile?
2. Can this agent become ready through supported prerequisites?
3. Is the next leaf dispatchable in the fresh scene?

A low skill or distant facility can make a route **achievable after preparation** without making it **ready now**. Do not discard it before prerequisite planning. Conversely, a missing anvil executor is an implementation gap, not an invitation to train forever.

Suggested evaluation states are `ready`, `needs-preparation`, `needs-information`, `temporarily-unavailable`, `implementation-gap`, and `prohibited`. Preserve multiple blockers together. A branch with both a training gap and a missing final executor must not appear executable merely because its training step is available.

Keep numeric and boolean world conditions typed. Do not use zero as the default for an unknown skill, price, risk or flag. Use explicit AND/OR requirement trees. One satisfied OR branch must not inherit blockers from the rejected branches.

## 3. Model outcomes, not hand-authored errands

An objective needs an ID, purpose, actor, world/profile revision, structured target, evidence references, urgency, budget, creation time, review trigger and lifecycle status. Its origin should distinguish self-selected, explicit user direction, derived prerequisite and legacy seed.

Suggested target categories: an exact item quantity in a specified container; an adequate quantity from a validated set of substitutes; a skill threshold; a verified access condition; a tested readiness condition; or information sufficient to choose a route. These are design categories, not new commands to dispatch.

Use the same resource planner for all item needs. Individual preferences rank suitable alternatives but never create private copies of recipe truth. A shared catalogue is not a shared bank and does not give the Director permission to command other agents.

For every subgoal record parent ID, approach ID, the requirement it discharges, source references, current state, stopping predicate and budget attribution. A human-readable explanation should answer: “Why am I doing this now, and when will I stop?”

## 4. Estimate entire approaches

The existing planner's per-method sorting and first-feasible return do not establish the best end-to-end approach. Compare a bounded set of complete candidate approaches or supported milestone plans, including preparation cost. Bounded beam search, memoized alternative expansion or another tested approach can be used; the technique is an implementation choice.

Rank with a documented utility combining goal satisfaction, preparation/execution time, spend, risk, uncertainty and justified future usefulness. Keep hard constraints outside the score. Do not let role affinity or an XP bonus override a build cap, missing executor or expenditure ceiling.

Expected repeated use can justify training, while urgency can favor immediate purchase or a cheaper substitute. Compare mixed approaches too: buying one intermediate item does not require buying the whole product, and choosing a production route does not require gathering every ingredient.

Estimates must preserve units and provenance. Do not claim optimality when some alternatives were pruned or costs are unknown. Unknown travel, drops or readiness should produce uncertainty or a supported information step, not a free method.

Use hysteresis: keep a sound current approach through small estimate fluctuations, but review it when relevant evidence changes or its budget is exhausted. Previous expenditure is evidence for future estimates, not a reason to continue a bad plan.

## 5. Connect XP-producing actions to skill requirements

The inspected source adapter records `level:<skill>` requirements and emits `xp:<activity> = 1` as a projected activity flag. That flag must not be used as actual XP yield. Obtain XP-per-action, skill thresholds, quantities, success conditions and any relevant server multipliers from authoritative data or verified observations.

For a target skill threshold:

1. Read the current verified level and XP; resolve unknown state before making precise forecasts.
2. Find training actions currently permitted by skills, equipment, access and build rules. Search beyond ingredients of the desired end item.
3. Resolve those actions' material, tool, money and travel prerequisites with the same planner.
4. Forecast bounded batches and useful byproducts. Derive simulated level unlocks from the XP model rather than assuming every action adds one level.
5. Execute the next supported batch and measure actual XP, output, losses and time.
6. Replan at milestones, failure or changed resources; resume the parent when the relevant threshold is met.

Do not weaken global search limits to materialize thousands of identical actions. Represent a training milestone strategically, dispatch a bounded next batch, and retain an honest total-cost estimate. Re-evaluate long-horizon feasibility rather than asserting the entire future is guaranteed.

If the skill model or training action is unsupported, emit a specific gap. Do not invent a level-up action to make recursive planning succeed.

## 6. Account for resources across the whole plan

Reserve consumables once across sibling prerequisites. Reusable tools are required but not consumed unless the source says otherwise. Treat carried, equipped and bank items as separate states. Avoid double-counting alias facts for the same physical items.

One activity can produce both XP and an item: credit both effects, but pay for the activity once. Value resulting gear or ingredients only where they have evidenced utility or a legitimate collection goal. Place explicit limits on speculative surplus and resale assumptions.

Detect bootstrap cycles such as needing ammunition to obtain the only proposed ammunition source, or needing a tool to produce that tool. Resolve through a supported alternative or report the cycle. An unknown alternative is not a free input.

## 7. Make stochastic acquisition and combat readiness explicit

Drop quantities are estimates until an item is actually received. Use source-appropriate probability/quantity information and conditions, with bounded attempts, supplies, losses and elapsed time. Do not promise that the expected number of kills guarantees the requested quantity. Independent drop rows, exclusive branches and conditional tables must not be naively merged.

Use relevant observed combat performance and supported predictions to assess readiness. A failed trial should distinguish inadequate supplies, equipment, tactics, access, code failures and poor evidence. It should not automatically become a fixed “gain combat levels” instruction.

Cooperation is a candidate only where supported server behavior and executors can deliver it. The design requires a request, explicit acceptance, actor-specific budgets, coordination, withdrawal conditions and valid outcome ownership. Do not presume a party system, shared drops, multi-combat access or free player trading. Record missing cooperation support as an implementation gap; no other agent is required to abandon its own goal.

## 8. Replace bootstrap intent with justified selection

The supplied code contains named seed routes that can be reintroduced into knowledge and generated as survey candidates. Removing only one saved goal will not generally fix that mechanism.

Use a generic, versioned migration and generation rule:

- Keep source-backed places and recipes as knowledge, with evidence and world/profile identity.
- Remove the rule that a bundled destination inherently deserves an objective or bonus priority.
- Generate a route goal when selected for a current resource, access or information purpose, or deliberate bounded exploration.
- Mark old seed-derived intentions for re-evaluation. Preserve true user-issued active directions unless explicitly superseded.
- Reconcile pending actions before retiring their goals. Archive stale intent records, their reason and migration version; do not wipe experience, maps or character state.
- Make the migration idempotent and prevent startup from reintroducing retired mandates. A previously known place can be selected again for a fresh reason.

Do not solve this with a blacklist of one fishing destination or by removing all exploration. The source audit names the old entry for diagnosis only; the planning skill deliberately contains no destination-specific rule.

## 9. Persist, attribute and reconsider

Use existing durable goal and receipt mechanisms. Add statuses only with explicit migration and all consumers updated. Suggested subgoal statuses include proposed, active, waiting, achieved, cancelled and blocked.

Verified progress toward a training subgoal is real preparation progress even without parent-item progress. Record it against both lineage and cumulative parent budgets. A new plan, subgoal, consultation or restart must not erase spent resources or reset risk limits. Do not count movement, repeated logging or consultation alone as skill progress.

When the parent is met by an alternative event, cancel obsolete training and material subgoals. A development project may continue only if independently reselected with a fresh purpose. Preserve learning about measured effectiveness, not a permanent instruction to repeat the old route.

## 10. Local reasoning and model boundary

Ordinary dependency expansion, numerical checks and route validation should run in code. The optional local advisor can compare difficult long-horizon tradeoffs or suggest combinations from supplied method IDs. It should not be necessary to call a model for every action or wait for a ten-minute stall before recognizing a straightforward missing prerequisite.

This is a proposed trigger change, not a claim about the current consultation schedule. Any advisor output must be schema-validated, tied to an observation/profile revision, bounded in size and rechecked before dispatch. Invalid, stale or unavailable model output must not block the deterministic planner from using a safe known method. Paid consultation remains permission-controlled.

Expose a concise decision summary: parent target, chosen approach, rejected alternatives with decisive reasons, subgoal chain, next registered method, progress evidence and review/cancellation conditions. Do not require hidden model reasoning or treat fluent prose as proof of feasibility.

## 11. Existing integration points to extend

| Uploaded module | Proposed responsibility |
|---|---|
| `src/agency/director.ts` | Compare full approaches, preserve lineage, plan bounded milestones and review their value. |
| `src/agency/types.ts` | Typed prerequisite/blocker states and persistent subgoal contract; migrate readers/writers together. |
| `src/agency/source-methods.ts` from integration patch | Expose known strategic recipes and typed requirements separately from immediate local readiness; real XP effects must replace activity markers for training forecasts. |
| `src/agency/world-model.ts` and `development.ts` | Generate relevant current-level training and information opportunities while respecting explicit build restrictions. |
| `src/agency/acquisition.ts` and source actions | Reuse supported acquisition/navigation behavior; connect missing adapters without a second control loop. |
| `src/agency/reconciliation.ts`, `progress.ts`, `live-adapter.ts` | Reconcile pending actions, attribute temporary-goal progress and retire stale intent safely. |
| `src/agent.ts` route seeding | Remove automatic intention/priority from bootstrap routes; keep justified location facts. |

These are verified module names, not a claim that the proposed implementation is already present. Astra needs its own executor contract reviewed before applying this design to it; the uploaded source report explicitly excludes it.

## 12. Acceptance scenarios — specified, not executed

1. An unmet skill prerequisite yields a bounded, currently trainable temporary goal when development wins the route comparison.
2. A cheaper or more urgent purchase beats a long training chain where appropriate; there is no fixed shop-first rule.
3. Repeated demand and useful outputs can justify training despite a cheaper one-off purchase.
4. Lower-level training recipes outside the target product's ancestry are considered.
5. Owned or purchased materials avoid unnecessary training in a related gathering skill.
6. Explicit build restrictions are never silently relaxed by a prerequisite chain.
7. A missing executor remains an implementation gap, even if its character-level requirements could be trained.
8. Unknown membership, access, skill or price is not treated as true, false or zero by default.
9. OR alternatives do not become mandatory siblings; one reusable tool and one physical material stack are not counted multiple times.
10. Productive XP receipts advance the temporary goal without falsely completing the parent or triggering a false stall.
11. Completing the parent through another source cancels unnecessary descendants.
12. Failed combat leads to evidence-based alternatives; recruitment requires support and actual consent, with timeout/fallback.
13. Random drops do not become guaranteed rewards after an expected number of attempts.
14. Cycles and bounded-search exhaustion are reported distinctly from definitive impossibility.
15. A legacy seeded destination receives no goal merely from presence in a dictionary, including after restart; legitimate new exploration remains possible.
16. Migration is idempotent, preserves pending-command reconciliation and does not erase factual knowledge or learned experience.
17. Local advisor suggestions cannot invent IDs, change observed facts or bypass executors, and model failure leaves a deterministic fallback.
18. Two agents can choose different valid approaches from the same factual catalogue, while another agent's inventory and consent remain independent.

Stage implementation in shadow mode first. Require scenario tests and then one bounded end-to-end live pilot with verified parent and child progress before widening execution. This package contains no installer, implementation code, activated settings or claimed passing runtime tests.

## External references

A. Agent Skills, official specification; used only for packaging conventions. Retrieved 2026-09-22.

```text
https://agentskills.io/specification
```

B. University of Maryland, Description of the SHOP Project; conceptual background on recursive task decomposition and alternatives. Retrieved 2026-09-22.

```text
https://www.cs.umd.edu/projects/shop/description.html
```
