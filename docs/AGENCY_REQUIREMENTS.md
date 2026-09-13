# Agent-owned goals: accepted requirements and first implementation

## Owner decisions — 14 September 2026

1. Roles are initial preferences, not classes or permanent skill caps. Agents may develop differently when an actual objective gives them a reason. Stinger can pursue Defence to prepare for a boss; CoinCrafter can pursue combat after collecting known craftable items to obtain items unavailable through crafting. Record the purpose and evidence for changes. Do not require the owner to keep suggesting objectives.
2. Experiments have affordable budgets and recoverable losses. Preserve essential supplies and equipment. PvP is a future objective, but is prohibited for now. Its rules need explicit later approval.
3. Agents are independent players. Friends may receive favors and preferential treatment, with a bounded expectation of reciprocity over time. Promises are not delivery. Each agent independently accepts or declines, retains control of its character and does not wait indefinitely for a partner.
4. Knowledge is individual. Share deliberate, sourced reports through a quiet shared file transport. A received report is a lead, never automatically an observed fact. Do not fill chat or forums with repetitive status messages.
5. Paid API calls are exceptional and approval-only. Persist assistance requests explaining the goal, uncertainty, failed local approaches and evidence. An agent cannot authorize its own spending. A future grant needs an owner-controlled scope, provider, expiry, cost ceiling and call limit. Never put keys in this repository or a shared report.
6. Supported experimentation should grow toward full-game coverage. Use permitted game actions within budgets. When a capability is absent, preserve a development request. Never invent commands, disable safety or rewrite a running controller to escape a blocker.

## Included in this draft

- `src/agency/types.ts`: goal, observation, method, budget, pending-intent and learning contracts.
- `src/agency/opportunities.ts`: derive goals from personal needs, collection gaps, observed unlocks, discovered frontiers and received leads.
- `src/agency/director.ts`: choose a goal before a method, plan prerequisites and consumed inputs, enforce budgets, preserve commitments and evaluate a quantitative goal predicate. Role preferences are small scoring influences, not restrictions.
- Method costs, failures and verified progress alter subsequent selection. Serializable memory preserves that learning and unresolved intent across a restart. Unknown outcomes require reconciliation and never count as failed actions eligible for immediate replay.
- Reasons and evidence are recorded when an agent changes its activity domain. A completed goal is followed by another feasible self-selected goal.
- `tests/agency/director.test.ts`: 23 offline checks, including preparation, repeated productive work, learning transfer, role change, budgets and uncertain outcomes.

## Deployment status: NOT connected to the live controllers

The existing `src/agent.ts`, `scripts/supervise.ts` and Astra controller are unchanged. No production adapter or game-command dispatcher is included. The existing `start` command remains unchanged. Merging this draft alone will NOT make the currently running characters use the new planner, remove their old build restrictions, coordinate parties, understand chat or explore the full game.

Quiet file-sharing, reciprocal-favor, approval-backlog and policy-loop integration modules were prepared separately, but their combined upload was blocked by a safety check. They are NOT in this PR. The block was not retried through another write route. This draft preserves the accepted core planner only.

## Next implementation gate

1. Create adapters for both controller families, using each character's own observations. Distinguish owned items from carried items: banking is not new acquisition. Never copy another agent's claims directly into observed facts.
2. Build a versioned executable-method registry from the working navigation, supply, gathering, crafting and combat routines. Provide consumed inputs, observed prerequisites, bounded risk, estimated cost and duration. Estimated effects are not proof of success.
3. Put strategic goal selection BEFORE the existing early-return action-policy branches. Keep urgent healing, retreat, sole-character ownership and fresh target validation above it. Save an intent before dispatch and reconcile uncertain effects without replay. Do not treat a tick or unrelated inventory change as causal verification.
4. Migrate old pure-build limits explicitly into the new owner-approved preference model. A consequential skill/build change needs a recorded self-selected purpose. Keep PvP denied by the actual command arbiter, not just the planner's risk label.
5. Use meaningful context buckets for equipment, skills and unlocked access. A tick, location change or consumed food must not reset learning or bypass cooldowns.
6. Add quiet report transport with authorship, recipients, expiry, deduplication and rate limits. Reports remain hypotheses for recipients. Add authenticated, typed chat ingestion separately; never execute message text. Preserve source provenance through forwarded reports.
7. Add a bounded expedition lifecycle: proposal, independent acceptance, preparation, meeting deadline, execution, abort and review. Never enable unverified item transfers. Each agent retains its own controller and essential supplies.
8. Add owner-reviewed API requests without any automatic spending. Continue useful local work while a request is pending.

Before enabling live use, demonstrate full resupply → productive activity → return/review cycles for both controller families. Inject stale targets, delayed commands, restarts, depleted resources, absent teammates and conflicting ownership. Compare learned method selection with a frozen baseline under matched conditions. Verify autonomous next-goal selection and meaningful reasons for changing specialization.

The planner bounds search to 48 steps, 12 dependency levels and 512 visits. Long goals need intermediate milestones. It is not an optimal planner: weights are initial heuristics, not tuned server measurements. Storage compaction, report retention, natural-language interpretation, expanded capability coverage and endurance validation remain future work.

## Verification

Run `npm run test:agency` on Node.js with TypeScript stripping. The 23 tests passed on Node 22.16.0. Strict TypeScript no-emit checking also passed for the three new source modules and test file using the container's installed compiler and Node types.

These are isolated policy tests. They are not a native Bun run, whole-repository type check, live-server test or endurance certification. No character was connected, no game command was sent, no paid API call was made, and nothing was merged or deployed.
