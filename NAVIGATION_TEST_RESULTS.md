# Navigation test results — 7 September 2026

## Outcome

The collision-route prototype successfully moved CoinCrafter from his stuck
position to Varrock West bank and back, with 12 logs deposited and HP remaining
10/10. The first attempt reached the bank but failed its service assertion.
After correcting the test's bank option, a continuation verified the deposit,
closed the bank, and completed the return journey. This was not a single
uninterrupted first-pass success.

The production navigator remains **unimplemented**. `src/agent.ts` was not
changed. Passing upstream SDK tests does not mean the existing CLI-driven
runners automatically use those SDK behaviors. The navigation skill supplied
the completion criteria: observed arrival, verified service effect, and return,
not merely a successful dispatch response.

## Automated checks

- 10 upstream SDK tests passed, 0 failed, 28 assertions (Bun 1.4.2).
- Covered full/partial paths, repeated partial endpoints, invalid coordinates,
  transient door-block expiry/session isolation, dispatch timeout/disconnect/
  gateway failure, and normal result delivery.
- The new supervised probe bundled successfully with Bun.
- Two additional CLI smoke checks rejected a missing coordinate and plane 4
  before loading the map or connecting to a character.

Command, from `../tmp/clawscape`:

```powershell
& 'C:/Users/guyro/.bun/bin/bun.exe' test ./upstream/sdk/test/walkto-partial-path.test.ts ./upstream/sdk/test/temporary-door-blocklist.test.ts ./upstream/sdk/test/action-dispatch-failure.test.ts
```

## Live evidence

Only CoinCrafter's normal runner was paused. The test reused his existing CLI
connection/account home, with one action owner. ClawScout and Stinger were left
unchanged. All positions below are on plane 0.

| Check | Observed result |
| --- | --- |
| Escape stuck position `(3186,3299)` | Moved south first, following the computed detour |
| Outbound route | 39 planned waypoints, 47 verified movement legs |
| Bank arrival | Exact `(3185,3436)`, 20:48:46 CEST |
| First bank interaction | `Use` opened a banker conversation, not the bank; assertion failed correctly |
| Corrected interaction | Resolved live `Use-quickly` option index 2; bank opened |
| Deposit | Inventory logs 12 → 0; bank logs 0 → 12, 20:49:47 CEST |
| Exit bank UI | Closed and verified before return travel |
| Return | 55 planned waypoints, 58 verified movement legs |
| Return arrival | Exact original `(3186,3299)`, 20:51:01 CEST |
| Safety | Minimum observed HP 10/10; no observed combat, death or respawn |

Outbound actions included opening observed gates/doors near `(3197,3282)`,
`(3241,3301)`, and the bank entrance `(3183,3434)`, followed by continued
movement. The current probe's nearby-door heuristic can also attempt adjacent
gates which are not required for passage. Production handling must associate
doors with crossed edges and verify their state before advancing; these results
do not establish that all obstacle handling is correct.

Evidence journals:

- `data/navigation-tests/coincrafter-2026-09-07T18-47-17-862Z.jsonl`
  — outbound arrival and initial bank assertion failure.
- `data/navigation-tests/coincrafter-2026-09-07T18-49-22-313Z.jsonl`
  — corrected bank interaction, verified deposit, and return; final exit code 0.

## Reproduction

`scripts/test-navigation.ts` is a supervised integration probe, not an autonomous
controller. Default mode reads state and plans without sending actions. Before
using `--execute`, pause the exact character's normal controller and ensure no
in-flight action remains. Resume that controller after testing.

```powershell
& 'C:/Users/guyro/.bun/bin/bun.exe' scripts/test-navigation.ts --character coincrafter --to 3185,3436,0 --execute --deposit-logs --return
```

This requires logs in inventory. If continuing an interrupted test from the
bank, `--return --return-to 3186,3299,0` explicitly retains the original return
destination. Do not present a continuation as an uninterrupted new round trip.

Dependency revision: `d177ab6730ec5166db8d28e73c2d7d3bb3b22a27`.
Collision snapshot SHA-256:
`2e957bc8032690cae7b6a2b549517bb689c48f5bcf366b9a7d13ca73156225cb`.
Cold map initialization took approximately 21–22 seconds; production should
initialize a persistent worker once while keeping safety observations responsive.

## Remaining acceptance work

- Integrate resumable collision-route execution into the shared production runner.
- Test locked obstacles, replanning, oscillation, stale state, restart/cooldown
  persistence, and damage/respawn interruption. SDK mock coverage alone is not
  coverage of these behaviors in our probe or production runner.
- Test floor transitions, semantic service resolution, and alternate-goal fallback.
- Verify ClawScout's full journey and Stinger's shop/arrow/equipment transaction.
- Verify two complete autonomous gather-bank-return cycles. This test deposited
  an existing batch; it did not validate repeated gathering or autonomous banking.
- Repeat live trials before treating a route as generally safe or reliable.

CoinCrafter's original economy runner was restored hidden with its original
arguments at 20:51:18 CEST (PID 20148). Existing logs were preserved; restart logs
are `data/coincrafter/runner.navigation-resume-20260907-205118.out.log` and
the matching `.err.log`. This restore does not install the prototype navigator.
