# Persistent strategic goals, support plans and development trials

## What this change does

The standard agents now persist an explicit hierarchy:

`development strategy → strategic objective → support goals → plan → methods → actions`

The shared `src/agent.ts` loop uses it, not just isolated policy tests. The existing navigation, supply, gathering, production and combat executors remain responsible for actual game commands. Existing survival, character ownership, spending, pending-intent and PvP gates remain in force. No new paid API call is introduced.

### Correction to the earlier log diagnosis

The prior diagnostic command printed the legacy `agency-memory.json` alongside current logs. Those historical records contain per-click `action:*` goals and synthetic million-GP budgets. They are not the active planner's state. Before this patch, the live entry point already selected goals through `agency-v2.json` and used observed balances. Finding the old values in an archived file did not establish that those defects had returned.

This patch does not erase history or rewrite it as successful. It makes the distinction explicit in the read-only status command and adds regression guards against synthetic goal predicates and invalid wealth.

## Goal persistence and preparation

A temporary method failure records a blocker and method cooldown; it does not immediately discard the strategic objective, reset the money budget, or replace the objective with the next available action. A bounded attempt may still end when its time/resource/risk budget expires, with a recorded review and reason. This is not permission for endless repeated attempts.

Every planned prerequisite has a persisted parent ID and an observed completion predicate. Examples:

- Improve Ranged through a measured encounter trial.
  - Obtain the required cooked-food reserve.
  - Obtain compatible ammunition and equip a usable weapon.
  - Execute the encounter method, with fresh style/build validation.
- Complete a production batch.
  - Acquire its materials using the existing production executor.
  - When an actual shop quote shows insufficient carried money, access own bank funds.
  - Withdraw only the required amount from a fresh bank observation, return, and buy.

Some preparation remains implemented inside the existing domain executors rather than a complete generic recipe planner. Dynamic funding and declared method prerequisites are explicitly parent-linked; this is not full-game capability discovery or a complete boss planner.

Blocked objectives may create a sourced exploration/investigation support goal. The investigation can finish without completing or replacing its parent. Missing prerequisites remain outstanding. Completed preparation is not counted as combat/production success. A walk or interface closure is an action result; only the objective's own fact can complete the objective.

## Retry memory and unresolved actions

Semantic step keys exclude ephemeral command IDs and NPC instance indices. Completed, rejected and interrupted steps have separate records. Interrupted steps are uncertain, not rejected or permanently blacklisted. Cooldowns are bounded; verified learning or a changed capability context can make an approach eligible earlier. An unknown pending execution is different: learning does not authorize replay of a command whose effects remain unsettled.

Automatic quiet-state retirement is deliberately narrow: movement, retreat, interface closure and combat-style setting. It requires at least 30 seconds of connected, alive, explicitly idle observations with stable accounting, actor, life and world context. A restart, stale tick or changed state resets the window. Closure/style actions also require the relevant current interface/style state. Retirement means **interrupted**, never original success.

There is no generic timeout clearance for purchases, bank transfers, production, dialogue selections, pickups or NPC/object interactions. These can have persistent effects. They still require attributable evidence. Consequently this patch does not claim to fix Featherer's particular unresolved command without inspecting its current receipt and operation.

## Money

The planning budget uses verified carried coins and, only while a bank is observed open, its verified coins, minus the working reserve. Previously seen closed-bank balances are planning leads, not spendable money. An actual shop action can spend only carried coins after preserving the reserve. Withdrawal is an explicit support method, not an imaginary credit.

Newly verified funds may expand the objective's total funding ceiling with a receipt; prior spending never resets. The same observation does not repeatedly add money. A funding support target reserves that working cash against ordinary redeposit. Quantities must be finite nonnegative integers; invalid balances do not become a fallback allowance.

## Self-selected development strategies

The role and build option are hints. `build-guides.ts` now contains sourced Ranged/Magic, rune-melee, ranged/melee and conditional dragon-weapon one-Defence variants. The selector uses observed base levels, exact XP, styles, equipment and access capabilities. A 2+ Defence character is not labelled a one-Defence pure. Existing v1 restrictions are retained during migration, never silently relaxed.

Prayer is a separately capped choice (1/13/31/43 are guide leads). Attack milestones for rune/dragon variants are 40/60. Guide thresholds are not a verified server XP formula. Capped training and XP-bearing rewards require matching local rules/effect bounds; without them an affected action is blocked, while known uncapped methods remain candidates. Consult `docs/BUILD_GUIDES.md` before enabling capped or reward-bearing experimentation.

All observed style components and protected XP are checked at dispatch. Reaching a cap stops further training in that skill. Three costly encounters no longer abandon a pure automatically: they trigger a review of reversible alternatives. Automatic irreversible cap expansion or respecialization from loss count alone is not supported.

Training leads feed the existing source-resolved catalogue. They never supply invented NPC IDs, coordinates or guaranteed XP/hour. Personally unverified dungeon/safespot/rock-crab leads remain investigations until content and executor gates can be established.

## Current-state diagnostics

From the repository root:

```powershell
bun scripts/agency-status.ts
```

Or pass `--root` with the repository directory. It reads files only: no login, commands, settings changes or journal mutation. It reports the standard agents' active source, observation age/connection flag, strategy, objective, support goals, method, budget and pending action. ClawScout correctly maps to `data/online`; the other profiles map to their names. Legacy recovery is labelled separately. Historical `agency-memory.json`, credential files and full inventory snapshots are not dumped.

Process status is not proof of an online character. A current observation and advancing verified progress are the evidence needed. The command may show a stale last observation; it does not invent a heartbeat. Astra's separate SQLite/startup recovery remains outside this command and this patch.

## Compatibility and rollout

New fields are optional additions to the existing v2 document; existing goals, pending intents and knowledge stay in place. No automatic file copying, journal deletion or blanket action reset occurs. Older valid active objectives acquire support plans from fresh observations. Untyped or missing action outcomes remain protected.

This changes the standard entry point and shared Director/LiveAgency. Astra also imports those shared modules, so existing advanced regressions are included, but **Astra's historical SQLite dialogue/movement reconciliation is not modified**. No server code, authentication, remote character or live process was accessed. Nothing here implements social parties, full-game coverage, automatic model spending or continuous online model training.

After the PR is merged, stop the existing sole supervisor, preserve local configuration/journals, pull, run local tests and restart once. Do not run a second controller to bypass an unresolved action. Read current diagnostics rather than old planner-memory dumps.

## Verification

The original hierarchy patch (before the researched-build revision) was tested offline with Node 22.16.0 and Bun 1.3.10:

- 136 Node policy/integration tests passed (25 more than the baseline).
- Nine executions of the actual shared episode with simulated game I/O passed. Added cases select a Ranged objective before preparation, retain linked food support, and either execute a permitted style or refuse mixed Defence XP without completing the goal.
- 57 focused native Bun navigation, outcome, training and advanced-controller tests passed.
- Scoped strict TypeScript, controller parsing and goal-first structural checks passed.
- Full local native comparison: baseline 409 passes / 14 failures / two module-load errors; patch 434 passes / the same 14 failures / two errors. Those unavailable upstream/map fixture failures are not new successes and the full local suite is not green.

These are not live-server, endurance or full-game learning tests. Existing private runtime data and the currently unresolved live receipts were not available for independent validation.

The researched-build additions and their separate verification scope are documented in `BUILD_GUIDES.md`.
