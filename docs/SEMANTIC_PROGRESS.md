# Causal progress and bounded reconciliation

The shared `LiveAgency`/`Director` now owns productive-progress accounting for
both controllers. A verified click or a changed bank/inventory balance is not
itself progress. No character-specific escape task, route, item or memory is added.

## Evidence layers

`memory.progress` separates last verified action, last state change, last
prerequisite/objective advance, registered durable learning, and last productive
progress. Only the dispatched plan lineage, declared durable intermediate facts,
and verified approach toward its endpoint earn causal credit. Re-satisfying a
reversible prerequisite earns no additional credit until downstream production.
Actual gathered cargo banking retains the existing per-item provenance credits;
withdraw/redeposit cycles cannot manufacture gathered output.

Effect-state cycle detection ignores command IDs, ticks, NPC wandering and
inventory slot permutations. Its bounded history survives goal changes/restarts.
Real durable output/learning resets the cycle history; repeated productive batch
operations are not classified by repeating action names.

The existing preparation-streak/recheck bounds still apply. The five-minute
productive deadline reviews stalled approaches only when there is no outstanding
ordinary or safety command. It does not kill a process to escape reconciliation.
New attempts get a bounded opportunity to act without resetting the reported
health clock. The supervisor publishes this read-only health every 30 seconds.

## Unknown outcomes

Normal runtime and advanced arbiter use the same 30-second continuous quiet
observation rules for eligible transient/repeatable interactions. Connected,
alive, idle, increasing, same-world/life observations are required. Recognized
interface-opening operations can settle bookkeeping against a quiet complete
bank/shop view; this does not settle transfers. Active dialogue, threats,
unclassified reward interactions and unknown value-moving transactions do not
become safe through timeout. Existing dialogue-context reconciliation remains
separate from transfer accounting.

Retirement records `interrupted`, preserves the original receipt/journal and
never claims success or dispatches the old packet. Eligible interaction attempts
yield to normal goal selection. The advanced policy clears only its matching
duplicate uncertain checkpoint after the exact arbiter command has reconciled.
Missing historical target evidence remains blocked rather than throwing or
inventing a target.

Discovery enumerates bounded alternatives from fresh observations, and each
controller binds dispatch to the selected target. A refused nearest experiment
therefore need not monopolize the candidate set. No known safe alternative still
means blocked: this patch does not authorize random unsafe exploration.

## Regression coverage

`tests/agency/semantic-progress.test.ts` and
`agents/advanced/tests/semantic-recovery.test.ts` cover transfer-credit accounting,
reversible cycles, legitimate batch progress, persistent health, matching policy
reconciliation, observed alternative selection and safety refusals. The new
regressions run on Windows and Linux; offline controller integration also checks
that legitimate gathering fills and banks a cargo batch.

Live effectiveness must still be assessed with a fresh status export. Passing
offline tests does not establish that a particular running agent loaded this
revision or completed its objective.
