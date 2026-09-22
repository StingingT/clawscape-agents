# Astra controlled live release — 7 September 2026

This supersedes the v0.1 blanket live-dispatch block only for the explicit
`live_control: local-single-controller` configuration. The owner approved that
limited control model in this conversation. Authoritative server fencing and
spawn generations remain unavailable; other programs must not control Astra.
The read-only ClawscapeObserver still rejects all writes. LiveAdapter requires
one-use arbiter authorization and maps a strict Intent to ordinary owner CLI
actions. There are no admin actions or game-save edits.

## Verified live evidence

- Ordinary owned character `astra` created on https://clawscape.xyz.
- M1 bounded pilot, 2026-09-07 21:54:04–21:54:27 UTC:
  design modal 3559 accepted; movement (3094,3106,0) -> (3096,3106,0)
  observed; visible RuneScape Guide dialogue opened via the published option.
- The pilot revoked its lease and verified `CONTROL_REVOKED` for an old
  command before any further dispatch. Three gameplay actions had verified
  effects; zero failures and zero deaths; HP remained 10/10.
- Evidence: ignored `data/astra-live/journal.sqlite` action checkpoints,
  observations, events and `live_acceptance` records. `status.json` is only
  the most recent snapshot, not an immutable acceptance report.

This establishes a **limited M1 player-action pilot**, not server-side fencing,
all player-action parity, a complete training loop or successful M2–M5.
Each later trial must retain its actual observations and limitations.

### Second trial and historical guard-area blocker — 8 September local time

2026-09-07 22:07:43–22:09:19 UTC: the actual Guide flow completed and Astra
arrived in Lumbridge (3222,3222). Thirty-seven commands had verified effects,
with zero dispatch failures, zero deaths, and no unresolved journal command.
The supply trip reached (3110,3228), where a public damage event removed 2 HP.
An observed level-26 Jail guard was in combat three tiles away. Astra's unknown
threat stop fired and ordinary disconnect read back `connected:false`, HP 8/10.
This is evidence for the automatic stop, **not** evidence that stopping is a
general combat escape or that the supply loop is complete.

Jail guards now have a conservative route exclusion,
corroborated against m48_50 spawns and the local NPC wander/maxrange settings.
The revised southern fishing approach is (3088,3226), not (3094,3226).
Normal restart from a saved danger location is refused before connecting
(`KNOWN_HAZARD_RECOVERY_REQUIRED`). The subsequently implemented separate
recovery mode is described below; do not repeatedly reconnect or loosen the
normal safety gate.

**M2–M5 remain incomplete.** No live fishing/cooking/combat/bank round trip or
live comparison against the other characters has been demonstrated. The live
policy implements these behaviours and encounter learning, but synthetic tests
and the partial supply trip do not establish end-to-end success.

Validation at that checkpoint: TypeScript, 202 tests/756 assertions, and the synthetic
four-checkpoint evaluator pass. `scripts/check-live-routes.ts` checks the normal
southern supply route and rejection of an origin inside the new danger area.
The offline probe passed: 54 exact legs to (3088,3226), with the current danger
origin rejected. The initial Black Knight blanket rectangle blocked the entire
shore approach and was not released: source type 178 has default huntmode -1,
whereas the aggressive Black Knight is a distinct configuration. This is local
compatibility evidence, not online revision parity or permission to fight it.

### Recovery implementation and current blocker — 8 September, 01:06 local

See [recovery validation](RECOVERY_TEST_RESULTS.md). A separate `recover` mode
checks the offline route before connection, retains one arbiter owner, allows
only healing/interface-close/exact egress moves, and bounds time/actions/retries.
The complete suite now passes 237 tests and 850 assertions. The existing normal
hazard-route rejection remains intact.

The one supervised recovery login found Astra at (3223,3219,0), 10/10 HP, with
only a bow, sword and shield. It stopped at `RECOVERY_LIVE_START_CHANGED` with
zero gameplay actions and verified logout. This is evidence for refusal of a
stale plan, not for a live escape. The one-shot recovery authorization is consumed.

A subsequent normal run confirmed the new blocker: no small fishing net or
food and no implemented tool-acquisition route (`MISSING_TOOL_ROUTE`). Astra is
offline. Do not enable purchases or claim continuous play to get around this.
The old and new snapshots do not establish when or why his inventory changed.

## Run and control

From this directory, use the configured Bun executable:

```powershell
& 'C:\Users\guyro\.bun\bin\bun.exe' src/live-cli.ts observe
& 'C:\Users\guyro\.bun\bin\bun.exe' src/live-cli.ts run --seconds 900
& 'C:\Users\guyro\.bun\bin\bun.exe' src/live-cli.ts status
& 'C:\Users\guyro\.bun\bin\bun.exe' src/live-cli.ts pause
& 'C:\Users\guyro\.bun\bin\bun.exe' src/live-cli.ts stop
& 'C:\Users\guyro\.bun\bin\bun.exe' src/live-cli.ts takeover
& 'C:\Users\guyro\.bun\bin\bun.exe' src/live-cli.ts hard-disable
```

`resume` releases soft/manual control but never clears hard-disable. Start a
new bounded `run` explicitly. Maximum configured session duration is 15 minutes;
no paid models, NPC spending, PvP, player trading, dropping or forum posting.
Normal end attempts logout and reads back state; a manual takeover retains the
session. Neither stopping nor logout requests guarantee safety or successful logout.
Do not run the old simulation controls to operate the live controller.

## Verification and limits

Run `bun run check`, `bun test`, and `bun run evaluate`. Evaluation remains
synthetic and must not be reported as a comparison with ClawScout/Stinger.
Live sessions record partial episodes (`full_trip: false`); they do not update
the existing full-trip estimator until a comparable full loop is demonstrated.

Routes use the existing collision SDK in a persistent worker, not another game
connection. Exact short legs preserve turns, stop at crossed gates, use observed
Open options and require actual endpoint observations. A public area hint may
resolve to an approach at most two tiles away; this is explicitly NOT proof of
using a bank/tree/spot. Failed approaches cool down, never silently succeed.
The initial area is surface-only and excludes wizards and jail guards. No stairs,
tolls, dungeon entry, quest solver or unrestricted dangerous exploration is released.

Source compatibility checks rejected the modern Lumbridge swamp net-fishing
lead: the local upstream fishing notes explicitly record no such spots here.
Draynor Net/Bait and non-quest cooking sources need observed confirmation.
The castle Cooking range is quest-gated and is not a default food source.

The NPC safety model is limited to audited low-level variants, with a conservative
damage allowance and food reserve. Unknown attackers are not assumed safe.
Supply/encounter interruptions and uncertain actions must remain in the journal.
Timeout is never an automatic retry of an inventory transfer or item use.
