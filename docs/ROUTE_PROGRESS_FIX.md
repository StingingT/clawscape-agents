# Route-step reconciliation and obsolete objective cleanup

## Scope and merge base

This repair was prepared against `e14d8f6`, then reconciled with the concurrently
merged startup/journal recovery at `f2c7c8d`. The newer `live-entry.ts`, startup home
selection, recovery leases, conservative journal accounting and worker readiness
fixes are retained, not replaced by a second launcher or migration system.

The server repository `Joostrothweiler/clawscape` returned 404 through the available
connection. No deployed server behavior, local configuration or character state
was inferred from that missing source.

## Movement receipts versus goals

A receipt represents one navigator invocation, not the entire journey. Fresh
same-life, same-plane displacement completes a movement step even when a
collision-safe detour increases the distance to the final destination. A
`progress` string alone is insufficient: coordinates and a fresh observation are
required; a changed session, reset clock or missing coordinates does not verify it.

`agency-v2.json` retains the route's destination, owning goal and method separately
from its pending command. After each completed leg the planner observes afresh and
continues that commitment. Only actual arrival satisfies the route goal. This
works across an agency restart and does not turn three movement legs into three
completed goals.

The navigator explicitly identifies preparation where **no movement was
sent**. Read-only map waits complete as preparation. Pre-dispatch navigation
blocks are interrupted, not successful. Small, command-matched execution evidence
is saved so later reconciliation has the same information as immediate verification.

For a stale movement receipt lacking evidence, two newer stationary idle
observations spanning a 30-second settling window can retire only that receipt as
**interrupted**. No command is replayed and no success or discovery is awarded.
The goal remains subject to its attempt/time budget. This is strictly limited to
movement/retreat; financial, production, food-use and dialogue mutations do not
expire through this mechanism. Active combat, life/plane/session changes or absent
idle evidence prevent automatic retirement.

Astra's action arbiter and policy observer both accept fresh partial movement,
so one layer cannot complete the move while another retains policy uncertainty.
Existing identity, control ownership and collision constraints remain.

## Stinger's production outcome

A production interface may stay open after a successful Make-All click. The
verifier now accepts consumed inputs, increased output and matching production XP
when the selected published option is a production option. Wrong options, clock
changes alone, unrelated inventory changes and insufficient evidence remain
unresolved. The Astra dialogue bridge supplies the correct `optionIndex` field.
This is a supported-production fix, not an arbitrary recipe interpreter.

## Removing old fixed objectives

The unused action-first `candidates` orchestration, generic lifecycle wrapper and
fixed Strength/Attack/resource progression labels have been removed from the
shared entry point. Removed dead named-character Black Knight/lobster mandates and
obsolete equipment-experiment branches. Equipping does not itself select a fixed
training skill: the Director's actual combat task supplies that skill. Astra's
standalone fallback no longer has a 20/20/20 or 40/60/40 terminal objective.

The shared loop still uses the outcome-first Director, supported task executors,
measured method evidence and role preferences. Real skill requirements, supported
mechanic boundaries, survivability checks, resource reserves and finite experiment
budgets are not obsolete objectives and remain enforced.

**Journal reconciliation is not an objective.** The newer immutable backups,
recovery receipts, exact command matching and guarded mutation reconciliation in
`docs/JOURNAL_RECOVERY.md` remain. Do not delete old journals or label unknown
purchases as failed to make a character move. Unsupported/genuinely ambiguous
mutations can still need operator/server evidence.

## Astra startup and local rollout

The supervisor retains the newly merged `agents/advanced/src/live-entry.ts` and
its one-runtime-home selection. It now also includes the exact `.err` log path in
its status. The existing wrapper reports missing configuration/dependencies and
worker failures before gameplay; it cannot supply absent private runtime files.

Select the existing complete runtime home using `CLAWSCAPE_ASTRA_HOME` or
`--runtime-root` when required, and point `CLAWSCAPE_UPSTREAM` to the compatible
**local** checkout, not a GitHub URL. See `JOURNAL_RECOVERY.md`. Keep config, profile,
CLI home and journal together. Do not start another controller beside the watchdog.

After deployment to the host, restart its normal supervisor so it loads the changed
code, then inspect fresh status/log timestamps. GitHub changes alone do not restart
those processes. Check several continued route legs and a productive result per
agent. Astra being online is not claimed until verified from the running host.

## Validation

- 90 Node tests: existing planner, integration and journal recovery plus 15 new
  route/production regressions.
- Six actual shared-episode executions with fake I/O: successful food goal,
  blocked/unknown/begin-refused no-dispatch cases, multi-leg route and map-wait
  followed by multi-leg route. They retain one goal across preparation.
- 55 focused native Bun tests, including real Navigator + LiveAgency route legs,
  restart, map-loading, Astra policy, startup subprocesses and recovery leases.
- Controller syntax/goal-order checks and scoped strict TypeScript checking.
- Full native comparison: latest-base snapshot 341 passes, 14 failures and 2 module-load errors; repaired snapshot 360 passes with the same 14 failures and 2 errors (missing upstream fixtures/shared-world test data).

No live account was accessed, no game command was issued, and no live deployment
or endurance certification was performed. Missing upstream fixtures mean these
focused passes must not be described as the entire repository being green.
