# Peer economy and outcome-driven progression

Implemented 2026-09-08 in the separate agent project. The game repository is unchanged. This applies to ClawScout, Stinger and CoinCrafter, not Astra's separate controller.

## What runs

- Each sole character controller publishes compact inventory, recent bank, equipment and build-compatible demand to `data/shared/market.sqlite` (SQLite WAL). No credentials are stored there. Records are scoped by world and catalog version. Bank evidence expires after 30 minutes.
- Stinger asks CoinCrafter for a finished bow upgrade and compatible ammunition; ClawScout asks for a melee upgrade. Finished IDs, not display names, determine usefulness: unstrung bows and shafts do not satisfy those orders.
- CoinCrafter quotes only genuinely spare, usable stock with observed price comparisons. Unknown inputs/costs do not authorize a speculative manufacturing order. Tools and equipped items are excluded.
- Seller ask, buyer counteroffer and seller agreement are separate controller decisions over the local ledger, mirrored through in-game private messages. Outgoing messages are rate-limited (one per minute, recurring request/status at most once per 30-minute window), checkpointed before dispatch, and never blindly replayed on an uncertain response. An echo proves sending, not that a human read it.
- Each buyer keeps the existing food/ammo cash reserve. A deal must beat the seller's NPC sale and the buyer's NPC purchase after a **2 gp per-side handling allowance**. This allowance is a configurable-code policy estimate, not measured travel cost. Do not start a travel-consuming trade using it as an actual travel-time estimate.
- Live stocked NPC purchase quotes and supported NPC sale quotes expire after 30 minutes. A bigger player population does not force price increases. A tested external-sale median rejects unverified, stale and own-agent wash trades; **there is no live external player-market feed yet**, so no inflation trend is claimed.

## Transfer safety gate — still blocked

The live OpenAPI (2026-09-08) exposes `interactPlayer(playerIndex, optionIndex)`, but nearby players do not expose labelled options. The local SDK hardcodes index 4; the installed skill documents that this can attack a different target. No guessed interaction is sent.

The skill also says non-empty trade offers have not been verified. Consequently:

- negotiation is provisional; no trade is marked completed;
- no rendezvous, gold/item offers, accept clicks or drop trading are dispatched;
- unexpected open trades are closed before the generic dialog chooser runs;
- agents continue their ordinary goals rather than waiting for a trading partner;
- before enabling transfers, require a labelled/explicit trade request, inventory offering through supported interface actions, exact item-ID/quantity/price revalidation on both screens, and opposite item/gold deltas on both characters after completion. Test a bounded transfer under their existing action owners first.

Source: live `https://clawscape.xyz/openapi.json`, installed Clawscape `references/mechanics.md`, read-only game `upstream/sdk/index.ts` trade helpers. **No goods have been transferred by this implementation.**

## CoinCrafter's production choices

The former automatic 99/99 switch has been removed. [OUTCOME_GOALS.md](OUTCOME_GOALS.md) describes the replacement. Woodworking remains available at 99; Mining/Smithing may be selected before 99. Skills, raw materials, processing and tools serve a concrete equipment or net-wealth objective rather than a fixed discipline ladder. Tool upgrades follow the selected job, not whether another skill is maxed.

The current staged metalworking chain is:

1. Recover a banked usable pickaxe when available; otherwise buy the highest
   Mining-eligible pickaxe from observed shop stock. Pickaxes are not Smithing
   products in this source. Recover/buy a hammer while preserving food and gold.
2. Mine source-matched copper/tin, iron, coal, mithril, adamantite and runite
   routes as each selected bar recipe requires; bank partial/excess batches.
3. Smelt bounded batches with the source-required coal/tin quantities.
4. Smith the axe ladder when the Smithing gate is reached, targeting Rune axe
   long term. Click only an observed matching product; unsupported products
   defer safely instead of guessing a component.
5. Bank outputs and resume. Fresh slot/price/resource checks precede
   transactions; existing navigation and combat safety retain control.

This is a **source-backed staged chain**, not a complete optimal 1–99 guide.
The pickaxe purchase route through underground Nurmof still needs an end-to-end
live verification; never report a purchase or mining trip until the live
inventory/action evidence confirms it.

Carried tools use Woodcutting/Mining requirements; Attack is needed to wield them, not to gather with them. Keep CoinCrafter's Attack unchanged unless a separately costed wielding goal justifies training it. Pickaxes cannot simply be assumed smithable in this 2004 content.

Evidence: `skill_mining/scripts/pickaxe_checker.rs2`, `skill_mining/configs/{mine.dbrow,pickaxes.obj}`, `skill_smithing/configs/{smelting/smelting.struct,smithing/smithing.dbrow}`, and maps `m51_52`, `m50_50`, `m49_53`. Tool-use distinction also agrees with https://oldschool.runescape.wiki/w/Rune_axe.

## Checks

Run `bun test`, `bun build src/agent.ts --target bun --outfile .tmp-build/market-check.js`, and read-only `bun scripts/check-metal-routes.ts`. Offline routes do not prove live service use. `bun scripts/market-status.ts` reads the negotiation overview without controlling any character.

### Historical initial trade rollout verification

- 154 tests passed, 0 failed (336 assertions); Bun bundle completed. This is not a TypeScript typecheck.
- Offline route checks returned exact-endpoint `ready` for bank → mine → furnace → anvil → bank. Mine → furnace has four conditional doors. No live end-to-end metalworking claim is made.
- Existing controllers were identity-checked, stopped, their Python children allowed to finish, and replacements started with one owner per profile.
- In-game self-echoes verified Stinger's kit request, ClawScout's weapon request and CoinCrafter's stock reply. They resumed normal funding/woodcutting after sending. No profitable deal exists yet: currently usable spare stock and live price evidence are missing. No item or gold transfers occurred.
