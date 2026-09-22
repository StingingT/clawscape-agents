---
name: adaptive-experimentation
description: Learn from verified outcomes, select useful bounded investigations, compare equipment and approaches under recorded conditions, and feed evidence into goal and prerequisite planning. Use alongside the existing Director rather than as an independent controller.
metadata:
  version: "1.0-design"
  status: "proposed; not runtime-integrated"
---

# Adaptive experimentation

## Purpose

Continuously learn from available observations. Deliberately experiment when the expected information or development benefit justifies the time, resource use and risk. Learning is ongoing; investigation is a chosen activity, not a requirement to interrupt productive work after every observation.

This is a companion to goal-prerequisite-planning. It proposes decisions through the existing Director and registered executors. It does not authorize commands, override restrictions or prescribe particular monsters, items, destinations or permanent character builds.

## General loop

1. Identify a useful uncertainty: what might change a present or foreseeable decision?
2. Inspect personally observed evidence, attributable shared evidence and source-backed rules separately.
3. Compare acting with the current best-supported approach against obtaining more information.
4. Propose the smallest affordable test that can answer a useful question.
5. Record a prediction, comparable conditions, outcome measures, resource limits and stop conditions before dispatch.
6. Execute one supported step under the normal safety, ownership and pending-action rules.
7. Reconcile observations, distinguish measurements from estimates, update uncertainty and reconsider the parent objective.

All routine supported activities may supply evidence. A formal experiment is not required for every learning update. However, an unplanned observation is not automatically a controlled comparison.

## Progressive combat investigation

Begin from an appropriate, defensible baseline for the agent's current equipment, skills, supplies and encounter knowledge. Do not force a capable character to restart at the weakest monster after every upgrade.

Use displayed monster levels as a candidate-search aid, not as the sole readiness test. For a progression trial into unfamiliar opponents, allow configurable steps of 1–10 levels from the relevant tested baseline. This is a search constraint, not an instruction to escalate after a win or a claim that nearby levels have equivalent risk. It does not prevent useful retests of familiar opponents or selecting an already-supported harder opponent for an ordinary goal.

Check target identity and variant, attack behavior, access, equipment and ammunition compatibility, starting health, food, escape options, and any verified special requirements. Greater uncertainty requires a smaller or more conservative test, not an invented assurance of safety. A bounded low-risk probe can gather missing evidence when ordinary safety checks permit it; perfect statistical certainty is not a prerequisite for every first encounter.

Test a limited batch, review the evidence, and choose among repeating, changing conditions, selecting a different opponent, returning to productive work, or preparing for a later trial. Do not promote a target to "safe" after an arbitrary small number of wins. Difficulty progression must be evidence-dependent, not a fixed creature list.

## Record the actual context

Persist a stable encounter ID and source/event references. Include the agent, server/rules profile, session/life identity, target type/variant and encounter identity, location and relevant environmental conditions.

Record exact observed base and effective combat skills; starting and ending health; equipped item IDs and observed bonuses; weapon, ammunition and selected attack style; observed prayers and temporary effects; solo/cooperative status; other combat participants; and any change during the encounter. Unknown conditions must be explicit.

A full equipment comparison cannot be keyed only by weapon name and a ten-level Strength/Defence band. Keep a detailed immutable context with each sample. Similarity-based aggregation can be added for prediction, but it must retain uncertainty and must not silently merge different conditions into an exact match.

## Measurements

Measure where reliably observable:

- Outgoing damage attributable to this agent and target, incoming damage attributable to its actual source, and elapsed combat time.
- Verified kills, retreats, deaths, interruptions and unresolved outcomes. NPC disappearance is not sufficient kill evidence.
- Per-skill XP changes; ammunition, runes, food and other consumed resources; verified spending and losses.
- Full-trip preparation, travel, recovery and return costs, kept separate from combat-only performance.
- Attack attempts, hits/misses and hit rate only when the event stream actually supports those measurements. No damage event does not by itself prove a miss.

Keep direct observations, estimates, lower bounds, missing fields and incomplete event coverage distinguishable. HP change alone cannot be silently promoted to exact incoming damage. Do not invent numeric values from qualitative narration. A retreat supplies readiness information; it is not a completed kill with zero kill time.

Deduplicate repeated observation windows. Do not merge encounters across respawns, reused NPC indices, restarts or changed world profiles. An interruption remains unresolved until the existing reconciliation rules establish an outcome. Missing evidence is not success, failure, or zero damage.

## Separate readiness comparisons from equipment experiments

A readiness comparison asks: "Does my current overall configuration perform better than the earlier one?" It may compare different levels and equipment, but cannot assign the difference to a specific change.

An equipment experiment asks: "What changes when I use this weapon, ammunition, armour piece or equipment set under comparable conditions?" Keep other measurable factors matched when feasible. Alternate tested equipment within matched blocks rather than always finishing the old configuration first. Keep encounter-level samples so changes in skills or boosts can be detected and split into new contexts.

If several factors change together, label the result as a whole-configuration comparison. Do not assert that the weapon, armour or a particular skill alone caused the improvement. Statistical modelling may support qualified predictions, but those predictions remain distinct from observed controlled comparisons.

Levels cannot be rolled back simply to repeat an earlier test. Historical comparisons therefore remain contextual evidence. Equipment requirements come from the applicable catalogue and current state. The agent must never equip unusable gear or silently train a protected skill for an experiment.

