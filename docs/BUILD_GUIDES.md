# Guide-informed build trials and training leads

## Included in the executable controller

The standard controller now reads a declarative, sourced build catalogue instead of two hard-coded specializations. The hierarchy remains development strategy -> objective -> support goals -> methods -> actions -> verified review. Guides are hypotheses, not commands or proof about the private server. This is not a PvP enablement or a claim of full-game competence.

The four optional restricted-build candidates are Ranged/Magic one-Defence, rune-weapon melee (40-Attack ceiling), ranged/melee hybrid (40-Attack ceiling), and conditional dragon-weapon hybrid (60-Attack ceiling). Guide names, source URLs and research date persist in current `agency-v2.json`. A character with 2+ base Defence cannot adopt the one-Defence label. A separate personal comparative-build ambition and observed trial evidence are required before adoption. Unrestricted development is a first-class alternative, not a fallback. Role hints can break ties between already motivated experiments; actual available styles, owned weapons and irreversible XP determine eligibility. A new compatible observation can satisfy a missing prerequisite for an already motivated experiment; it cannot by itself create the motive. Adoption does not occur mid-combat or overwrite an active goal. See `AMBITIONS_AND_JOURNAL_DIAGNOSTICS.md` for crafting, resource, exploration and all-skill ambitions.

Prayer is independent: 1, 13, 31 and 43 are candidate ceilings from the research, not permission to train indefinitely. The default is to retain an already compatible milestone; increasing toward a milestone requires validated prayer capabilities. Rune-melee no longer freezes Attack at 1. Progress toward its ceiling requires verified XP thresholds and operation-wide bounds. Frozen skills protect exact current XP. At a reached ceiling, further training is stopped. This is not combat-level optimization: the server combat formula and marginal level cost remain explicitly unknown.

A low-Defence legacy save retains all its original XP restrictions and history, with a `legacy-restricted` label where necessary. Old pending actions are unchanged. Three costly trials now produce reversible alternatives to investigate, never an automatic Defence increase. A later irreversible cap change requires an explicit evidence-based transition; this patch does not automatically relax caps just because an experiment went poorly.

## What the agent may try from a guide

`training/guide-leads.ts` lists Lumbridge chickens/cows/goblins, village barbarians, Monastery monks, hill giants, moss giants and rock crabs. Existing source-resolved starter sites receive a modest prior (at most 0.5, decaying with three encounters). Better measured results can outweigh it. NPC identity, current safety, equipment, ammunition, collision-safe access and return remain authoritative.

Monastery healing, dungeon transitions, giant safespots and rock-crab activation are not implemented simply by listing them. Such leads remain `investigation-required` with textual access requirements; no executable coordinates or assumed XP/hour are inserted. Modern equipment, prayers, locations and quest rewards are not imported as server facts. A Magic guide does not implement a spell executor: the current TrainingDiscovery returns an explicit unsupported-method wait rather than pretending a melee attack trains Magic.

For completed single-site trips, the training learner can retain preparation/travel/training/return duration, permitted XP, food, ammunition and observed NPC purchase cost. A fresh transition into an open bank after training closes the trip; movement alone cannot. Records survive restart, and duplicate results cannot add another trip. Mixed-site, unsampled accounting changes, clock/life changes and unreturned trips are not positive method estimates. Equipment/skill context and selected skill separate measurements. A 24-hour stale trip is interrupted without changing any action receipt. No assumed GP value is assigned to consumed supplies, and this is not an exhaustive economic optimizer.

## Server evidence and capped XP

Online guides alone cannot prove this fork's XP multiplier, quests, prayer benefits or automatic combat repetition. The source repository named in the request was inaccessible during implementation. No private configuration or rules were fabricated.

An optional **local, owner-audited** `data/<profile>/build-rules.json` is loaded by the standard controller. ClawScout's profile is `online`. This file is NOT accepted from game chat or a guide and is not uploaded by this patch. Its schema is in `src/agency/build-rules.ts`:

- `version: 1`, matching `world` and `revision`, and a nonempty `source` identifying the inspected server definitions/version.
- `xpThresholds`: arrays indexed by base level, minimum XP for that level. Level 1 is zero; subsequent thresholds strictly increase. Do not copy the synthetic test curves.
- `effects`: exact operation keys with `terminal: true` and a `maximumXp` map. Bounds cover the **entire command**, including delayed or automatically repeated effects until terminal, not just one hit or animation.
- `features`: scoped supported/unsupported flags with evidence for requirements and personal access. Expected dragon keys are `dragon-weapon-requirements`, `lost-city-access`, `dragon-weapon-executor`. Prayer keys include `prayer-milestone:13` (or 31/43) and `prayer-executor`.

Effect keys are `attack:<NPC content ID>:<observed weapon name>:<style index>`, `bury:<item ID>`, `dialogue:<observed dialogue ID>:<option index>` and `spell:<spell ID>`. Missing IDs are not valid substitutes for identity; do not create an `undefined` catch-all contract. A reused interface ID is not sufficient unless the inspected server guarantees the same XP bound for every reachable context of that key.

Without a matching curve and command bound, capped Attack/Prayer work stays unavailable/refused. Known uncapped Strength/Ranged methods can still run. Pure-build dialogue selections (including production dialogs) and spell rewards need an audited effect contract; zero-combat-XP production can be represented explicitly, but is never assumed from a label such as Make All. Unsupported reward semantics block that action. This can leave a particular support method unavailable: inspect diagnostics and add the missing server evidence or choose an already supported method, rather than disabling the XP guard.

## Diagnostics and rollout

After merging, stop the existing sole watchdog/controllers, preserve runtime configuration and journals, pull `main`, run tests, and restart once. A repository merge does not update a process already running on the user's machine.

Run `bun scripts/agency-status.ts` from the repository root. It reports current profile, source URLs, caps, protected XP, alternatives, training leads, missing XP-rule status and parent-linked support goals. It does not read authentication or mistake legacy `agency-memory.json` for current state.

The earlier hierarchy work is included. **Astra's historical SQLite move/dialogue reconciliation is not fixed by this change.** The advanced controller's shared imports are regression-tested, but it does not yet load this standard controller's optional build-rule file or use TrainingDiscovery's new site/trip path. No live login, deployment, paid API call, or PvP action was performed.

## Research basis and verification

The supplied research is preserved in `RESEARCHED_BUILDS_SPEC.md`, including source URLs and limitations of the earlier guide retrieval. We implemented from that specification; no claim of a new comprehensive web review is made. No source licenses or private server data have been copied into the guide catalogue.

Offline verification uses Node 22.16.0 and Bun 1.3.10. Tests cover eligibility from different observations, exact Defence labeling, bounded Attack/Prayer training, mixed styles, unknown reward refusal, restart preservation, no automatic three-loss cap removal, source-gated training recommendations and whole-trip comparisons. Integration scenarios exercise the real shared episode with simulated game input/output. These are not live-server or endurance tests. See the PR's final verification summary for exact results.
