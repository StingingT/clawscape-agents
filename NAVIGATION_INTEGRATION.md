# Live runner integration — 2026-09-07

This supersedes the implementation-status statements in the earlier
`NAVIGATION_TEST_RESULTS.md`. That report remains evidence of the earlier
supervised prototype, not a record of the current runner.

## Implemented in the agent, not the game repository

- `src/navigation/map-worker.ts`: one asynchronously initialized collision map
  per runner, preserving route turns and subdividing into at most 12-tile legs.
  Only doors whose restored collision blocks the planned edges are opened.
- `src/navigation/controller.ts`: serialized actions through the existing CLI,
  exact position/plane checks, immediate dispatch rejection handling, bounded
  observation, temporary door blocks/replanning, persisted destination cooldowns,
  and explicit arrival/interruption/blocked status in `data/<profile>/navigation.json`.
- A navigation task remains selected across episode boundaries. It no longer
  repeatedly projects an 18-tile straight hop toward a distant destination.
- Dialogue uses the live option index. Stinger's banker dialogue offered 1 and 2;
  the previous runner repeatedly sent 0.
- Banking prefers `Use-quickly`, finishes remaining deposits after slots become
  free, verifies matching inventory/bank changes, remembers bank contents,
  closes the UI, and returns the economy agent to its retained work location.
- Food/tools and working cash are retained. Depositing is not rewarded as losing
  items. A life/respawn change counts as a death even if no `isDead` frame was seen.
- Gathering filters tree-level requirements and waits through active gathering
  rolls instead of repeatedly interrupting them. Full inventories do not select
  fallback chopping while awaiting a blocked bank route.
- Food recovery can buy/withdraw a missing net, fish with a small net above level
  20, and use raw shrimp on a cooking location with `useItemOnLoc`.
- Basic bows are restricted to compatible bronze/iron arrows; higher Ranged
  level alone does not make steel arrows usable by a basic shortbow.

## Verified live outcomes

With the integrated runner, ClawScout left `(3169,3313)`, reached Varrock West
bank, deposited 8 raw shrimps and 4 raw anchovies, closed the bank, and continued
to fishing. Fishing subsequently increased from 27 to at least 34, with no death
observed for ClawScout.

CoinCrafter deposited 9 oak logs and 3 regular logs, closed the bank, completed
the return journey, and resumed gathering. Further gathering/banking was observed;
Woodcutting increased from 41 to at least 50. This was autonomous runner activity,
not the previous manual navigation probe.

Stinger cleared the banker dialogue, deposited 83 coins (108 total then banked),
closed the bank, travelled to Gerrant, and bought a net for 5 coins.

### Safety failure — do not omit from the result

Stinger then died near `(3087,3237)` during live verification. His first deployed
travel controller stopped on danger but did not escape. The old generic combat
flag also misclassified peaceful fishing/banker targeting as combat. His basic
shortbow was observed rejecting steel arrows. The lost ground items observed
after death were 45 coins, 20 steel arrows, and the net; banked items survived.
The dangerous dropped items were not retrieved. Stinger respawned and the
recovery policy was restarted; banked money can fund another net.

Follow-up changes:

- Threat detection requires recent damage or an attackable/player target; a
  fishing spot or banker target alone no longer freezes the runner.
- A travel damage interrupt immediately dispatches an escape toward the known
  southern approach at Draynor, or a recent verified movement leg elsewhere.
- Route planning excludes the confirmed wizard area: plane 0, x 3076–3092,
  z 3233–3247. The earlier broader exclusion was rejected in testing because it
  cut off the shoreline exit. The safe approach is `(3094,3226)` and fishing
  selects the southern spot, not the northern spot near the wizards.
- Respawn invalidates the old route/trail and work return; death receives a
  strong negative learning reward. Insufficient recovery cash triggers a bank
  withdrawal before travelling to buy the missing tool.

## Tests

15 local regression tests passed (41 assertions). They cover dialogue indices,
direct bank options, transfer conservation, tree gates, bow/ammo compatibility,
peaceful-target combat flags, preserved detours, stalled/rejected movement,
plane changes, life changes, damage interruption, immediate escape dispatch,
and preventing a bow fight with an empty/incompatible quiver.

`scripts/check-map-worker.ts` also passed three actual-map checks:

1. ClawScout's fence detour reaches the bank.
2. Gerrant to the southern fishing approach avoids the wizard exclusion.
3. The observed shoreline tile `(3087,3227)` can reach the cooking approach
   `(3100,3257)` without entering that exclusion. The earlier `(3100,3255)`
   approached the wrong side of the fireplace wall. Door `(3101,3258)` and an
   interior item-on-fireplace interaction were verified live; the first attempt
   burned a shrimp. Subsequent autonomous cooking produced edible food:
   ClawScout reached Cooking 25 (seven cooked fish observed in inventory), and
   Stinger reached Fishing 15 / Cooking 16 (three cooked shrimps observed).

Run with Bun from this project:

```powershell
bun test src/runtime-policy.test.ts src/navigation/controller.test.ts
bun scripts/check-map-worker.ts
bun build src/agent.ts --target bun --outdir .tmp-build
```

CoinCrafter's deployment log starts with `runner.final-20260907-213948`.
ClawScout's latest log is `runner.cooking-20260907-214342`; Stinger's latest is
`runner.ammo-20260907-214531`, in their respective profile directories.
CoinCrafter reached Woodcutting 55 and was observed taking another full batch
to the bank. Stinger's post-death fishing/cooking recovery completed without a
second observed death; ammunition replenishment remains his next prerequisite.
Old logs and learning tables were preserved. No Clawscape game/server files were
modified. The CLI account home remains `data/online-home`; no second login or
parallel controller was introduced for any character.

## Limits / next acceptance work

This is a same-plane navigator, not the entire proposed world-navigation design.
Floor-transition discovery, generic risk-aware route learning, broad alternative
service selection, and recovery from every kind of obstacle remain incomplete.
The wizard exclusion is confirmed-location knowledge, not a general danger model.
Mock escape tests do not establish survival against every enemy, and successful
banking does not establish all fishing/cooking/combat goals as complete. Continue
checking real service outcomes; never describe a first hop as a complete fix.
