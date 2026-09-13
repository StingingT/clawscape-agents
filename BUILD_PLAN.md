# ClawScout brawler progression plan

## Chosen build

ClawScout will follow a low-combat melee strength-pure route:

- Attack: 40 target, then stop. This is the first weapon milestone for rune-tier weapons.
- Strength: main damage stat; train continuously after required weapon milestones.
- Defence: 1 permanently for this build.
- Prayer: 1 for now to preserve the lowest combat level.
- Ranged and Magic: leave at 1 unless a later, deliberate utility branch is approved.
- Hitpoints: train naturally through combat.

This is a PvP-style build and is deliberately a hard-mode PvM character because
low Defence means more food and more deaths. A later branch can be chosen at a
checkpoint: 50 Attack for granite-maul gameplay, 60 Attack for dragon weapons,
or 31 Prayer for Ultimate Strength. The agent must not cross those checkpoints
automatically.

## Route map

| Stage | Gate | Training area / activity | Equipment objective |
|---|---|---|---|
| 0 | New character | Tutorial Island, then starter area | Equip the best available one-handed weapon and shield; select an aggressive Strength style |
| 1 | Attack 1–20, Strength 1–20 | Tutorial rats, then chickens/goblins/men where available | Bronze → iron → steel weapon upgrades; carry food because Defence stays 1 |
| 2 | Strength 20–40 | Minotaurs or equivalent low-level targets | Mithril/adamant weapon when Attack permits; prioritize melee strength bonus |
| 3 | Attack 40 | Safe F2P weapon shop or monster/drop route | Rune scimitar as the primary weapon when present; retain a slower high-strength switch only if the world exposes it |
| 4 | Attack 40, Strength 40–60 | Hill giants / moss giants or the best observed low-risk target | Best affordable strength-bonus gear, food supply, and weapon maintenance |
| 5 | Strength 60+ | Highest XP-per-risk target verified by live observations | Upgrade gear only when the character can afford and equip it; do not add Defence or Prayer accidentally |

## Food and income loop

The sustainable food route is deliberately separate from combat: use the starter
net for shrimp/anchovies until Fishing 20, then switch to fly-fishing trout and
salmon. When a fire or range is exposed nearby, cook raw fish before returning
to combat. The agent keeps edible food and only enters this loop when its food
reserve is low; it does not drop the catch while ClawScout still needs supplies.
The current online state contains a small fishing net and starter shrimp, but no
reachable fishing spot in the observed radius yet, so navigation to the first
spot remains a live-world discovery task rather than a hard-coded coordinate.

Fishing/cooking are support skills and do not change the brawler build. Crafting
is not currently required for the planned melee equipment; it becomes relevant
only if a later branch needs leather gear, jewelry, or another item the server
actually exposes.

## Decision rules

1. Finish onboarding before training.
2. Prefer Strength style until Strength 40; then train Attack to 40; return to Strength.
3. Before every target, compare NPC level, reachability, recent damage, and food.
4. Before every equipment action, verify the item is in inventory or the shop and that its option is exposed by the game API.
5. The agent may not train Defence or Prayer under this plan.
6. At Attack 40 / Strength 40, pause for a checkpoint before selecting a 50-
   or 60-Attack branch.

## Operating cycle

The agent must execute this loop rather than remain at one training spot:

1. If carried food is below the trip minimum, route to the food hub.
2. Fish with the best available tool and cook the catch at a discovered fire or range.
3. At the bank, deposit excess cooked food and withdraw enough for the next trip;
   maintain a large reserve before entering harder combat areas.
4. Check for the next weapon or shield milestone and buy, loot, or equip it.
5. Route to the combat area for the current milestone and train until the next
   supply, gear, or level checkpoint.

The current Clawscape state has ClawScout at Attack 16, Strength 43, Fishing 1,
Cooking 1, two food items, and only starter combat gear. Therefore the immediate
priority is food production, followed by Attack 40 and a better weapon.

## Sources and adaptation

The general thresholds are based on the OSRS Wiki's one-defence, melee-pure,
and F2P training guides. The 2004Scape community discussion indicates that
period-appropriate builds commonly center on 1 Defence with 40 or 60 Attack
and either 1 or 31 Prayer. Because 2004Scape does not contain every modern
OSRS item or activity, the agent only acts on equipment and targets that the
live state actually exposes.

- https://oldschool.runescape.wiki/w/One-defence_pure
- https://oldschool.runescape.wiki/w/Melee_pure_%28free-to-play%29
- https://oldschool.runescape.wiki/w/Free-to-play_melee_training
- https://lostcity.rs/t/period-accurate-pk-builds/13763
