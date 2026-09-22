# Adaptive experimentation: implemented scope, version 20260922.3

The adjacent SKILL.md defines the intended general behavior. This page distinguishes working runtime connections from the longer-term specification. The code extends the existing TrainingDiscovery and Director action path; it does not start another controller or call an LLM.

## Working paths

- The four main workers (ClawScout, Stinger, Coincrafter and Featherer) record their observed NPC attack encounters through TrainingDiscovery, including ordinary attacks that were not chosen as training tasks. Astra's separate advanced executor is not part of the supplied source and is unchanged.
- Evidence includes exact base/effective combat levels; observed equipment slots/IDs/bonuses, ammunition, style, prayers/effects when exposed; target identity/variant/site/spawn token when exposed; profile, process, life and tick boundaries; starting/ending HP; damage events, HP-decrease lower bounds, net item changes, food use, XP and duration. Missing fields remain unknown. Current HP and prayer points are recorded but are not treated as changes in combat skill capability.
- Own kills require an attributable kill event. XP gain or an NPC disappearing is not proof of a kill. Retreats, deaths, interrupted and unresolved encounters are retained separately. Repeated windows are deduplicated; incomplete event coverage remains flagged. Hit rate is not calculated because the supplied stream does not establish all attempts/misses.
- A level, style, equipment, boost or relevant environment change is recorded during the encounter. Mixed encounters are retained for review but excluded from matched stable aggregates. A new context is used for later encounters; the patch does not invent an exact split time between observations.
- Readiness comparisons assess whole configurations. Equipment comparisons require matching observed controls, opponent/site and starting HP. Multi-slot changes are labelled equipment-set comparisons. Shared or unknown influences preclude an isolated causal claim. Counts and variability remain visible; two samples qualify only for provisional decisions/testing, not statistical certainty.
- With `decisions on`, personal comparable measurements influence existing safe target rankings and single-slot carried-equipment preferences. The heuristic considers XP, duration, health costs, food and net supply decreases, not just damage or item tier. It does not claim a universally optimal policy or convert unknown item costs into invented GP prices.
- After at least two matching personal kills, the decision layer limits unfamiliar upward target progression to at most 10 combat levels above a sampled matching baseline (a smaller pilot value is supported). Familiar target types can be revisited after changes, subject to ordinary safety checks. No baseline means ordinary independently validated encounters must establish one; there is no forced reset to level 1. This is an additional candidate-search restriction, never permission to attack.
- A bounded optional pilot lets the agent select an informative carried alternative on a familiar, affordable benchmark, with an ABBA or BAAB order. The current live test executor changes **one slot at a time**. It can compare a supported weapon, finished-arrow ammunition or supported defensive piece. Full equipment-set effects can be recorded and compared, but atomic multi-piece experiment/loadout execution is not supplied.
- Pilot selection uses the reviewed existing GearCatalog and fresh state. It does not assume every item in the larger source catalogue has a complete executable equipment-requirement mapping. Unknown gear requirements, unsupported bows/ammunition, and absent carried variants are not bypassed.
- Pilot attempts are charged before dispatch. Expiry, process restart, changes in skill or experimental conditions, exhausted budgets, confounded outcomes and danger stop/revoke a series. Existing retreat, urgent-need, protected-skill, reconciliation and pre-dispatch validators retain priority. Supply thresholds are based on observed usage; they are not a guarantee that an already-running encounter cannot consume more. Survival is never withheld to meet a testing budget.
- Existing code suggestions for supplies, equipment, training and alternative opponents are exposed in the report. **This version does not automatically create every possible prerequisite-training, party, travel or shopping executor from a diagnosis.** Its new active feedback is target ranking and supported carried-equipment choice. The independent goal-prerequisite planner remains available under its existing controls.
- Each worker publishes a bounded, attributed evidence file. Other workers can see context-bearing benchmark hints, but these are not converted into their own readiness measurements or action authority.

## Independent controls

All commands run in a normal PowerShell from the repository.

```
bun scripts/combat-learning.ts observe
bun scripts/combat-learning.ts decisions on
bun scripts/combat-learning.ts decisions off
bun scripts/combat-learning.ts off
bun scripts/combat-learning.ts status
bun scripts/combat-learning.ts report
```

`observe` enables passive recording and resets decision feedback/equipment experiments to shadow. `decisions on` enables measured choices without enabling deliberate experiments. `off` disables new adaptive recording/feedback/experiments without deleting evidence or stopping ordinary gameplay.

A time-limited single-agent pilot is available separately:

```
bun scripts/combat-learning.ts pilot --agent stinger --minutes 5 --max-encounters 4 --max-food 2 --max-supplies 30 --max-level-step 10
```

The agent is an operator-selected pilot scope, not a forced combat objective. The runtime still chooses whether any useful eligible experiment exists. No carried alternative or insufficient comparable evidence means no forced test. A restart invalidates a live series; an explicit new pilot is needed for another grant. Use `observe` to revoke a pilot, and `decisions on` afterward to retain measured preferences without a pilot. These controls do not enable source acquisition or numeric prerequisite-training action pilots.

Obsolete-intention cleanup remains independent:

```
bun scripts/goal-planning.ts intents on
```

It retires unjustified inherited intentions after pending-action reconciliation, without a destination blacklist and without deleting geographic knowledge.

## Data and reporting

- Existing `data/<profile-folder>/training-knowledge.json` contains `worlds[namespace].adaptive`.
- ClawScout uses the existing `data/online` folder; the other three use their agent folders.
- Last 240 adaptive samples per world are retained, plus bounded experiment history. This is bounded persistent working evidence, **not an unlimited archival journal**. Existing legacy knowledge fields are preserved; coarse old aggregates are not fabricated into exact samples.
- Shared exports: `data/shared/combat-evidence/<agent>.json`, up to 80 recent records each, accepted as fresh hints for up to 24 hours and only for the matching profile/identity.
- Compact export: `share/combat-learning-report.json` (recent samples, groups, comparisons, proposed/active experiment and decision reason). The combined `goal-planning.ts report` also includes adaptive state.
- Exports are saved-state observations with individual timestamps, not a synchronized proof that every worker is healthy.

## Not supplied

No new anvil, remote shop, monster-loot ownership/farming, party, spell-casting or advanced-Astra executor; no automatic purchase of test equipment; no global monster whitelist expansion; no guarantee of complete telemetry; no model training/fine-tuning; no unrestricted gear-set swaps; no new privileges to ignore explicit user build constraints.
