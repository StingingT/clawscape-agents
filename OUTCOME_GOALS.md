# Outcome-driven goals — 8 September 2026

The objective is not to finish a checklist of skills. ClawScout and Stinger seek useful combat capability through build-compatible experience, better equipment and sustainable supplies. CoinCrafter seeks sustainable **net wealth**, using skills and tools as investments. Astra already has a separate equipment/experience-oriented policy; its release limits are not relaxed by this change.

## Runtime changes

- Removed the 99/99 discipline switch from production, tool choice, telemetry and outgoing stock messages. Woodcutting/Fletching stay usable at 99. Mining can be considered earlier.
- A persistent production intent chooses among the **implemented** nearby tree/log/fletching jobs and starter metalworking. Logs can be sold without automatically fletching them. Shortbow inputs remain candidates when a validated downstream equipment need requires them; a high Fletching level need not force longbows.
- Fresh sale prices plus recent observed production-cycle times estimate net GP/hour. Higher price or higher level alone never wins. Unknown prices, rates and material opportunity costs are not advertised as profit.
- Where end-to-end sale time is not measured, use a clearly provisional **120-second sale-travel allowance per batch**. This is a heuristic, not a measured map-specific rate. Full sale cycles do not add that allowance again.
- Rate samples exclude pre-existing partial batches and unpriced banked inputs. Gathered inputs may be banked and withdrawn within the same tracked cycle without becoming bought materials. Banked products are assets, not cash profit; reconciled shop sales establish realized prices.
- Once per five completed batches, an eligible less-tested alternative may receive a bounded production trial. This can develop another skill for future profitable items, regardless of current levels. Only implemented methods with the required tools/supplies participate; discovery of all game methods is not claimed.
- Retain the current job through processing and banking. A new selection occurs at a clear batch boundary, or when the method is blocked. A 15% preference band discourages shuttling for tiny quote differences.
- Sell available unreserved surplus beyond 2,000gp. Do not interrupt an unfinished production batch or travel to a shop for a single raw log. Retain finite materials assigned to verified, currently feasible equipment/orders.
- Fighters' reward now distinguishes useful XP and real gear improvements from collecting arbitrary item counts. XP already beyond a skill/build cap does not count as becoming stronger. Defence/Prayer and existing build restrictions are preserved. CoinCrafter values verified net cash and tool progress, with a smaller skill-investment reward.
- The changed reward scale uses `q-table-outcomes-v2.json`; the old `q-table.json`, experience history and learned navigation/encounter data remain intact.

## Limits — do not overclaim

This ranks supported jobs; it does not prove the most profitable activity in the whole game. Price evidence and comparable rates need to accumulate. Sale demand can change, stock can saturate, and tool depreciation/death risk are not a complete economic forecasting model. Existing safety/route cooldowns still override returns.

`ProductionNeed` supports finite, verified equipment/material needs with an expiry and ready downstream chain. No unsafe peer-transfer promise creates such a need automatically: player trading is still disabled. Full bowstring/arrow assembly, higher-metal routes and arbitrary item manufacturing remain their existing implementation backlog. Buying is still an option when a supported purchase is better than acquiring every skill/input.

Astra's generic goal generator now respects a source/build training cap instead of proposing level 100. Supply work remains available. Its live policy, sole ActionArbiter, pilot boundaries, missing-tool blocker and offline/online status are unchanged. No Astra login or new trial was launched.

## Inspect and verify

`data/coincrafter/work-state.json` → `economy.objectives` records intent, alternatives, rate estimates, prices, samples and concrete needs. The normal plan logs and peer overview expose that decision. Estimates are labelled and missing information remains null.

Agent tests cover 99/99 woodworking, earlier mining, high-price/low-profit recipes, stale quotes, unknown costs, useful material needs, batch commitment, unsold stock, cash reserves and retained tools. The Bun build checks syntax/imports, not a full legacy-project TypeScript check. Astra's own TypeScript, tests and synthetic evaluation run separately; synthetic results do not establish live gameplay performance.

### Verification for this update

- Shared-agent tests: **174 passed, 0 failed** (367 assertions); agent Bun bundle succeeded.
- Astra: **239 passed, 0 failed**, TypeScript check and synthetic evaluation passed. No live trial was started.
- Restarted one controller each for ClawScout, Stinger and CoinCrafter at 13:16 CEST. The map finished loading and navigation resumed. CoinCrafter retained yew fletching at Woodcutting 99 / Fletching 89, reached the yews, and increased his inventory by two logs (ticks 9184–9198). ClawScout completed shop sales and resumed a training trip; Stinger gained logs for funding and then resumed a training trip. This is a policy/startup smoke check, not proof of a full profitable production cycle or a new gear purchase.
- Runtime logs: `data/{online,stinger,coincrafter}/outcomes-20260908-131641.log`. Profit estimates are still unknown while new comparable measurements accumulate.
