# Persistent equipment goals

8 September 2026. Agent-only changes; the game repository and Astra's separate
controller are untouched. Existing learning/profile data is retained.

## What is running

The three established controllers now run `src/goals/planner.ts` ahead of ordinary
training and production. Safety, finishing current combat and food recovery still
take priority. Each profile saves `equipment-goals.json`, with the active target,
funding/withdrawal/shop/equip stage, alternatives, unmet prerequisites, temporary
blocks, measured completed acquisition times, and an acquisition history.

An interrupted goal survives episode boundaries and restart. Fresh skill and
inventory observations can invalidate or supersede it. Three minutes without
verified progress (excluding safety/food pauses), or two identical failed effects,
defers the route rather than endlessly retrying it. Collision checks and observed
merchant menus govern service trips. No success is inferred from arriving nearby.

### Selection rules

1. Use an eligible item already carried or banked before buying duplicates.
2. Compare supported purchases with recipes whose levels and inputs are already
   available. Prefer meaningful upgrades, skipping intermediate tiers within a
   two-minute estimated detour. Expensive routes exceeding the current 15-minute
   estimate window are deferred. These are configurable-in-code policies, not a
   proof of globally optimal progression.
3. When poor, retain a funding goal. A small 200gp funding window can skip nuisance
   upgrades. Gather/sell ordinary logs, collect nearby observed sale loot, or
   obtain a starter axe from Bob using the actual price. Preserve food and tools.
4. CoinCrafter now monetizes unreserved production beyond the former 2,000gp
   bootstrap milestone. The active production objective controls the output,
   retains assigned materials and finishes a processing batch before selling.
   Finished and unstrung bows are distinguished by ID. See OUTCOME_GOALS.md.
5. Re-read before transactions. Price increases, stale slots, closed shops or
   wrong items invalidate a prepared action. Purchases/sales require matching
   inventory and coin changes. A weapon goal completes when equipped; gathering
   axes need only be in inventory. Attack training is not needed just to carry one.
6. Unknown earning/training/drop time remains unknown, never zero. Completed
   acquisition durations refine method estimates; no learned DPS superiority is
   asserted. Existing encounter learning is preserved.

## Recipes and deliberate limits

The catalog reads the local game's object IDs, bonuses, shop references and recipe
tables. Live prices/stock override historical shop hints. A live shop can offer a
normally unstocked catalog item (including a rune scimitar); it is not rejected
just because the source shop list omitted it.

- Rune scimitar: Attack 40; source recipe Smithing 90, two runite bars and hammer.
  Its inspected default source is a Fire giant drop; Zeke does not normally sell it.
- Dragonhide chaps: Ranged 40; source recipe Crafting 60, two **tanned dragon
  leather**, needle and thread. Raw hide is not interchangeable with leather.
- Rune axe: Woodcutting 41 to use, recipe Smithing 86. No invented freely accessible
  rune-axe shop or safe Kalphite Queen farming route is dispatched.
- Scavvo's shop is behind a 32-Quest-Point gate and an upstairs transition;
  Nurmof is underground. The agent may target observed Nurmof pickaxe stock,
  but the route remains unverified until a live underground trip succeeds.

Ready-input stringing, leather crafting and anvil actions have bounded adapters
using observed interfaces. They have **not** completed live acceptance trials in
this update. End-to-end mining → smelting → smithing training, hide hunting →
tanning, arbitrary dragon combat, and supplying every recipe input automatically
are **not implemented** by this planner. They remain explicit dependency backlog,
not promises that the agents can already execute those full chains. Astra's
missing-tool acquisition route is also unchanged.

## Evidence and validation

- Source catalog: `src/goals/catalog.ts`; exact paths are stored with every method.
- Reviewed external context: [Rune scimitar](https://oldschool.runescape.wiki/w/Rune_scimitar)
  and [ranged armour](https://oldschool.runescape.wiki/w/Armour/Ranged_armour).
  These are references, not automatic authority for this custom 2004 server.
- Tests cover owned/banked gear, tier skipping, buy-versus-ready-craft, missing
  requirements, cash reserves, stale prices/slots, restarts, failures, and actual
  equipped completion. The Bun bundle check validates imports and syntax, not a
  full TypeScript type-check or live recipe acceptance.
- Initial live rollout: all three remained connected and followed goal-directed
  bank/shop routes. Report receipts and final kit changes separately; movement
  alone does not establish a completed acquisition.

### Recorded rollout results, 10:43 UTC

- **137 tests pass, 0 fail, 287 assertions**; Bun bundle/import check passes.
- ClawScout opened the bank and withdrew the saved 25gp, verified by opposing
  inventory/bank changes. He retains the Iron scimitar funding goal and is selling
  gathered materials; no completed weapon acquisition is claimed yet.
- Stinger withdrew saved funds and bought a gathering axe (cash 100 -> 84);
  the retained main goal is the Oak shortbow. The bow is not yet claimed acquired.
- CoinCrafter sold production and banked proceeds: the checkpoint has 250gp
  carried + 1,270gp banked = **1,520gp**, from 96gp carried initially. The 2,000gp
  reserve milestone remains incomplete.
- The trial found a brief Windows replacement-file lock and a funding-source
  failure being incorrectly charged to successive gear targets. Replacement now
  retries boundedly without destroying the prior checkpoint. Shared prerequisite
  blocks retain the equipment target; eligible observed oak can fund it too.
  Regression tests cover both. All three controllers were restarted on this revision.
- These are real bank, sale, tool and goal-persistence observations, not proof of
  optimal long-term gear or successful smithing/dragonhide crafting trips.

`scripts/plan-equipment.ts` builds plans from live read-only observations but writes
local planning state. It refuses to run alongside a controller. For normal status,
read the profile's `equipment-goals.json` and `scripts/status.ts` instead.
