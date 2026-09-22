# Astra v0.1 — release gates and verification

Update: [LIVE_RELEASE.md](LIVE_RELEASE.md) records the subsequent owner-approved
live integration and successful bounded M1 pilot. This document retains the v0.1
baseline; its blanket live-disable and missing-character statements are historical.

This is an initial implementation, not the specification's successful first adaptive release.
No existing agent logic, learning data, process or game repository source was changed.
The original download was not edited; a copy with an implementation addendum is included.

## Current integration — 8 September 2026

- M0: ordinary owned Astra character and working CLI confirmed; no game edits.
- M1: design, movement, interaction and local takeover rejection demonstrated live.
- M2: tutorial completed; earlier supply trip interrupted by a Jail guard.
  Bounded recovery is now implemented and offline-tested. Its live login found
  Astra in Lumbridge at 10/10 HP with missing tools, so it correctly sent zero
  actions. Normal startup stops at `MISSING_TOOL_ROUTE`; full fishing/cooking/
  combat/loot/bank loop is **not accepted**. See `RECOVERY_TEST_RESULTS.md`.
- M3: deterministic live policy, persistence and resource prerequisites implemented;
  unattended continuity remains unproven because M2 is incomplete.
- M4: bounded actual guide retrieval/cache implemented, claims unverified until
  compared with server observations; no guide-derived full trip accepted yet.
- M5: numeric per-encounter learning implemented and tested; full-trip comparison
  and live learning superiority remain unproven. Synthetic evaluation is labeled.
- M6: expanded quests, magic and dangerous content remain deferred.

237 unit tests, TypeScript and synthetic evaluation pass. Offline hazard route
probe passes: 54 exact legs to (3088,3226), hazardous origin still rejected for
normal play. A separate three-leg southbound recovery is collision-checked;
its live escape remains unproven because the actual origin had changed.

## Historical v0.1 milestone baseline

| Milestone | Current evidence | Gate |
| --- | --- | --- |
| M0 source discovery | Audit, local fingerprints, primitive mapping, own build/tests and copied spec delivered | Partial: no normal Astra test character running; game dependency baseline has missing zod |
| M1 observable/controllable | Filtered read-only CLI adapter; synthetic action arbiter and takeover tests | Not passed: live pilot and player-action parity untested |
| M2 full gameplay loop | Synthetic food/move/bank sequence; bank batch and route follower tests | Not passed: combat, loot, resupply, route planning, escape and real trips incomplete |
| M3 autonomous goals | Resource-dependent proposals, observed predicates, prerequisite graph tests | Not passed: not integrated into live or continuous gameplay |
| M4 research | Source-linked evidence schema and untrusted-claim validator | Not passed: no actual retrieval or locally tested guide-derived method |
| M5 learning | Persistent updates, selector, recent-window adaptation and synthetic comparison | Not passed: no actual gameplay episodes or real learning benchmark |
| M6 expanded progression | Disabled | Deferred |

## Verification actually performed

- bun run check: passed, strict TypeScript.
- bun test: **40 tests passed, 166 assertions, 0 failures**.
- bun run audit: passed after correcting the inspected LiteClient source path;
  2,573 content and 557 rule/client files fingerprinted.
- bun run demo: passed; five fixture actions observed, 30 synthetic trip episodes
  added to data/astra-simulation.sqlite, no game/paid-model calls.
- bun run evaluate: four checkpoints, 20 held-out fixture pairs per checkpoint.
  Full report: evaluation-simulation.json.
- Game baseline subset: 4 pass; 1 load failure because zod is missing.
- No engine, browser, live movement, combat, death recovery or online-research trial ran.

## What the tests establish

Contract rejection, filtered observations, stale-session/world/lease rejection, one local
pending action, control preemption, successful-dispatch/no-effect distinction, uncertain
deposit reconciliation, protected food, bank-batch continuation, detour/partial-path/stall/
oscillation handling, prerequisite checks and distinct resource-driven goals.

Learning tests show a later choice changes from method-a to method-b after supplied
complete-trip fixture measurements, and back to method-a after changed-cost measurements
fill the recent window. Episode replay after reopening SQLite does not double-count.
Different equipment or profiles change context keys. Seeded exploration never admits the
fixture's explicitly unsafe method. Evaluation does not mutate the learned policy.

The fixture is intentionally simple. It cannot estimate real death probabilities, teach
RuneScape combat skills, prove equipment superiority, or establish faster game progression.
The learning-disabled planner and scripted baseline are identical in this fixture.
Synthetic paired noise cancels, so narrow timing intervals are not meaningful real-world certainty.

## Remaining implementation

1. Prepare Astra's own test session and complete M1 with source-mapped legal actions.
2. Introduce action-specific live effect attribution and pending-action deadlines/status
   investigation; do not turn timeouts into automatic retries.
3. Add live generation/identity strategy and cooperating-controller enforcement. If strict
   server fencing is unavailable, keep unsupported capability explicit and obtain an
   owner decision before weakening the specification's guarantee.
4. Build collision-aware service routing from approved public/observed information;
   handle doors/planes and prove outward service action plus return.
5. Add supported low-risk combat, healing/escape, allowed loot, equipment compatibility and
   a measured gather/cook/bank/resupply chain. Unknown-threat fallback currently blocks.
6. Wire planning to bounded behaviours with event-driven replanning, hourly/session budgets,
   persistent death counters, blocked-goal cooldowns and concrete operator reasons.
7. Add actual bounded research networking and compatibility evidence; no self-certification.
8. Record real comparable complete trips; run controlled isolated-account evaluations.

Budget fields and model mode are schema/config contracts in this version, not implemented
hourly scheduling or an external model provider. No runtime model inference exists.
The bank batch is in-memory and cannot itself resume mid-behaviour after a process crash;
the underlying pending transaction is journaled and blocked until reconciled.
The route follower consumes already-verified adjacent edges; it does not compute a full-world
route or test live collision. Research claims can be rejected/imported, not automatically
promoted to trusted gameplay instructions.

## Commands and artifacts

See ../README.md for exact PowerShell commands, simulation controls and read-only observe.
Core ownership: contracts.ts -> arbiter.ts -> adapter; store.ts owns durability;
learning.ts is measured method selection; planner.ts supplies goal proposals;
observer.ts is the only game-facing adapter and has no enabled write path.
simulation.ts and scripts/evaluate.ts are explicit test-only facilities.
