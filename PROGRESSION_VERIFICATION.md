# Live verification — 7 September 2026

Scope: the existing agent client only. The Clawscape game checkout was not changed;
Astra was not touched. Separate per-character controllers and learning stores retained.

## Observed results (server tick 16069, approximately 22:50 Europe/Amsterdam)

| Agent | Before this deployment | Verified after deployment |
|---|---|---|
| CoinCrafter | WC 71, Fletching 1; idle at Varrock mine with no axe/pickaxe | Withdrew 25 banked coins; bought axe + pickaxe; collected Knife; Fletching 54 (45,817 XP); making oak/willow bows and banking batches |
| Stinger | Ranged 10; outside closed chicken gate; 20 compatible arrows | Entered pen at 3232,3295; Ranged 28 (6,700 XP); recovered arrows, refilled an empty quiver from inventory and bought another supply |
| ClawScout | Attack 16, Strength 57; frequent combat movement/health dead zone | Attack 40, Strength 61; normal fights allowed to finish, early healing, nearby targets selected |

No new deaths during this validation: respawn counters remained CoinCrafter 1,
Stinger 1, ClawScout 0. This is not a guarantee against future deaths.

Bank transfers were checked against matching inventory and bank count deltas, not
just successful CLI dispatch. The production runner logged completed bank deposits
and withdrawals at ticks 15964 and 15999 and continued the next recipe batch.

Live checks exposed and corrected issues not covered by the initial mocks:

- Production menus could cancel the work queue before XP arrived. The controller
  now chooses the correct product's Make 10, waits and preserves active production.
- Unstrung bows have ordinary bow names in this server. Product IDs, not modern
  `(u)` suffixes, distinguish outputs from usable bows.
- An empty quiver used to trigger recovery before carried arrows could be equipped.
  Refill is now a combat-supply action that precedes that decision.
- A navigation interruption that dispatched nothing must wait for a fresh tick,
  rather than hot-loop over cached state.

## Tests

`bun test src`: 41 passing tests, zero failures, 83 assertions.
`bun build src/agent.ts --target=bun --outdir=.tmp-build`: successful.

Tests cover production groups, action persistence, output identities, bulk deposits,
health decisions, local target selection, quiver refill, tool recovery, recipe gates,
and the existing collision navigation controller's failure/arrival cases.

## Boundaries / still unverified

- Edgeville willow and yew coordinates/bank approaches are checked against game map
  data; the new complete harvest → bank → return circuit was not live-verified here.
  Current gathering preference is bank-side willows. Yews require usable products
  and an upgraded axe; this is a guide-backed heuristic, not proven global optimality.
- The economy tool-and-log chain is implemented, not every mining/smithing/crafting
  production chain. A pickaxe is now available for that next step.
- Stinger's Rune Mysteries milestone is retained but does not preempt working
  Ranged training until the required floor transitions are implemented and verified.
- No new remote research service/model was added. The planner uses researched,
  source-checked prerequisites and live game observations.

See [economy plan](ECONOMY_PLAN.md) for sources and progression prerequisites.
