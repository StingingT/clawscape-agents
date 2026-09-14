# Goal-first execution integration

## What now controls the characters

The shared `src/agent.ts` loop and Astra's `agents/advanced/src/live-cli.ts` run mode now use the same `LiveAgency`/`Director` implementation. This is runtime integration, not a logging wrapper around the old selected action. The existing sole-character executors and collision/safety checks remain responsible for actual game commands. Merging does not start or deploy any character.

The order is:

1. Observe the controlled character and reconcile its exact pending command.
2. Generate outcome opportunities from that character's resources, supported skills and sourced route leads.
3. Select a goal and prerequisite method with the Director.
4. Ask only that method's executor for a concrete action; refresh and validate it.
5. Persist the action, original observation and matching command ID before dispatch.
6. Verify the specific effect; record actual post-state, payment and elapsed time.
7. Keep the quantitative goal across preparation, partial results and restarts; review it when fulfilled or boundedly blocked.

Urgent food/retreat has a separate receipt. It cannot replace an unresolved ordinary command. Reconciliation, refusal and unknown outcomes cannot fall through to unrelated normal actions.

## Supported self-selected goals

The shared controller exposes cooked-food and ammunition reserves, equipping usable owned gear, inventory space, observed combat-skill XP milestones, supported production/gathering batches, and personal route surveys. Astra exposes its currently implemented food, equipment, banking, melee and navigation methods, not unsupported purchasing or quest APIs.

A bank opening is preparation, not a completed strategic goal. One catch does not complete an eight-food target. An arbitrary click flag is never used as the goal predicate. Route completion requires the character's observed arrival. Recipes and encounters still execute through the existing bounded domain routines; this is not a universal recipe or quest synthesizer.

Role preferences are small priorities. Strategic skill selection uses the actual exposed combat styles rather than a fixed 1-Defence/Attack-40 mandate. Astra's task-specific training can operate beyond its former 40/60/40 ceiling, within the same conservative supported enemy set. The old policy's default behavior is retained for its standalone callers and pilot mode.

The shared training selector no longer forces ClawScout to Black Knights or gives the highest tier 10,000 points. A small uncertainty bonus decays with samples; measured performance, danger and route costs can overturn the prior. Existing minimum residence, supply, source-matching and collision checks remain.

## Facts, budgets and learning

Personal inventory quantities are summed, including separate slots for unstackable food. Bank stock is the last personally observed snapshot, not another agent's knowledge. Skills use base levels for capability context and actual XP for progress. Context includes stable skill buckets, equipped items and owned tools, not every tile, tick or consumed meal.

Spendable money is observed carried coins minus the configured reserve. There is no million-coin allowance. Completed comparable task reviews provide spend estimates. Before a comparable trip exists, a zero estimate is only an uncommitted minimum: a purchase must obtain a fresh item/quantity/stock/price check and fit both remaining task budget and current spendable cash. Successful purchases are charged from the observed payment. Purchases currently execute one quoted unit at a time to avoid assuming a flat bulk price.

Combat is a bounded method, not a social action. The actual NPC menu option determines whether an action is an attack. Player attacks and unverified player-transfer operations remain denied. Missing combat loss valuation is **unknown**, not zero risk.

Configure `agency-policy.json` in each shared profile's data directory, or `agents/advanced/data/astra-live/` for Astra. Supported settings are:

```json
{
  "reserveCoins": 25,
  "maxLossGp": 100,
  "maxDeaths": 1,
  "maxDurationMs": 1800000,
  "foodTarget": 8,
  "ammoTarget": 50
}
```

These are conservative initial policy values, not measured optimal settings. Add `combatLossBoundGp` only after auditing the recoverable/replacement loss of that character's carried kit under the actual server's death rules. Without it, new combat trials remain blocked while supported safe work can continue. A death with unvalued losses remains an unresolved accounting event; the system does not pretend it was a free trial. Existing server/arbiter safety ceilings may be more restrictive than this task budget.

Learning records preparation separately from productive outcomes, so a verified route/bank step does not become a failed training trial. Actual cost/time evidence and contextual failure cooldowns affect later methods. Successful productive repetition stays committed until the target, budget or stopping condition is reached.

## Command identity and restart handling

`agency-v2.json` atomically contains both Director memory and the exact command receipt. Corrupt or mismatched identity data fails startup instead of silently starting empty. Duplicate result deliveries are ignored; a different command's result cannot finalize a pending receipt. A refusal to begin prevents dispatch.

For the shared CLI, command IDs are local correlation IDs; this patch does **not** claim server-side idempotency support. Unknown outcomes are re-observed against the saved before-state, not re-sent. Astra passes the same ID to its arbiter reservation and matches its result by that ID. Transport failures and post-dispatch preemption remain unknown. A journaled action that was cancelled before dispatch can be recorded as rejected.

Old `agency-memory.json` records with pending synthetic intents and unresolved legacy `action-intent.json` entries are deliberately not discarded or guessed away. Reconcile them against the authoritative server/arbiter journal before enabling the new controller. Archive resolved legacy files; do not edit an unknown outcome to “failed” simply to get the character moving.

## Validation performed

- 57 Node offline tests: 23 existing planner tests plus 34 adapter/outcome/restart/budget regressions.
- Four fake-I/O executions of the actual shared episode function: a multi-step goal succeeds, while blocked, uncertain and begin-refused cases send zero ordinary mutations.
- 35 focused native Bun tests for outcomes, training choice and Astra's actual task-aware policy.
- Scoped strict TypeScript checking for the shared agency, outcome verifier and Astra bridge; controller syntax checks.
- Whole-repository native comparison: baseline 267 passes, 14 failures and 2 module-load errors; updated snapshot 307 passes, the same 14 failures and 2 load errors. These pre-existing failures are missing upstream game/map fixtures or shared-world test data. This is not a fully green whole-repository suite.

Some older tests explicitly required the highest tier to defeat measured performance; those expectations were changed to match the approved learning objective, with an additional regression for costly repeated high-tier encounters. The bank-transfer fixture now supplies the quantity required by the real operation contract.

No live credentials were accessed, no character was connected, no paid model call was made and no endurance run was performed. CI uses pinned Node/Bun and package dependencies and exercises no production game command.

## Remaining scope and deployment gate

This change corrects the reviewed integration. It does not implement full-game mechanic coverage, arbitrary natural-language understanding, shared report transport, reciprocal favors, party orchestration, automatic code generation, PvP or paid-assistance approval processing. Public forum work is opt-in (`--forum`), quiet by default. No paid AI call has been introduced.

Astra's supervisor path now uses the packaged `agents/advanced` directory. Both controller families still require their existing local game configuration, CLI skill, compatibility files and upstream collision/content checkout. Those are not supplied by this repository.

Before unattended deployment, use a test character and the complete local runtime to demonstrate resupply → activity → return/review, stale targets, transient errors, process restart and a real evidence-driven change of method. Confirm the local loss policy and legacy-journal reconciliation first. Maintain a rollback to the prior commit; do not infer live reliability from offline tests.
