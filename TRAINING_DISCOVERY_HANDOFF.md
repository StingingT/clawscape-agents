# Existing-agent training discovery handoff

Implemented 2026-09-07/08 (Europe/Amsterdam), exclusively in `C:/Users/guyro/Documents/Guy/clawscape-agent`. No controllers were started/stopped, no game commands or public messages were sent, and no server files, game saves, existing learning data, or Astra files were edited. Deployment belongs to the main agent.

## Changed paths

Paths below are relative to the project directory above.

- `src/agent.ts`: integrate discovery for **clawscout, stinger, coincrafter only**; remove fixed combat destinations/name-gated training; fresh observation before training dispatch; retain the existing safety/supply/interface/economy priorities and Q-learning. Reuse prepared candidates so learning's bootstrap does not advance the planner twice for one observation.
- `src/training/catalog.ts` (new): reviewed guide catalog, local config/pack/map parsing, source evidence and content namespace.
- `src/training/discovery.ts` (new): persistent character knowledge, feasibility-ranked goals, commitments, bounded exploration, and encounter outcomes.
- `src/navigation/controller.ts`: read-only route assessment; collision/gate-aware retreat; persistent escape target and door retry budget; explicit rejected dispatch and partial endpoint handling.
- `src/navigation/map-worker.ts`: measured collision-zone coverage and object interaction proof; reuses the SDK's cached collision JSON.
- `src/progression-policy.ts`: corrected willow/oak/yew approaches; alternative prepared gathering sites/banks and missing-service cooldowns; remove modern-only combat families from the continuation allowlist.
- `src/training/discovery.test.ts` (new), `src/navigation/controller.test.ts`, `src/progression-policy.test.ts`: regression tests.
- `scripts/check-training-routes.ts` (new): offline production-worker route and source-compatibility probe.
- `TRAINING_DISCOVERY_HANDOFF.md` (new): this handoff.

Build artifact: `.tmp-build/training-discovery/agent.js`. This is a compile check, **not** the deployment entry point; the worker and relative game dependency expect the source layout.

## Guide catalog and actual capabilities

