---
name: goal-prerequisite-planning
description: Compare ways to achieve a self-chosen game objective, recursively resolve missing items, skills, access and combat readiness, create bounded temporary goals, and reconsider stale intentions. Use when selecting an approach, encountering a prerequisite, or reviewing a blocked or obsolete goal.
compatibility: Design for the Clawscape Director and optional local Ollama advisor. Requires runtime integration with the shared catalogue, authoritative observations, persistent goal state and registered executors. The phase-1 runtime implements a bounded subset; see IMPLEMENTATION.md. This document never authorizes actions.
metadata:
  version: "1.1-runtime-phase-1"
  status: "phase-1-shadow-by-default"
---

# Goal and prerequisite planning

## Purpose

Choose a reasoned approach to an agent's own objective. Work backward from the desired outcome to its prerequisites, then perform the next currently supported step. A requirement that is not met today may justify development; it is not automatically an impossible goal.

Do not prescribe an item, location, recipe, monster, skill level or preferred acquisition method. Query those facts from the current world catalogue and the agent's evidence. Roles influence preference, not mandatory behavior. Preserve explicit user build restrictions, expenditure limits and risk boundaries.

## Authority

This skill proposes plans. It cannot change game facts, waive restrictions, dispatch arbitrary commands, start paid services, authorize PvP or alter another agent's goals. Use the existing Director and executor as the sole action authority. Local model advice must reference supplied facts and method IDs; independently validate it before selection.

Share sourced world rules and recipes. Keep inventories, capability readiness, consent, preferences and observed experience attributable to each agent. A prediction is not an observation. An available method in another agent's executor is not proof that this agent can execute it.

## Planning procedure

### 1. State the outcome and why it matters

Record the parent objective, current purpose, an observable success predicate, urgency, protected resources and review conditions. Distinguish an exact item requirement from a requirement that any suitable substitute can satisfy. Do not turn alternative items into a shopping list of mandatory ingredients.

Inspect carried, equipped and remembered bank stock separately. A remembered bank item may justify a bank visit, but not a purchase, withdrawal or crafting action without appropriate fresh state. Check whether the outcome is already satisfied.

### 2. Compare approaches before committing

Enumerate source-supported alternatives, including mixtures of methods at intermediate steps: use owned stock, produce, gather, purchase, obtain drops, use a suitable substitute, or request cooperation where supported. Do not always buy, always manufacture, or always train first.

Compare whole-route preparation and execution: travel, prerequisite training, input acquisition, time, coins, likely losses, uncertainty, repeat demand, useful outputs and role preferences. Compare against the agent's other live goals. Present estimates as estimates; do not claim a globally optimal plan from a bounded search.

A short-term supply approach and a longer-term self-sufficiency objective may coexist, but each needs a separate purpose and budget. Do not postpone a small urgent need for a disproportionate development project without a reason.

### 3. Classify each missing prerequisite

| Missing requirement | Permitted planning response |
|---|---|
| Item, tool or funds | Resolve acquisition recursively; check reusable tools and reserved stock before obtaining more. |
| Skill requirement | Compare training to the required threshold with bypassing that production step or changing approach. |
| Travel or facility access | Create supported travel, access-unlock or information-gathering subgoals. A distant facility need not already be nearby to be a strategic lead. |
| Combat readiness | Compare a safer source, affordable equipment or supplies, tactical changes, training, or voluntary cooperation. |
| Uncertain information | Create a bounded verification step. Unknown is not false, and neither is true. |
| Temporary availability | Recheck when the relevant condition may change, or select another method; do not idle without a deadline. |
| Missing software executor | Report an implementation gap and choose another executable approach. Character training cannot supply missing code. |
| Explicitly prohibited or unavailable world rule | Keep the restriction. Do not invent a training or exploration fix. |

### 4. Build only the needed development subgoals

For a skill prerequisite, obtain the required threshold and XP rules from source-backed data. Query training actions beyond the target item's own recipe chain. Choose activities that are feasible at the current level, with obtainable inputs and usable executors. Training may produce a different item from the final target.

Value genuinely useful training outputs: needed equipment, later ingredients, justified collection items, or saleable surplus. Do not repeatedly manufacture useless stock merely because the activity has positive XP. Account for XP and output from one action together, without charging for the action twice or counting its materials twice.

Training a related gathering skill is optional. It is justified only when the selected sourcing or training plan requires it or its measured longer-term benefit warrants a separate goal. Purchased or owned materials may eliminate that requirement.

Use milestones and bounded batches. Predict learning for comparison; confirm XP and levels from observations. Stop at the useful threshold and return to the parent goal. Do not extrapolate an activity marker into invented numerical XP or level gains.

### 5. Treat difficult encounters as a choice, not an obligation

Use evidence about damage, supplies, equipment, positioning, escape and encounter success. Do not reduce readiness to an arbitrary combat-level target. Compare changing the source with preparing for it.

Only propose cooperative execution when the server rules and the relevant executors support it. A request is not agreement. Each participant may decline. Require an agreed purpose, available participants, coordination and a valid way for the requester to receive the outcome. Do not presume shared loot or another player's inventory. Bound recruitment time and reconsider after refusal or timeout.

### 6. Persist the reason for every temporary goal

Each subgoal must retain its parent, selected approach, prerequisite predicate, evidence, expected benefit, stopping condition, budget and recheck trigger. Keep the original objective rather than replacing it with an unrelated training task.

Recognize verified child progress even before the parent's item count changes. Do not call productive prerequisite training a stall solely because the final item has not appeared. Still enforce the parent budget; changing subgoals or restarting must not reset expenditure or risk limits.

Do not endlessly pursue prerequisites. Detect cycles, mutually impossible dependencies, exhausted budgets and insufficient search coverage. Report a truncated search as incomplete exploration, not proof that no approach exists.

### 7. Execute one verified step and review

Before dispatch, re-observe relevant state, validate the selected method, check requirements and reconcile pending actions. Execute through the normal executor only. Afterward, attribute actual progress, material use, time and losses to the step and parent.

Reconsider on meaningful changes: the requirement is satisfied, a milestone is achieved, supplies or access change, a relevant method fails, cooperation changes, or a review budget expires. Avoid switching approaches every observation for negligible score changes. Do not stay committed merely because time was already spent.

If the parent is satisfied by another means, cancel unnecessary descendants. Persist only still-justified longer-term objectives, with an explicit new reason rather than silently continuing old work.

### 8. Separate knowledge from intentions

A location, recipe or historic task is not a standing instruction. A legacy seed must not become an objective solely because it is in a route dictionary. An exploratory objective is legitimate when the agent selects it for current curiosity, knowledge value or another evidenced purpose within budget.

Review active goals and queued plans after policy or catalogue changes. Archive obsolete intentions without deleting useful world facts, observations or experience. Require a fresh reason to select an archived target again. Retirement must survive restart and must not be undone by reseeding old defaults.

## Decision summary

Return a brief auditable decision record, not unrestricted action text:

- Parent objective and observable target.
- Compared approaches, key estimates and evidence references.
- Chosen approach, temporary subgoals and why they serve the parent.
- Next supported method or the specific unresolved blocker.
- Success, cancellation and re-evaluation conditions.

All IDs and factual requirements must resolve against supplied data. The runtime, not this text, enforces schema, budgets and executor safety.

## Supporting design

See [runtime integration](references/RUNTIME_DESIGN.md) for the proposed implementation contract and acceptance scenarios. See [source findings](references/SOURCE_FINDINGS.md) for what was actually verified in the uploaded code. These references retain the original design and audit. See IMPLEMENTATION.md for the tested runtime subset and rollout status.
