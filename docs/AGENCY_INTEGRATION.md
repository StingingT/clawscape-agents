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

Role preferences are small priorities. Strategic skill selection uses the actual exposed combat styles rather than a fixed 1-Defence/Attack-40 mandate. Astra's task-specific training can operate beyond its former 40/60/40 ceiling, within the same conservative supported enemy set. The old default target ladders and unused action-first policy have been removed. A standalone training executor now requires an explicitly selected skill task; it does not manufacture a level target.

The shared training selector no longer forces ClawScout to Black Knights or gives the highest tier 10,000 points. A small uncertainty bonus decays with samples; measured performance, danger and route costs can overturn the prior. Existing minimum residence, supply, source-matching and collision checks remain.

## Facts, budgets and learning

Personal inventory quantities are summed, including separate slots for unstackable food. Bank stock is the last personally observed snapshot, not another agent's knowledge. Skills use base levels for capability context and actual XP for progress. Context includes stable skill buckets, equipped items and owned tools, not every tile, tick or consumed meal.

Spendable money is observed carried coins minus the configured reserve. There is no million-coin allowance. Completed comparable task reviews provide spend estimates. Before a comparable trip exists, a zero estimate is only an uncommitted minimum: a purchase must obtain a fresh item/quantity/stock/price check and fit both remaining task budget and current spendable cash. Successful purchases are charged from the observed payment. Purchases currently execute one quoted unit at a time to avoid assuming a flat bulk price.

Combat is a bounded method, not a social action. The actual NPC menu option determines whether an action is an attack. Player attacks and unverified player-transfer operations remain denied. Missing combat loss valuation is **unknown**, not zero risk.

Configure `agency-policy.json` in each shared profile's data directory, or the selected runtime's `data/astra-live/` for Astra. Supported settings are:

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

Legacy reconciliation is an execution-safety rule, **not a progression objective**. The controller automatically archives old advisory `agency-memory.json` movement/read-only intents under an exclusive owner, retaining the original file with a content-hashed backup. It does not claim success or use that unknown result as learned evidence. Uncertain purchases, eating, crafting and transfers still require their actual effects; they are never cleared by a timeout.

### Navigation step versus route commitment

The receipt now stores the exact dispatched waypoint or door interaction **before** transport, in addition to the original route action. Verification uses that subcommand's before-state and destination, including across restart. A verified leg can move away from the final target or leave its straight-line distance unchanged. It releases the step receipt while the unfinished quantitative goal remains active. Only actual arrival satisfies a route goal.

No-dispatch map loading/replanning is `deferred`, not an unknown mutation, a success, or a failed method. Explicit route rejection is terminal. An old sent movement with no usable leg metadata can be superseded after the bounded wait and two distinct stationary, same-life/same-plane, unthreatened observations. This rebases a replaceable movement command without claiming arrival or replaying it. It never applies to economic or production commands.

A production dialog can remain unchanged while Make-All executes. For the selected production option, consumed inputs plus new output plus production XP verify the step. A clock tick, inventory reordering or an unrelated dialog option is insufficient. The observed Fletch inventory option can also verify by opening its production interface.

## Astra startup and runtime paths

The supervisor launches `bun scripts/astra.ts run`. This dependency-light entry point publishes a status **before** loading the advanced controller. It resolves runtime files separately from the source directory and checks configuration and map resources before login.

From the repository root, the diagnostic command is:

```sh
bun scripts/astra.ts doctor
```

It makes no game command or paid API call. Runtime selection uses `--runtime-root` / `CLAWSCAPE_ASTRA_HOME` first; otherwise the packaged configuration, or the existing sibling `../clawscape-autonomous-agent/config.local.json`. `--config` may select a specific configuration location. `--data-dir` / `CLAWSCAPE_ASTRA_DATA` and `--profile-file` / `CLAWSCAPE_ASTRA_PROFILE` permit explicit paths. Configuration-relative `cli_home` is resolved relative to the selected runtime root. Existing state is reused, not copied, erased or silently replaced.

Set `CLAWSCAPE_UPSTREAM` to the complete matching local server checkout when it is not at a recognized location. Navigation, recovery workers, catalogs and metalworking use the same resolver. An explicit bad path is reported rather than silently substituted. A GitHub repository URL alone is not a local SDK/collision checkout, compatibility profile or authenticated account configuration.

`data/supervisor/astra-startup.json` points to the resolved runtime and contains the stage, PID, issue code and safe repair hint. The runtime also gets `startup-status.json`. The supervisor only accepts status from the current launch. Raw credentials, configuration values and subprocess output are not copied into those errors.

Astra can acquire exclusive reconciliation ownership while old commands exist. It first observes/reconciles the real journal; the arbiter still refuses any new ordinary mutation while pending. Only then does the advisory policy rebase. Missing configuration, dependencies or genuinely uncertain economic outcomes remain explicit blockers. The patch cannot supply absent private configuration or prove that Astra is online without a local live run.

## Validation performed — movement/startup recovery

- 73 Node offline tests, including the actual Navigator plus persistent LiveAgency across detour legs and restart, no-dispatch loading, stationary legacy motion, production dialogs, archival and startup diagnostics.
- Six executions of the actual shared episode with fake I/O: food completion, blocked/unknown/begin-refused no-dispatch cases, and multi-leg detours with and without initial map loading.
- 80 focused native Bun tests for action verification, training, progression/resource selection, Astra's policy, map-worker failure and ownership/reconciliation. Scoped strict TypeScript and entry-point syntax checks pass; both controller entry points and the new launcher bundle.
- Full native comparison: baseline 307 passes, 14 failures and 2 module-load errors; changed snapshot 333 passes, the same 14 failures and 2 load errors. Remaining failures require missing upstream fixtures or pre-existing shared-world test path data. This is not a completely green repository or live endurance certification.

The old fixed resource-quota and Strength-40 test expectations were deliberately replaced with tests for explicit agent-selected needs and uncapped selection. No game credentials were read and no live character was connected during verification. The external server repository was not accessible through the available connection, so server death rules and missing fixtures were not invented or substituted.

## Remaining scope and deployment gate

This change corrects the reviewed integration. It does not implement full-game mechanic coverage, arbitrary natural-language understanding, shared report transport, reciprocal favors, party orchestration, automatic code generation, PvP or paid-assistance approval processing. Public forum work is opt-in (`--forum`), quiet by default. No paid AI call has been introduced.

Astra's code remains packaged under `agents/advanced`, while the supervisor uses the runtime-aware launcher. Both controller families still require their existing local game configuration, CLI skill, compatibility files and upstream collision/content checkout. Those are not supplied by this repository.

Before unattended deployment, use a test character and the complete local runtime to demonstrate resupply → activity → return/review, stale targets, transient errors, process restart and a real evidence-driven change of method. Confirm the local loss policy and inspect any specifically reported unresolved economic journal first. Old safe motion is handled automatically. Maintain a rollback to the prior commit; do not infer live reliability from offline tests.