Reviewed on **2026-09-07**: [OSRS Wiki free-to-play melee training](https://oldschool.runescape.wiki/w/Free-to-play_melee_training) and [OSRS Guide ranged training, F2P section](https://www.osrsguide.com/osrs-ranged-guide/). Their early-training suggestions provide family/location hints. No modern guide coordinates, type IDs, XP rates, prices or safespots are imported.

Compatibility is derived from the local `upstream/server/content/pack/npc.pack`, `_unpack/225/all.npc`, and actual NPC sections in maps `m50_51`, `m49_51`, `m50_50`, `m48_53`. Local checkout revision observed: `d177ab6730ec5166db8d28e73c2d7d3bb3b22a27`; local file hashes, not that revision alone, namespace knowledge. Six exact NPC configurations are reviewed: chicken, cow, goblin, goblin_armed, goblin_helmet, barbarian. Seven initial sites cover two chicken farms, two cow fields, two goblin areas and ground-floor Barbarian Village. Map-based labels are advisory; spawn entries supply coordinates/plane. All selected NPC actions resolve their current index and Attack option from fresh state.

At runtime each existing profile writes its own `training-knowledge.json`, containing character identity and separate worlds keyed by local content/guide fingerprint. Existing worlds remain preserved. It records dated monster/resource/service sightings (up to 512 entries), source-linked sites (up to 128), reachability observations, temporary blocks, commitments, and per-equipment/skill-band encounter costs. NPC indices are confined to an active encounter, never used as persistent site coordinates. Matching reviewed monster types observed elsewhere can add sites using the character's observed standing tile. Unknown types are remembered but need catalog review before combat is authorized. CoinCrafter collects this knowledge while continuing economy work; discovery never orders it into combat or exploration trips.

Selection checks health, food, free inventory, skill prerequisites, carried/equipped equipment, compatible quiver and ammunition reserves. It evaluates at most eight sites and three exact source/observed approach points per site, including alternatives when a preferred route is partial. Missing collision coverage is not accepted as a proven route. Reachability is a prediction until observed travel/interaction. Q-learning can select only generated legal actions; it cannot invent destinations or override discovery/safety.

Unobserved discovery trips are limited to two per ten minutes. Empty sites get at most three observation-point visits and a bounded local respawn window (up to 90 ticks), then a five-minute cooldown. Route failures cool down; an unavailable route permits another feasible site. A commitment normally lasts at least three minutes and three productive encounters, with a ten-minute upper bound and a score-improvement threshold before switching. The small approach itinerary is retained across detours/restarts. Safety and changed supplies can interrupt immediately.

Encounter samples accumulate observed combat XP, elapsed action ticks, damage, food/ammunition consumption, productive outcomes, confirmed zero-HP kills, attempted retreats and character deaths. Disappearance alone is never a kill. Sparse samples are blended with an explicit trial prior; measured XP/cost preferences replace that prior after three samples in the same equipment/skill context. An encounter exceeding 180 ticks requests retreat. This is local measured preference, not globally optimal training or a substituted combat-level safety multiplier.

## Prerequisite fixes and offline evidence

Collision snapshot SHA-256: `2e957bc8032690cae7b6a2b549517bb689c48f5bcf366b9a7d13ca73156225cb`.

The willow at source map `m48_54`, LOC `0 39 31`, occupies `(3111,3487)` through `(3112,3488)`. Its former goal `(3112,3487)` is inside that footprint and returns `partial-path`. The new exact goal `(3113,3487)` passes the collision library's rectangle interaction check. Oak/yew alternatives were also corrected and proven, including a negative across-wall adjacency check.

| Probe | Observed offline result |
| --- | --- |
| Varrock West → old willow `(3112,3487,0)` | `Error: partial-path` |
| Varrock West → willow `(3113,3487,0)` | 68 legs; `interactionValid:true` |
| Willow approach → Edgeville bank `(3094,3491,0)` | 25 legs, exact endpoint |
| Varrock West → oak `(3170,3420,0)` | 8 legs; `interactionValid:true` |
| Varrock West → yew `(3088,3480,0)` | 52 legs; `interactionValid:true` |
| Adjacent yew tile `(3084,3480,0)` | Reachable, **`interactionValid:false`** across the wall |
| Chicken enclosure `(3232,3295,0)` → exterior road `(3238,3295,0)` | 1 leg; required gate `(3236,3295)` |
| Seven catalog sites from Varrock West | All have an exact endpoint in the bounded three-point shortlist; zero unmapped tiles |

Stinger now retains the exterior-road escape target and uses normal route/gate handling, including door-state verification, bounded retries, death interruption and cooldown persistence. Retreat no longer dispatches directly between two interior trail tiles. The existing Draynor escape and wizard exclusion remain. General escape outside these regions still depends on a recent observed safe trail.

CoinCrafter can select another prepared woodcutting site when the preferred route is blocked. Missing trees and missing bank services have persistent cooldowns. Reaching a bank coordinate never means banking succeeded; the existing observed-booth/open-interface and transfer verification still apply.

## Actual validation outputs

Executed offline with `C:/Users/guyro/.bun/bin/bun.exe`, Bun 1.4.2:

```text
bun test src
 72 pass
 0 fail
 165 expect() calls
Ran 72 tests across 4 files. [256.00ms]

bun build src/agent.ts --target=bun --outdir=.tmp-build/training-discovery
Bundled 7 modules in 11ms
  agent.js  109.28 KB  (entry point)

bun scripts/check-training-routes.ts
PASS: source compatibility (6 monster types, 7 sites), exact route endpoints and willow interaction. No live actions.

bun scripts/check-map-worker.ts
PASS: fence detour
{"passed":true,"legs":44,"requiredDoors":[],"hash":"2e957bc8032690cae7b6a2b549517bb689c48f5bcf366b9a7d13ca73156225cb"}
{"passed":true,"legs":15,"requiredDoors":[[3101,3258]],"hash":"2e957bc8032690cae7b6a2b549517bb689c48f5bcf366b9a7d13ca73156225cb"}
```

These are unit/mock tests, source checks, a Bun bundle check and offline collision probes. **No live test is claimed.** A route probe proves neither online map parity, actual gate passage, bank transaction, nor combat profitability.

## Deployment by the main agent

### Main integration and live evidence, 8 September 2026

The three existing controllers were replaced one at a time, retaining profiles,
account home, Q tables and their existing forum preferences. No game/server source
was edited. Additional regression fixes migrate legacy interior chicken-pen
retreat targets, continue retreat along the exterior road if a chicken follows,
reject unmapped execution routes, and avoid turning a brief post-hit wait into
a 30-second global discovery cooldown. Lumbridge income travel now uses the
actually observed road tile (3232,3230), not the blocked old (3239,3233) hint.
CoinCrafter's sale trip now targets source-confirmed Varrock shopkeeper
(3218,3415), near its bank, instead of the blocked Lumbridge shop hint.

Live observations: Stinger exited the pen and progressed toward Lowe's Archery;
ClawScout attacked goblins and recorded productive encounters; CoinCrafter
gathered oak, banked/processed inputs and reached Woodcutting 73/Fletching 63.
Later live logs show Stinger bought arrows and equipped his quiver at ticks
28665–28668; subsequent purchase tick 28679. These demonstrate specific actions,
not all future loops. The new sale route, stronger-target selection and profitability still require
their own live evidence. Main suite at this point: 74 tests, 170 assertions.

Subsequent live sale-route validation succeeded: CoinCrafter sold its bow batch
at the Varrock general shop, inventory decreased and carried cash reached 296.
Final readback: CoinCrafter WC73/Fletching63; Stinger Ranged49 with iron arrows;
ClawScout Attack40/Strength86. All three were alive with their normal controllers
running. These changing levels are a timestamped observation, not a standing claim.

Do not run a second controller for any character. When the main agent is ready to replace its existing owner, stop only that owner's normal runner using its existing deployment mechanism, retain each account home/profile, and relaunch from this project's **source entry point**. No data migration, Q-table reset, save editing, or game/server change is required. Existing action-failure cooldowns are retained; a prior willow failure can cause an initial fallback until expiry.

Representative commands for the existing profile layout (each belongs to that character's sole owner; these commands were **not executed**):

```powershell
Set-Location 'C:/Users/guyro/Documents/Guy/clawscape-agent'
$env:CLAWSCAPE_HOME = 'C:/Users/guyro/Documents/Guy/clawscape-agent/data/online-home'
& 'C:/Users/guyro/.bun/bin/bun.exe' src/agent.ts --character clawscout --profile online --role brawler --build melee --forever
& 'C:/Users/guyro/.bun/bin/bun.exe' src/agent.ts --character stinger --profile stinger --role brawler --build ranged-magic --forever
& 'C:/Users/guyro/.bun/bin/bun.exe' src/agent.ts --character coincrafter --profile coincrafter --role economy --forever
```

Keep the existing controller's interval/step settings when replacing it. Omit `--forum` and `--github-learnings`; no publishing is needed for this feature. The guide catalog is local reviewed memory with no autonomous web/model/API calls. Do not overlap these commands with Astra's control of the same characters.

After restart, the main agent should verify actual chicken-gate escape and ammo recovery, a complete CoinCrafter harvest → bank → return cycle, and several training encounters with `training-knowledge.json` evidence. Inspect its selected site/reason, route cost, cooldown and encounter stats alongside the existing navigation and experience journals. Until those supervised checks complete, this change is implemented and offline-validated, not live-validated.

Remaining limits: same-plane routes only; no dungeon/quest transitions, unsupported monsters, magic supply implementation, validated safespots, learned global hazard map, or unrestricted guide search. Encounter accounting covers observed action intervals; offline gaps are not reconstructed. Trial priors and emergency health/food rules remain explicit and conservative. Catalog compatibility fails closed if required local configs/spawns stop matching. The existing food/ammo economy can still need capabilities outside this discovery scope.
