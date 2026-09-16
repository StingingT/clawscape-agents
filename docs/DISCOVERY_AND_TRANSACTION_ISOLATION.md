# Observed discovery and contained historical transaction uncertainty

This patch addresses two distinct stalls. With no eligible plan, an agent needs
bounded information-gathering candidates. With an unattributable bank transfer,
it must not recreate financial authority merely by renaming or forgetting the
old command. Neither problem is solved with character-specific tasks or routes.

## Reference review: RuneBench and rs-sdk

Reviewed source snapshots, not an independent reproduction of benchmark results:

- RuneBench `ccaf6d77cb0a557220574c5d79ecfa6329c3dbac`:
  [README](https://github.com/MaxBittker/runebench/blob/ccaf6d77cb0a557220574c5d79ecfa6329c3dbac/README.md),
  [task generation](https://github.com/MaxBittker/runebench/blob/ccaf6d77cb0a557220574c5d79ecfa6329c3dbac/generate-tasks.ts),
  [agent instructions](https://github.com/MaxBittker/runebench/blob/ccaf6d77cb0a557220574c5d79ecfa6329c3dbac/shared/agents.md).
  RuneBench evaluates coding agents on timed skill/gold tasks against an
  accelerated game environment. Agents write and run TypeScript using rs-sdk,
  with wiki reference material. It is not itself a persistent multi-character
  goal director or evidence of indefinite autonomous operation.
- rs-sdk `4906fb6e83bb41c699d992bac3763a0723fd5789`:
  [AGENTS](https://github.com/MaxBittker/rs-sdk/blob/4906fb6e83bb41c699d992bac3763a0723fd5789/AGENTS.md),
  [actions](https://github.com/MaxBittker/rs-sdk/blob/4906fb6e83bb41c699d992bac3763a0723fd5789/sdk/actions.ts).
  Its documented workflow starts from current state, tries short programs,
  inspects results, and iterates. The SDK distinguishes low-level dispatch from
  observed effects; high-level operations wait for operation-specific predicates.
  Reachability, open interfaces, and published interaction options matter.

Design inference: adapt the observation/experiment/effect feedback loop and
operation-specific verification, not their fixed benchmark objectives, world
coordinates, accelerated timings, or permissive script execution. Our controller
still has registered executable capabilities; this patch does not add arbitrary
LLM-written program execution or a new model provider. No external source code,
character saves, credentials or reference-specific routes are bundled.

## Discovery candidates and transition effects

Fresh player observations record locally visited cells. When normal selection
has no better executable work, maintenance-priority discovery opportunities can
investigate nearby unvisited cells. Relative endpoints are hypotheses, not
assertions of reachability, safety, or prior visits. Both controllers use their
existing navigator/collision/hazard checks before movement. Refused probes
follow ordinary bounded method/goal deferral. No repeated command earns progress
merely because it was sent.

Supported published structural options are normalized consistently. A staircase
or ladder interaction can be verified by an observed plane change or a large
coordinate transition after the exact observed interaction. Walking up to it is
not traversal. Missing, stale, cross-session/life or dead observations are not
proof. Opening/closing requires a newly observed opposite object state and loss
of the original state; disappearance or an already-open neighboring door alone
is insufficient. Arbitrary Use, Enter and reward/choice objects do not receive
blanket authorization.

Previously selected exploration cannot be replaced by stale local banking
preparation. An open bank is closed before that selected exploration task rather
than initiating unrelated transfers. This is task semantics, not an agent rule.

## Historical bank isolation is NOT settlement

For the standard controller, an unknown bank deposit/withdrawal may be moved to
an immutable `unresolvedTransfers` archive after 30 seconds of continuous fresh,
idle, safe, matching current observations. The archive preserves the complete
original receipt, pending planner intent, goal, evidence and current baseline.
A complete quiet open bank view is also usable; a missing or changing current
view does not pass. Restarts, observation gaps, danger and account/world changes
cannot complete a previous observation window.

An old life/session change is preserved as uncertainty, not interpreted as a
successful transfer, failed transfer, server cancellation or measured loss.
No economic learning or success credit is assigned. Archive capacity exhaustion
fails closed; unresolved records are never evicted to restore authority.

While any transfer is isolated, the agent is restricted to **non-economic
discovery/navigation**, read-only observation, interface closure and tightly
restricted ordinary structural transitions. The dispatch guard rejects all
ordinary banking, shopping, item-use, pickup, production, combat and reward/choice
operations, including equivalent operations with a fresh command ID or slot.
Existing narrowly authorized urgent-survival handling remains separate. The
historical command cannot be replayed or passed off as a newly verified success.

**Limitations:** this patch does not restore economic authority or resolve the
historical bank outcome. That requires a separately audited reconciliation path
with authoritative evidence. It does not automatically isolate shop transactions,
choices, unknown item identities or Astra's dual arbiter/planner transaction
journals. Those retain their existing blocking guarantees. Thus this is a safe
way to make limited independent progress, not a claim that all blocked financial
work can now continue.

## Prevention and diagnostics

New deposits and withdrawals require a complete open-bank and inventory snapshot
before intent/dispatch. Verification uses the captured item identity instead of
an obsolete bank slot, requires balanced inventory/bank deltas, and reconciles
all of the original quantity for a deposit-all/withdraw-all request.

`plannerDiagnostics` reports candidate counts, relevant prerequisites, cooldowns,
capability/risk/budget exclusions and bounded observed local context. Reports also
include isolation scope, preserved command identities, and original referenced
bank items. This separates no feasible plan, failed local routing, missing
observation data and unresolved financial history instead of one generic idle
label. Diagnostics never authorize actions.

## Validation and limitations

The regression suite includes candidate starvation, local probes, refusal without
movement, verified structural transitions, stale/misleading observations,
identity-based bank verification, durable isolation, fresh-ID replay prevention,
and ordinary productive controller behavior. The actual controller's episode and
executor are also exercised with fake game I/O, including an old bank receipt
followed by independent discovery. Shared and advanced regression cases run on
Windows and Linux in CI.

Offline tests do not establish effectiveness on the deployed server. A fresh
status report must show loaded behavior, useful new observations and eventual
ordinary goal progress. Do not erase player memory, clear economic isolation or
seed a particular exit route just to make that report look healthy.
