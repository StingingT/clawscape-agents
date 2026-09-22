# Astra pure policy sidecar

Updated 8 September 2026. Implementation scope is exactly these new files:

Main integration update: the second live trial found Jail guard damage at
(3110,3228). Main added hazard exclusions and moved the Draynor approach to
(3088,3226). Earlier references to (3094,3226) below describe the initial sidecar
handoff, not the currently released route. See `LIVE_RELEASE.md` for the paused
character and incomplete end-to-end acceptance gates.

- `src/live-policy.ts`
- `tests/live-policy.test.ts`
- `docs/ASTRA_BUILD.md`

The sidecar reads filtered `Observation` values and returns proposals. It does no
I/O, networking, authentication, SDK import, dispatch, process management or game
state editing. It imports only the shared contracts and Zod. Main owns contracts,
observer, live adapter, arbiter, routes, runtime, permissions and persistence.
No legacy fixtures or other implementation files were edited by this sidecar.

## Exact API

```ts
export type LiveDecision = {
  goal: string;
  reason: string;
  intent?: Intent;
  destination?: Tile;
  wait?: boolean;
  blocked?: string;
};

export class LivePolicy {
  constructor(persisted?: unknown);
  next(o: Observation): LiveDecision;
  recordOutcome(
    before: Observation, after: Observation,
    decision: LiveDecision, status: string
  ): void;
  observe(before: Observation, after: Observation): void;
  resumeFromObservation(o: Observation): void;
  setResearchHints(names: string[], evidenceRefs: string[]): void;
  summary(): unknown;
}
```

`new LivePolicy(policy.summary())` and a JSON round trip are supported. The
constructor also accepts the summary's `state` object. Added state fields have
defaults for earlier sidecar checkpoints. Corrupt/foreign state is rejected.
`status` accepts normal arbiter strings and navigator strings such as `ARRIVED`;
status alone never proves an effect. Same-observation `ARRIVED` is not progression.

Main integration contract:

1. Restore the policy, refresh ordinary player observations and reconcile the main
   action journal. With no pending commands, call `resumeFromObservation` when
   session/life/world/profile changes. Unconfirmed policy item effects must also
   reconcile; the method throws `RECONCILE_POLICY_OUTCOME_FIRST` otherwise.
2. Call `observe(before, after)` on each fresh pair, including waiting and action
   endpoints. Call `recordOutcome` for the original decision and actual result.
   Target lock starts a bounded encounter; it is not XP or a completed fight.
3. Call `next` only when the main arbiter permits another proposal. A `destination`
   goes to the main collision-aware navigator. A route action may be attached to
   that decision before recording its outcome; gate changes are recognized.
4. Persist `summary()` after action outcomes, meaningful observation updates and
   session interruption. The sidecar performs no disk writes. Pass a disconnected
   ending observation to `observe` to record an active encounter as interrupted.
5. Honor `blocked` as an explicit terminal behaviour result. Do not reinterpret it
   as successful task completion or repeatedly dispatch an unchanged intent.

The navigation skill was read fully. Its collision/arrival/gate separation informs
this destination handoff. Its old-project runner instructions were outside this
sidecar's scope and were not used. No navigation implementation was added here.

## Implemented behaviour

Health is checked before ordinary work. Known food is eaten at the larger of a
70% health threshold and a conservative three-hit reserve plus one HP. Open
blocking interfaces close before eating. Unknown threats, missing activity,
missing state, death and exhausted emergency food produce explicit blockers.
These engineering limits are not guarantees of survival.

The current attackable NPC target is retained while engaged. Equipment, style,
loot, new targets and supply trips defer until the fight ends, apart from healing
and a genuine skill level-up Continue. Fishing targets do not count as combat.

Tutorial handling accepts the observed design flag, an observed RuneScape Guide
Talk-to action, and published Continue or Yes-prefixed options. The recorded
action establishes provenance even if main calls its goal `pilot-interaction`.
An earlier pilot checkpoint can also recover provenance from the exact visible
RuneScape Guide/skip-tutorial question, an observed Guide, and the bounded initial
Tutorial Island area around 3096,3106. A nearby Guide alone never authorizes an
arbitrary dialogue. Twelve observed transitions bound the tutorial. Unsupported
dialogues block. Generic level-up notices require a recognized skill and exactly
one published Continue option; arbitrary quest choices are not accepted.

