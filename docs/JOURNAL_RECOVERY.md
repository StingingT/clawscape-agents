# Startup and legacy journal recovery

## Scope

The launcher now reports a precise startup stage and sanitized error even when importing the advanced runtime fails. The watchdog launches `agents/advanced/src/live-entry.ts` and reads status belonging to that exact child process, rather than using an old status file as the reason for a new exit. Required configuration, owner CLI configuration, compatibility profile, collision assets and journal consistency are checked; worker startup failures and timeouts no longer become silent waits.

This is a source-level repair. It cannot supply private runtime configuration or resolve a genuinely unknown transaction without evidence. GitHub source is not the running machine's SQLite journal, saved before-state, CLI authentication or current character state.

## Keep the existing runtime together

Code is in `agents/advanced`, but a prior installation used the sibling directory `../clawscape-autonomous-agent`. Moving code did not move its private `config.local.json`, `docs/compatibility-profile.json`, `data/astra-live/journal.sqlite`, agency checkpoints or relative CLI-home configuration.

The launcher uses a configured `CLAWSCAPE_ASTRA_HOME` or `--runtime-root` first. Without an explicit home it recognizes the established sibling layout only when that choice is unambiguous. When both layouts contain configuration or durable state, it stops with `AMBIGUOUS_ASTRA_RUNTIME_HOME`. It does not combine two character histories or silently start with an empty journal. Resolve ambiguity by explicitly selecting the correct complete runtime home; do not delete a journal just to remove the warning.

PowerShell example (replace the path with the actual existing runtime directory):

```powershell
$env:CLAWSCAPE_ASTRA_HOME = 'C:\path\to\clawscape-autonomous-agent'
$env:CLAWSCAPE_UPSTREAM = 'C:\path\to\clawscape-server-checkout'
bun agents/advanced/src/live-entry.ts run --seconds 120
```

`CLAWSCAPE_UPSTREAM` must refer to a local compatible server checkout containing `sdk/pathfinding.ts`, `sdk/collision-data.json` and the rsmod pathfinder module. Without an explicit override, Astra checks its configured `game_root` and its previous relative upstream location. The same override is recognized by the shared catalogs and navigation worker. A GitHub URL is not a local checkout, and compatible collision exports may still need to be built by the server tooling.

No config, authentication file or secret is copied into GitHub by this change. All runtime paths above remain local. Startup status is stored in the selected runtime's `data/astra-live/status.json`, with a launcher status at the packaged code's `data/astra-launcher-status.json`.

## Recovery on restart

Astra obtains a **reconciliation lease**, not execution authority. The arbiter cannot dispatch ordinary commands while that lease is in reconciliation mode. The launcher reads two fresh own observations and checks the executor ledger, the v2 task/safety receipts and the old planner sidecar before promoting the lease to normal execution.

- A journaled `QUEUED` command is cancelled locally when the ledger shows dispatch never began.
- An already terminal, matched executor result is reused; no command is sent again.
- A pending durable transfer may be reconciled from exact requested balances in two stable observations. Identity, character life and known server epoch must agree. Unrelated inventory/bank activity, unknown slots, deaths or insufficient observations keep it unresolved.
- A local client UUID changing does not by itself erase durable evidence. This relaxation is restricted to specific durable/set-state operations; it is not a license to reuse old NPC indices, combat targets or dialogue context.
- Post-dispatch failures, transport timeouts and cancellations whose effects may still complete are **not** treated as proof of rejection.
- The obsolete `agency-memory.json` per-click planner record is a duplicate bookkeeping record, not an executor. Its known synthetic format may be archived only after the real executor history is established and settled. This does not assert that the old planner's goal succeeded or add synthetic learning rewards.
- An inconsistent/missing executor database is not replaced with a new empty one over existing v2 receipts.

The original legacy JSON files remain unchanged. Recovery first makes byte-for-byte, hash-named backups under `journal-backups/`, then writes a hash-scoped `legacy-recovery.json` receipt. Changed files are inspected again. `startup-recovery.json` lists unresolved command IDs and the reason more evidence is needed. Repeating recovery does not replay actions or double-count terminal results.

Shared controllers perform the equivalent conservative legacy JSON check during their normal startup. Unresolved legacy mutations prevent ordinary gameplay; there is no "force clear" switch.

## Read-only inspection and explicit reconciliation

Inspect a shared profile's JSON journals without contacting the server or changing files:

```powershell
npm run journals:inspect -- --data-dir data/stinger --agent stinger --world clawscape
```

Use the actual configured world value, including the URL when that is how the profile was initialized. Identity mismatches must be investigated, not edited away.

For Astra, stop its cooperating controller before using its local reconciliation command:

```powershell
bun agents/advanced/src/live-entry.ts reconcile --runtime-root 'C:\path\to\existing-astra-runtime'
```

This command reads current state; it does not log in, dispatch gameplay, buy, transfer, eat, or start the planner. It requires the owner CLI already to be able to obtain fresh connected observations. A normal `run` may establish a connection and then performs the same checks automatically before enabling gameplay. Existing known-hazard checks remain in force.

If the report is `RECONCILIATION_REQUIRED`, review the identified original executor receipt and authoritative server/owner records. No elapsed-time assumption or generic "failed" flag is sufficient evidence. The source repository alone cannot establish what happened to a particular live purchase or a lost item. A missing or access-restricted server repository cannot be used to infer death rules, transaction idempotency or safe inventory loss values.

## Operational verification

The patch includes offline tests for queued/no-dispatch recovery, exact transfers across local restarts, unknown effects, identity and epoch changes, manual takeover, immutable backups, duplicate recovery, runtime-home selection, failed imports, missing configuration and map-worker readiness. Actual launcher processes are tested only with isolated temporary directories and no live credentials. No live character or server is used in these tests.

After pulling the new commit, restart the watchdog so it uses the new launcher. Read the newly timestamped status and recovery report. Code installation and passing offline tests are not proof that Astra is online or that a genuinely unresolved transaction has been resolved.
