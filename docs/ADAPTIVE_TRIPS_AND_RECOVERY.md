# Adaptive trip preparation and remaining-action recovery

## Food and carrying capacity

The executable standard controller no longer turns `Math.max(3, ...)` into a universal food prerequisite. The same computed requirement is passed to its bank, combat-training and production adapters, and the advanced controller's food preparation and arbiter. Legacy historical records are retained, but an inactive old `supply-food` objective is re-evaluated. A pending execution receipt is never rewritten to change a food target.

`agency-v2.json` now contains personal `trips` learning and a compact `preparation` explanation. Comparable recent trips are grouped by activity, departure area/plane, personal identity, equipped items and combat-skill bands. The estimate accounts for observed meals consumed, damage, emergency retreats, deaths, current missing HP, tools and available inventory capacity. Measured healing is preferred; a provisional HP-based estimate is explicitly a prior, not audited food mechanics.

An unmeasured non-combat activity can start with zero food when no current health deficit or observed threat requires it. An unmeasured combat probe starts with a provisional one-meal estimate, not a permanent minimum. Comparable safe returns can reduce that to zero; actual consumption, harm or emergency exits increase subsequent preparation. Recent samples are bounded and age out so an old bad trip is not a permanent food quota. This is a conservative heuristic, not a claim of optimal provisioning or proof that an unknown area is safe. Health, equipment, affordable-risk, pure-XP and PvP guards still apply independently.

Only verified Eat effects teach consumption/healing. Depositing food does not count as eating it. Session/clock discontinuities and idle bank visits do not become successful zero-food work trips. Mixed activities and incomplete trips do not become comparable successful-return samples.

Gathering targets the available cargo allocation rather than ending at an arbitrary small XP increment: keep tools and the current trip reserve, collect until the allocated bag space is used, then bank outputs. The counter advances only for verified newly gathered resources subsequently transferred with balanced inventory/bank deltas. Withdrawing old stock and redepositing it cannot manufacture a successful gathering batch. Stackable resources, production pair requirements, access restrictions, safety interruptions and the overall attempt budget can limit a particular route; this is not a universal promise to fill every slot on every activity.

## Interrupted operations versus transactions

A 30-second quiet observation window can retire supported repeatable resource-local operations as interrupted. It does **not** prove historical non-execution and does not earn task-success credit. Current resources/options are validated again before a new action. Inventory/XP changes since an old attempt do not permanently make all future experiments impossible. Cosmetic metadata and stale non-combat NPC targeting do not reset an otherwise idle window. Changing accounting/XP, position, activity, ownership or identity still prevents settlement or resets the window.

This applies to supported gathering/combat starts, conventional arrow-input/knife-log operations, simple obstruction operations and recognized NPC bank/shop opening. It is not a blanket rule for arbitrary quest items, talk rewards, purchases, transfers or dialogue choices. Those still need attributable evidence. A documented `action_in_progress` dispatch refusal is distinguished from a transport timeout; other generic failures remain unknown. A relevant newly opened production component panel can verify the preparation step without pretending the item output exists. Unsupported or unaudited panel selections remain guarded.

Astra now uses the same bounded transient settlement at startup and during live arbiter reconciliation for movement, closing interfaces and style changes. Its recovery lease remains non-executing until reconciliation completes. The original command/result is appended to the SQLite audit before cancellation with `RECONCILED_TRANSIENT_INTERRUPTED`; the shared planner receives an interruption, not success. Startup samples for up to 45 seconds when a transient quiet window is actively developing. A missing checkpoint, stale observation, unknown historical reward/transaction or other genuine unresolved record can still prevent startup. This patch does not erase arbitrary historical dialogue records.

Life-change accounting now rejects cross-world/epoch and incomplete or malformed snapshots. A life change cannot automatically clear a bank/shop transaction or dialogue choice. Item deltas are recorded without inventing non-coin prices. The earlier observed-loss recovery remains available for non-transactional activity.

## Exploration, waiting and diagnostics

Already-persisted scenery objectives and irrelevant support nodes are retired without arrival/success credit once no executor action is pending. Support IDs are compact, and only the current dependency chain plus a small satisfied history is retained. An unrelated frontier is no longer labelled a dependency merely because the main method is blocked: investigative leads need an explicit connection to the parent requirement.

Navigation workers receive the selected environment, with a bounded startup failure rather than indefinite `loading-map`. Read-only waits are not productive gathering. A minute of no-effect read-only observations makes the method temporarily unavailable for re-evaluation, without discarding its parent objective.

`bun scripts/agency-status.ts` reports the current food/cargo estimate and reason, recent support nodes, ordinary pending action, and safety pending action. `tests/startup/upstream-path.test.ts` explicitly isolates its invalid-map test from the operator's `CLAWSCAPE_UPSTREAM` variable; no user environment setting needs to be removed for that test.

## Validation and limits

Tests exercise the real shared episode with simulated I/O, including a zero-food gathering trip that fills five cargo slots alongside its tool before banking all five outputs. Other tests cover historical recipe uncertainty, explicit dispatch refusals, no transaction replay, persisted-goal migration, food learning, immutable Astra movement settlement, manual takeover, and the live arbiter's equivalent recovery.

No live-server test, login, automated gameplay, paid model call or watchdog restart was performed by this implementation. The private `Joostrothweiler/clawscape` repository still returned 404. Public `Joostrothweiler/clawscape-skill` action documentation was consulted for dispatch/refusal semantics, not as proof of private combat, XP, quest, price or cancellation rules. Existing `build-rules.json` guards remain; no missing server rules were fabricated. Passing tests cannot guarantee that every historical runtime record will now be resolvable.
