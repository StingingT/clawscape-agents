# Astra recovery validation — 8 September 2026

Scope: Astra's independent controller only. No edits to the game repository,
other agents, credentials, account configuration, or game saves. No item grants,
NPC purchases, PvP, or public posts. Existing journal and learning are preserved.

## Implemented

`bun src/live-cli.ts recover` is a separate, one-shot supervised recovery mode,
not a relaxed normal-play hazard filter. Normal `run` and `pilot` still refuse a
last observed position inside a known hazard, whether connected or disconnected.

- Exact approved origin: (3110,3228,0). Exit: (3110,3216,0).
- Map is loaded and checked before login. Local collision hash is pinned; only
  explicitly present collision zones qualify. Actual wall/door flags are kept,
  with doors treated as closed. No conditional gate crossing is allowed.
- Bounded cardinal route, never north/deeper into the guard area. Three exact
  four-tile legs; no repeated points, corner cutting, partial endpoints or planes.
- Saved and fresh state must match the approved start, with at least 8/10 HP,
  zero client respawns and two observed edible starter foods. Live differences
  abort before gameplay dispatch. No assumption that an old snapshot is current.
- Only the existing ActionArbiter dispatches. Recovery allows eating the observed
  starter food, closing an interface and moving along the next reviewed leg.
  The extra restriction runs again on both pre-dispatch snapshots. It never
  authorizes attacks, purchases, transfers, equipment changes or exploration.
- One cooperating local lease, 60 seconds after connection, at most 12 actions,
  five-second action reconciliation deadline, no uncertain-effect replay.
- Death/identity, health, stale/off-route state and ownership checks remain.
  Arrival needs every verified leg plus at least eight advancing ticks and
  three seconds without observed damage at the exact exit.
- The attempt is recorded before connection. Reinvocation cannot repeat it,
  including after a crash. This specific authorization has now been consumed.
  Do not delete journal records or change the recovery ID to bypass that limit.
- Best-effort disconnect and separate logout readback. Manual takeover preserves
  the session for the new owner. Disconnect is not a guarantee of survival.

The navigation skill influenced exact arrival, collision/door separation,
single-owner dispatch and bounded failure handling. It is not loaded by Bun at
runtime, and the old agents' navigator and memories are not imported.

## Offline verification

- `bun run check`: passed.
- `bun test`: **237 passed, 0 failed, 850 assertions**, six files.
  Includes 35 new recovery tests, with synthetic controller/action scenarios.
- `bun run evaluate`: passed, four checkpoints with 20 paired synthetic trips
  each. This remains a synthetic benchmark, not a live learning claim.
- `bun scripts/check-recovery-route.ts`: exact 12-tile, door-free egress:
  (3110,3228) → (3110,3224) → (3110,3220) → (3110,3216), plane 0.
- `bun scripts/check-live-routes.ts`: existing normal southern fishing route
  remains 54 legs to (3088,3226); guard-area origin still rejected.
- Actual normal startup against the old checkpoint still returned
  `KNOWN_HAZARD_RECOVERY_REQUIRED` before login.

Collision SHA-256:
`2e957bc8032690cae7b6a2b549517bb689c48f5bcf366b9a7d13ca73156225cb`.
Collision feasibility is not evidence of online safety or successful escape.

## Live checks and actual result

At **01:05:54 Europe/Amsterdam** (2026-09-07 23:05:54 UTC), the one authorized
recovery login observed Astra in **Lumbridge (3223,3219,0), 10/10 HP**, not the
saved guard-area origin. Inventory contained only Shortbow, Bronze sword and
Wooden shield. Food, net, axe and tinderbox were absent. No claim is made about
when or why that change occurred: client respawn counters restart across client
incarnations and cannot reconstruct offline/server history.

Recovery stopped with `RECOVERY_LIVE_START_CHANGED`, **zero gameplay actions**,
and verified `connected:false`. This live test validates changed-start rejection
and logout, **not** the planned escape, healing, or a completed survival trip.
Astra was not moved back into danger to test it.

A subsequent bounded normal run, 01:06:41–01:06:57 Europe/Amsterdam, connected
at that same Lumbridge position, then stopped at `supply:net-route` with
`MISSING_TOOL_ROUTE`, zero gameplay actions. The missing net has no supported
acquisition route; food replenishment therefore cannot begin. NPC spending
remains zero. Final status: offline, 10/10 HP, no pending actions.

Evidence is retained in `data/astra-live/journal.sqlite` (`recovery_attempts`,
`recovery_results`, `observations_or_checkpoints`, controls and action records),
`recovery-status.json` and the final normal-run `status.json`. These are private
local runtime records; public documentation includes no credentials.

## Remaining work

Recovery implementation and offline tests are complete. Actual egress is not
live-proven because the observed starting state no longer needed that route.
The next distinct blocker is a verified **missing-tool/food acquisition** policy.
Do not claim Astra is playing, repeatedly reconnect him, loosen the food reserve,
authorize purchases implicitly, or mark M2–M5 accepted from these tests.
