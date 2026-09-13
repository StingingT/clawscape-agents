# CoinCrafter economy plan

CoinCrafter is the account's non-combat supplier. The current executable loop
recovers tools, processes banked logs, and gathers near a bank. Decisions use
guide-backed prerequisites checked against 2004 server content and live items.
Global profit optimisation and the remaining production chains are future work;
logging XP and reward is not proof that those chains already execute correctly.

1. Woodcutting -> Fletching -> Firemaking: logs become bows, shafts, or fires.
2. Fishing -> Cooking: cooked food supplies both brawlers and future sales.
3. Mining -> Smithing: ores become bars and equipment inputs.
4. Thieving: early cash and shop-funding route when a safe target is exposed.
5. Crafting, Runecraft, Herblore: add only when the live game exposes the
   materials, tool, and production interface.

The agent records locations, inventory changes, XP and elapsed time. Trees are
not chosen solely by the highest Woodcutting unlock: the available axe and usable
Fletching products also matter. No modern OSRS XP rates or prices are assumed.

## Current sequence (7 September 2026)

1. Recover banked cash/tools after death. Never route to a mine without a pickaxe.
2. Buy an affordable axe and a Mining-eligible pickaxe from observed shop stock.
   Starter pickaxes may come from Bob; higher tiers target observed Nurmof
   stock. Pickaxes are bought, not smithed. Reserve enough cash for tools.
3. Obtain the normal Knife ground spawn at Lumbridge (3224,3202, plane 0).
4. Withdraw usable banked logs in batches. Knife + log opens the observed product
   chooser: normal shafts at 1, shortbows at 5, longbows at 10; oak 20/25, willow
   35/40, maple 50/55, yew 65/70. Bank outputs, then replenish inputs.
   Use the selected product's Make 10 and let its queue run. On this server
   unstrung bows have ordinary bow display names; item IDs 48/50/54...72 distinguish
   them from usable bows. Deposit matching outputs together, not one slot at a time.
5. Sell observed positive-price unstrung bows to fund an axe upgrade. Never sell
   equipped gear, supplies or tools. Carry at most a 250-coin working reserve.
6. Gather willows east of Edgeville at (3112,3487) and use the nearby bank approach
   (3094,3491). Yews south of that bank become a candidate at Woodcutting 60,
   Fletching 65 and at least a steel axe. These are source-checked candidate routes,
   not a claim that every full live bank-return trip has already been verified.

Seers has bank-side maples in the local map, but the long access route has not
been verified safe for a combat-5 supplier. Do not silently send him over White
Wolf Mountain. Higher pickaxes target Nurmof's observed stock, but the
underground transition still requires live route verification.

## References and validation

- [Woodcutting guide](https://oldschool.runescape.wiki/w/Free-to-play_Woodcutting_training)
  supplies the bank-proximity/axe-upgrade strategy. Ignore modern Forestry and guild content.
- [Bob's stock](https://oldschoolrunescape.fandom.com/wiki/Bob%27s_Brilliant_Axes)
  suggests the starter tools; actual purchase decisions require observed prices.
- Local `skill_woodcutting/configs`, `skill_fletching/configs/cut_logs`,
  `skill_fletching/scripts/cut_logs.rs2`, `area_lumbridge/configs/lumbridge.inv`,
  and maps `m50_50`, `m48_54`, `m42_54` validate mechanics and locations.
- `src/progression-policy.test.ts` covers health, engagement, local targets,
  compatible ammunition, tool recovery, recipe gates and banked processing.

## Banking loop

At 28 occupied inventory slots, CoinCrafter stops gathering and returns to the
appropriate bank (Varrock West or Edgeville; there is no Lumbridge bank in this
content). It only opens a locally observed banker, bank booth,
chest, or table, then deposits gathered materials while keeping tools and gear.

Log processing is implemented. The intended extension for fish, ores, essence,
hides and herbs is the same deposit/withdraw/verify loop, but those production
controllers still need separate implementation and live checks.
