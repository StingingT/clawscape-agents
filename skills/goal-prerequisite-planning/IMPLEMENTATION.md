# Goal/prerequisite planning — runtime scope

Current patch: `goal-prerequisites-20260922.2`.

## Independent controls

`data/catalog/goal-planning.json` has `mode` (shadow/pilot) and optional `intentMode` (shadow/enforce). A missing intentMode means shadow for backward compatibility. `bun scripts/goal-planning.ts intents on` enables only the generic legacy-intention review. It leaves source settings, XP confirmation, action budgets and all action pilots unchanged. `intents off` disables that filter. `shadow` returns BOTH goal controls and the source-action gate to shadow.

A fresh bounded source pilot plus matching confirmed XP/profile remains necessary for the preparation planner to control new source/training actions. Do not enable a pilot as a workaround for missing shop, anvil, loot or party executors.

## What intent enforcement changes

Legacy bundled/documented destination leads remain in world knowledge. They do not automatically become survey goals without a current bounded resource/access/curiosity/operator purpose. Real observed exploration remains eligible. Direct operator instructions and a purposeful investigation tied to its current parent are preserved. There is no item, character or destination blacklist.

The live catalogue filter runs on every build, including within the report throttle window. Active obsolete goals or old support leaves are archived only at an own living, out-of-combat, non-danger boundary without task/safety receipts or Director pending commands. Existing executor reconciliation remains responsible for those commands; the policy never clears them or fabricates completion. A stale selection made before policy activation is rejected at begin before a new action can be issued. Archival changes intention history, not world knowledge, rewards, methods or XP.

This is not a blanket claim that all remembered observations have a useful current purpose. It is the narrow correction for seed-derived mandates. The same destination can be justified again with a current purpose. The autonomous generation of every possible long-distance investigation is not implemented by this patch.

## Prerequisite diagnostics

The source adapter already represented OR conditions as alternate methods. The older diagnostics incorrectly accumulated failures from all alternatives. Branch-scoped diagnostics now report a global required level only when it is necessary across surviving alternatives. A usable carried/equipped tool branch suppresses unrelated high-tier warnings. Individual alternatives and missing facts remain available for planning. Unknown mandatory flags/predicates and executor checks are not bypassed.

## Runtime evidence in reports

`goal-planning.ts report` exports forecasts AND a bounded summary of each supported worker's saved `agency-v2.json`. These have independent timestamps. Runtime summaries distinguish active goals, planned methods, pending receipts, blocking reasons, productive-progress evidence and actual archived intentions. They are not live process checks. An absent, oversized, corrupt or identity-mismatched snapshot is reported as unavailable, never as healthy. A ready forecast is not proof of dispatch.

The existing `registeredMethods` field is source-specific; `methodCounts` also supplies legacy, total and numeric-training counts. Current skill levels and the observation location are included so that a future review need not guess an agent's readiness.

## Unchanged limitations

- Training must have source-backed numeric XP and confirmed matching live XP-rate data; the source default is not confirmation.
- No new remote-shop, anvil, loot-farming, party or advanced Astra executor is supplied here.
- No world flag, skill level, money, gear, recipe output or route success is fabricated.
- Existing Director budgets, journal reconciliation, action authorization and learned method scores remain in force.
- Original goal planning .1 acceptance tests remain; one literal version assertion was updated to .2.
