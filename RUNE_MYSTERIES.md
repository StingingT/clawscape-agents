# Rune Mysteries — implementation and acceptance

Owner request: unlock rune essence access for the agents, 8 September 2026.
This agent project only; no game source, saves, credentials, XP, inventory grants,
GitHub comments, or public messages changed.

## Plan

1. Stinger and CoinCrafter: unlock Rune Mysteries for future rune production.
2. ClawScout: complete the same non-combat unlock without altering his melee build.
3. Astra: retained prerequisite milestone, **not enabled**. His independent
   arbiter does not authorize these quest/floor actions and his supply loop is
   still blocked by missing tools. Do not run him through the old controller.

The classic [quick guide](https://oldschoolrunescape.fandom.com/wiki/Rune_Mysteries/Quick_guide)
provides the Duke → Sedridor → Aubury → Sedridor sequence. Local 2004 source is
the compatibility authority: it uses item 291 named **Notes**, not “Research
notes”; NPCs 741/300/553; journal button 7335 and visible journal 8134. The live
runner reads the same public journal a player can open. It does not read varps
or a game save. High Runecraft or possession of a talisman never proves completion.

## Navigation scope

Source `ladders+stairs/scripts/stairs.rs2`, `ladders.rs2`, maps m50_50,
m48_49 and m48_149 establish castle north stairs and the tower ladder pair.
Basement travel changes world region while retaining plane zero.

The tower door at (3107,3162,0), source LOC1536 shape9, is absent from the SDK
collision export's door list. The agent map adapter treats its closed tile as a
**conditional passage**, reserves the opened-door tile at (3106,3162), and emits
the door as a prerequisite on crossed legs. Executor still requires observed
Open and observed passage; no wall bypass or server change is made.

`scripts/check-quest-routes.ts` checks source identity and exact collision-covered
outward/return endpoints, including the food-preparation bank and cabbage patch.
The first probe rejected a tower hint; the revised door-aware routes pass.
Source/collision evidence is not a claim of deployed-world parity or live arrival.

CoinCrafter's first tower-to-Varrock trip took damage near (3177,3222).
The nearby source bear spawn is (3176,3223), size 2, wander range 13, hunt
range 1. The attacker was not directly attributed, so this is a likely hazard,
not a confirmed NPC identity. Quest-only route planning now excludes an
18-tile radius square around that spawn and the second bear at (3159,3233).
Existing collision flags are preserved and ordinary combat planners are
unaffected. Full sampled routes, not just their endpoints, are checked against
these exclusions. Physical passages can cause a detour north despite the
strategic southern waypoints. Unsafe origins can now fail closed instead of
implicitly allowing travel through overlapping roaming areas.

A second trial triggered combat near the Varrock southern alley and withdrew
without observed HP loss. Recorded nearby NPCs included a Mugger and dark
wizards; no specific attacker was captured at the trigger, so attribution is
not asserted. Routes now exclude the source wizard circle plus the encounter
street and use the east gate and northern shop approach. The street exclusion
is NOT the mugger's whole possible roaming area: observed threat checks remain
necessary at the shop entrance. New threat records capture public combat/target
information at the trigger, before retreat. Map preparation now finishes before
login so characters do not stand exposed while collision data loads.

Health must recover to full for characters with <=15 maximum HP, or 90% for
others, before quest travel. Eating requires both food consumption and a
verified HP increase. Damage still interrupts the quest and triggers bounded
healing/retreat followed by a logout request. No repeated hazardous restart
is automatic; an inspected cause and explicit resume are required.

## Verification

`bun test src`: **112 passed, 0 failed, 220 assertions across 6 files**.
`bun build scripts/rune-mysteries.ts src/agent.ts --target=bun`: passed.
`bun scripts/check-quest-routes.ts`: passed exact source identities, collision
coverage, outward/return routes, conditional tower door, and danger-zone avoidance.
Offline checks do not establish live quest completion or absence of all hazards.

Live evidence, 8 September 2026, Europe/Amsterdam:

- CoinCrafter 11:22: journal says not started; 11/11 HP, no food. Quest travel
  paused without movement; logout requested, local runtime later unavailable.
- **Stinger 11:38:50:** public journal `QUEST COMPLETE!`; stage 6. Returned
  from the basement to (3105,3162,0), 47/47 HP. Logout read back connected:false.
- **ClawScout 11:38:57:** public journal `QUEST COMPLETE!`; stage 6. Returned
  from the basement to (3105,3162,0), 76/76 HP. Logout read back connected:false.
- CoinCrafter: log banking and collection of eight free ordinary cabbages
  observed before starting travel. Castle stairs and tower ladders worked.
  Received the research package. At 11:39 the damage interrupt stopped stage 3;
  retreated alive to (3165,3218,0), 8/11 HP, verified logout. At 11:48:54 the
  revised-route trial re-read the journal at stage 3 with the package retained
  and 11/11 HP. No eating action is credited for this between-session recovery.
  At 11:51 the Varrock threat interrupt withdrew to (3229,3389,0), still 11/11
  HP, with a verified logout. Following revised route checks, the 11:59–12:00
  trial delivered the package and obtained Notes (stage 5), still 11/11 HP.
  At 12:00:00 the trigger record identified a Mugger as the combat target beside
  the shop door at (3253,3398). No HP loss observed. Northbound retreat retained
  Notes and verified logout at (3241,3407), 11/11 HP. The final resumed trial
  adds a verified north-departure leg, avoiding another shop visit, and was
  observed beyond Varrock's east gate at (3290,3373), 11/11 HP, at 12:03:43.
- Astra: no live actions taken; the separate controller's M2 missing-tool
  prerequisite and deferred M6 quest capability remain unresolved. His safety
  arbiter was not bypassed by using the old agent's quest runner.

**Final CoinCrafter outcome, 12:06:52:** public journal explicitly confirms
permission to use the Rune Essence Mine and `QUEST COMPLETE!` (stage 6).
Notes were replaced by the returned Air talisman through the ordinary quest
interaction. At 12:07:01 he was back on the surface at (3105,3162,0), 11/11 HP,
seven cabbages retained, no active threat, and logout read back connected:false.
The final north/east-gate and hazard-excluding return trip had no observed HP loss.

## Final acceptance

| Character | Journal verified | Return verified | End HP | Controller |
| --- | --- | --- | --- | --- |
| Stinger | Complete, 11:38:50 | Tower surface | 47/47 | Stopped; disconnect read back |
| ClawScout | Complete, 11:38:57 | Tower surface | 76/76 | Stopped; disconnect read back |
| CoinCrafter | Complete, 12:06:52 | Tower surface | 11/11 | Stopped; disconnect read back |
| Astra | Not completed by this implementation | Not attempted | Not re-observed | Separate controller unchanged |

Evidence is retained in each profile's `rune-mysteries.json`,
`rune-mysteries.jsonl`, `quest-status.json`, and `quest-navigation.json`.
All times in this report are Europe/Amsterdam; machine journals use UTC.

Quests are bounded single-owner runs. Progress survives restart, but blocked
actions do not auto-retry indefinitely. No automatic post-quest rune production
or magic-training loop is claimed by this change.