The proposed balanced base-level targets are **20 Attack / 20 Strength / 20
Defence**, then **40 / 60 / 40**. The lowest completion ratio selects the next
skill; observations drive this choice. Style indices come from `activity.styles`,
including comma-separated SDK skill names. Supported inventory swords, metal
shields and the starter Wooden shield are equipped using real slots/IDs and
observed Wield/Wear options. Material requirements are conservative catalog
predictions; there is no purchase or two-handed equipment strategy.

Initial encounter predictions are deliberately narrow:

| Exact name | Observed combat level | Predicted maximum HP | Policy max-hit allowance |
| --- | --- | --- | --- |
| Rat | 1 | 2 | 1 |
| Chicken | 1 | 3 | 1 |
| Goblin | 2 | 5 | 2 |
| Cow | 2 | 8 | 2 |

NPC HP/maxHP may be null before the server's first combat update. The policy
retains those nulls and uses the prediction only for this exact name/level
allowlist. Contradictory observed health, unknown levels, occupied or unknown
competition, and other variants do not qualify. Attack requires the published
Attack option. Main must also enforce its compatible-content and safety filters.
This sidecar has not independently imported an audited NPC content-ID allowlist;
it uses observed IDs for actions and learning, never IDs invented from guides.
Unfamiliar monsters are recorded in bounded memory and never attacked.

Reachable entities within five tiles may use the normal adapter's local approach,
including footprints/counters. Greater distance or unknown reachability produces
a navigator destination, not a click on an assumed free occupied tile. Main must
validate the interaction side and any actual gate.

Combat requires at least eight known edible portions and a predicted healing
reserve of `max(24, ceil(max_hp * 1.5))`. Raw food does not count as edible reserve.
Fishing builds a useful raw batch before cooking when healthy, capacity permits,
and a compatible nearby spot exists. Low health prioritizes converting existing
raw food for healing. The supply chain supports observed small nets, Net/Bait
spots, ordinary trees with an axe, tinderbox/log fire creation, compatible cooking
sources, and bounded Cook 1/One/All dialogues. Fishing/cooking/woodcutting/firemaking
requirements are checked against observed skills. Generic item Use and ground
pickup are mapped adapter capabilities, not invented item menu indices. Actual
NPC and dialogue option indices are always taken from observations.

Banking captures the full eligible original batch and fixed pre-bank position.
The actual `Use-quickly` menu is recognized only on an exact observed Bank booth,
using its published index (including index 2); arbitrary Use objects do not qualify.
Each deposit/withdrawal uses the current observed slot and bounded quantity;
deposits advance only on exact opposite inventory/bank deltas. Partial or uncertain
transactions block instead of replaying. The batch survives the first free slot
and persistence. Food, tools, logs, feathers, coins, equipped IDs, protected and
unknown/quest items stay. Eligible bank-only clutter includes cowhides, bones,
burnt outputs, ordinary listed materials, unused Bronze dagger/Shortbow/Bronze
arrows and basic starter runes. There is no drop, sell, buy or trade action.
Loot is limited to permitted visible supply/cowhide/bone piles with pickup support.

Three definitely failed/rejected no-effect attempts block a repeated action,
using stable semantic keys rather than snapshot entity refs. Waiting/travel needs
more than two unchanged observations **and** at least twelve seconds/twelve ticks
without relevant progress before blocking. Separate absolute bounds are thirty
seconds for a gathering wait, sixty seconds for other waits/encounters, and 120
seconds for a route proposal. A-B-A-B route oscillation also blocks. Main owns its
25-second action reconciliation deadline, map-worker readiness and session budget.

## Source compatibility and dated research