An agent-chosen specialization may be reviewed through the existing development process when evidence justifies changing it. Explicit user restrictions remain binding. Do not turn an inferred role preference into a permanent build constraint.

## Confidence, relevance and retesting

Keep sample count, variability, failed or interrupted trials, context coverage and source quality alongside averages. Repeated reports of one encounter are one sample. A handful of easy kills gives provisional evidence, not a universal conclusion.

Trigger review when a relevant level, item, attack style, supply constraint, enemy behavior or server rule changes; when observed outcomes differ materially from predictions; or when uncertainty now matters to a current decision. Preserve old measurements as historical evidence rather than erasing them.

Retest informative benchmarks, not necessarily the weakest opponents. Rank possible tests by relevance, expected information, cost and safety. Do not test every gear combination or endlessly repeat a solved comparison. Reconsider before each new encounter, and stop sooner on danger or resource exhaustion.

## Feed learning into practical goals

The planner should use contextual evidence for opponent selection, source acquisition, equipment development, temporary skill training, supplies, budgeting and realistic readiness forecasts.

Diagnoses should produce alternatives, not mandatory prescriptions. Low observed damage might justify testing another style, weapon, ammunition or opponent, or developing a relevant skill. High incoming costs might justify equipment, positioning, food, a different target, supported voluntary cooperation, or postponement. Uncertain causes should lead to an appropriate test rather than a fabricated diagnosis.

Every deliberate investigation retains its purpose, parent goal or bounded curiosity objective, hypothesis, compared choices, stopping condition and budget. Productive learning can advance an investigation even without obtaining the parent's final item; merely waiting or repeating identical data does not.

Share attributable encounter evidence with all agents. Another agent's result is evidence conditioned on that agent's levels, equipment and circumstances—not proof that the receiving agent is equally ready. Do not conflate shared world facts with personal capability estimates or consume another agent's inventory without consent.

## Safety and execution authority

Urgent survival, pending-action reconciliation, protected resources, consent and explicit restrictions outrank investigation. Use conservative loss and supply budgets plus a credible escape plan. No attempt to "get one more sample" may overrule retreat conditions.

Experiments may accept bounded affordable losses already permitted by the agent policy, but curiosity must not create an unbounded death loop. Missing party, travel, spell, loot or equipment executors remain implementation gaps. Do not create fake methods to make a trial look executable.

The reasoning document does not train or fine-tune a model. Persistent observed records and calibrated estimates drive the proposed behavior; optional local model advice is a hypothesis subject to normal runtime validation.

## Runtime integration plan

Extend existing mechanisms rather than create a second controller:

1. Extend the existing combat-event and TrainingDiscovery recording paths with context-complete samples, outgoing/incoming damage attribution and quality flags.
2. Preserve existing coarse historical aggregates as legacy evidence; do not manufacture exact contexts for them.
3. Add confidence-aware comparable-context summaries and queries to the same learning system.
4. Add bounded investigation candidates to the existing Director. Goal/prerequisite planning may choose them when they serve a current purpose.
5. Register only executable combat methods. Report missing telemetry and executors explicitly.
6. Expose observed context, sample count, confidence, proposed next test and selection reason in the goal report.
7. Keep passive recording, proposal-only evaluation, bounded live experiments and intention cleanup as independent controls. A document or proposal-mode setting is not live action authority.

This specification is bundled with adaptive-combat-20260922.3. Implemented scope and independent activation controls are described in IMPLEMENTATION.md. Not every aspirational scenario is an enabled executor: see those boundaries before starting a pilot.

## Acceptance scenarios for the revised patch

- Two trials with different Attack levels, armour or ammunition do not share an exact-context record solely because their weapon and coarse skill band match.
- Changing both skills and equipment produces an overall-readiness comparison, not a claimed isolated weapon benefit.
- A gear change can justify a relevant retest without resetting progression to the weakest opponent.
- Repeated observations of the same event do not multiply the sample count; external damage and NPC-index reuse do not become personal evidence.
- Missing hit/miss telemetry prevents hit-rate claims; incomplete combat-event coverage remains marked incomplete.
- Damage, supplies and duration from retreats and interrupted encounters are retained without inventing a kill.
- New unknown opponents obey the configured progression-step bound and the independent risk checks; a level increment alone never authorizes combat.
- Useful known activities can continue while an experiment is deferred; a learning objective does not force perpetual experimentation.
- Evidence from changed conditions is retained separately and shared with its provenance, not copied as another agent's readiness.
- Protected skills, budget exhaustion, unavailable executors, pending commands and retreat rules cannot be bypassed to complete an experiment.
- Intention cleanup can operate without enabling combat experiments. Shadow proposals alone do not alter live targets or equipment.

## Research basis and inspected source

The comparison design draws on NIST/SEMATECH, *Randomized block designs*: controlling recorded nuisance factors within comparison groups and randomizing test order where appropriate. Reference: https://www.itl.nist.gov/div898/handbook/pri/section3/pri332.htm (accessed 22 September 2026). Application to Clawscape and all policies above are proposed design decisions, not results reported by NIST.

For inspected existing code and exact source excerpts, see the accompanying `CLAWSCAPE_COMBAT_LEARNING_SOURCE_FINDINGS.md`. No claim is made that the specified extension is already active in the agents.