Public web searches were performed on 7 September 2026, using the
[OSRS Fishing guide](https://oldschool.runescape.wiki/w/Fishing),
[free-to-play melee guide](https://oldschool.runescape.wiki/w/Free-to-play_melee_training),
[Chicken entry](https://oldschool.runescape.wiki/w/Chicken), and
[Fire guide](https://oldschool.runescape.wiki/w/Fire). These suggest early melee and
a net/log/fire/food dependency chain. They do not verify this server's rates,
spawns, access, equipment requirements or damage. Some direct wiki pages refused
fetches; search excerpts were not represented as a full source audit.

**Rejected modern lead:** Lumbridge swamp net fishing at approximately
3241,3154. The full locally supplied compatibility notes, read 8 September 2026,
explicitly contradict that spawn on this server:

- `../tmp/clawscape/upstream/learnings/fishing.md`: use Draynor Net/Bait at
  3087,3230; Net/Harpoon is a different level-16 method. No swamp fishing spot.
- `../tmp/clawscape/upstream/learnings/cooking.md`: quest-free Range near Bob at
  3230,3196; castle Cooking range at 3212,3215 requires Cook's Assistant and is
  excluded. Compatible observed names include Range, Fireplace, Cooking pot, Fire.

Those files were read as compatibility evidence. Their unbounded clicking loops
and invented dialogue index examples were not adopted. Main confirmed the
guarded Draynor approach 3094,3226 and owns exclusion of the dark-wizard rectangle
x=3076..3092, z=3233..3247. The policy rejects fishing spots in that rectangle.
Main also supplied the Varrock West search approach 3185,3436 and bounded
Lumbridge discovery leads: outdoor goblins 3252,3230, chickens 3232,3295 and cows
3253,3272. These coordinates are hints, not proof of arrival or an available
service. Actual interactions require newly observed entities/options. Missing
net acquisition remains an explicit blocker; no free net spawn/tutor is invented.

`setResearchHints` accepts only scoped NPC names, bounds reference storage and
labels them `UNVERIFIED_LEADS`. Names can break baseline ties among already-safe
observed candidates. They cannot invent IDs/coordinates, expand scope or override
safety. `recordedOn` is this integration's date, not a claimed fresh web retrieval;
main retains actual claim retrieval dates in the referenced research records.

## Encounter learning and its limits

`observe` records bounded encounters from the player's own known attack target.
Contexts include world/profile, exact observed NPC content/level, equipment slots
and IDs, melee skill bands and local area. Summary state retains numeric attempt
count, elapsed milliseconds, melee XP, observed net HP loss and food decrease;
confirmed, uncertain and interrupted outcomes remain separately visible. HP loss
is a lower bound on incoming damage when healing happens between snapshots.

An own kill requires an after-start, target-matching public kill event. Because
the current contract lacks an explicit local player index, the source index must
be corroborated by a matching own `damage_dealt` event and melee XP. A different
player's kill never increments confirmed kills. Clear target loss plus XP with
no surviving target becomes `COMPLETED_UNCERTAIN`, not a confirmed kill. Living
targets, target changes, disconnect/death, changed identity and timeouts interrupt.
Delayed and duplicate observation pairs do not double-count the same encounter.

After three comparable completed samples, selection uses the last twenty samples:
`(XP - 2*food - 0.1*observedHPDamage) / seconds - interruption_fraction`.
Weights are engineering defaults, not GP prices. Confirmed and explicitly uncertain
completions are eligible for this heuristic; interruptions remain recorded and
penalize selection. With insufficient evidence, the conservative baseline stays.
Every tenth observed start may choose one under-tested safe alternative within
eight tiles. Learned selection stays local and never seeks unfamiliar enemies.
Changing context uses separate estimates; resume preserves compatible numeric
statistics while discarding old session-bound plans.

These are **encounter statistics**, not complete gather/cook/combat/bank/return
trip measurements, a neural model, or a live learning benchmark. Tests demonstrate
that supplied measured costs change decisions and later measurements change them
back. They do not establish real-world superiority, survival probabilities or M5.

## Verification and remaining boundaries

Commands executed from this project:

```powershell
bun run check
bun test
bun test tests/live-policy.test.ts
```

The legacy evaluator was also executed in memory with only its existing
`Bun.write(...evaluation-simulation.json...)` output intercepted, preserving the
three-file edit limit. Four checkpoints and twenty held-out synthetic pairs per
checkpoint completed; the supplied changed-cost fixture switched method-b to
method-a. This is the existing synthetic evaluator, not a policy live trial.

Final verification on 8 September 2026: strict TypeScript passed. The full suite
passed **201 tests, 751 assertions, zero failures** across four files. The isolated
sidecar suite passed **119 tests, 309 assertions, zero failures**. Existing tests
passed without edits to legacy fixtures. The evaluator result above completed
without modifying its report file.

No sidecar game command or process was launched. Main separately reported a live
M1 design/movement/Guide/takeover pilot; that report is not a sidecar-executed test.
All policy tests here are isolated synthetic ordinary-observation scenarios.
Quest solving, unknown equipment/encounters, tool purchases, tolls, unverified
escape/death recovery, full-trip learning evaluation and broader progression
remain outside scope. Policy code cannot supply server fencing or make a stopped
controller freeze the character. Main's authority/safety/reconciliation gates
remain mandatory.
