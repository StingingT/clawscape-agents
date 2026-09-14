# Legacy navigation recovery and Astra worker readiness

## Observed blockers

The shared controller returns from `runEpisode` when `recoverLegacyJournals` is unresolved, BEFORE its newer v2 navigation settlement logic. Previous recovery accepted `walkTo` only through destination-arrival evidence. That leaves an interrupted old route blocked even when the character is now stationary. A label such as `bank-for-fishing-tool-funds` is not proof of the operation type: inspect the original receipt's `type`.

Astra's worker had a 15-second startup deadline. User measurements showed approximately 16 seconds for a standalone initialization and 22–27 seconds for the shared agents. These measurements make the short deadline a plausible cause; they are not a live test of this patch.

## Legacy recovery

Only exact `walkTo` and `retreat` operation types enter the new interrupted-navigation path. They need fresh connected observations, explicit idle/out-of-combat state, stable position, life, world/epoch, health, inventory/equipment and other observed activity. Known historical life/plane/epoch mismatches remain unresolved. A local client session may change; it cannot inherit an earlier settling window.

The same controller observes at least **30 seconds** of quiet state across recovery attempts. Changed state, stale/replayed ticks, clock rollback, a gap exceeding 60 seconds, a different controller instance, or changed source-journal contents resets that window. Missing evidence keeps the record blocked with a specific reason. Waiting offline does not qualify. No gameplay action is sent by the recovery helper.

The result is `disposition: accounted`, `outcome: interrupted` in the hash-scoped `legacy-recovery.json`. The original file and byte-identical backup are retained. No success, arrival, failed execution, reward, or completed strategic goal is invented. The v2 goal/learning file is not modified by legacy recovery. Known obsolete synthetic planner bookkeeping can be accounted only after the real legacy executor is settled; other pending executor history still blocks execution.

Purchases, sales, withdrawals, deposits, crafting, dialogue, pickups, NPC interactions and unsupported operations are NOT retired by this rule, even when their names contain `bank`, `route` or `training`. Their existing evidence requirements remain. This is not a force-clear switch.

## Astra readiness

The default deadline is **60 seconds from worker creation**, not 60 seconds after each progress update. Readiness cancels the timer. Genuine timeout/failure terminates the worker, rejects pending waiters, and cannot be undone by a late `ready` message.

Structured `astra-collision-worker` diagnostics go to the normal error log. They report the last stage, elapsed milliseconds and a bounded error code: resolving the checkout, loading contracts, importing pathfinding, importing the pathfinder module, initializing, hashing collision data, applying hazards, and ready. Raw exceptions, configuration contents and credentials are not included in these diagnostics.

The default worker factory explicitly forwards the controller's current environment. An offline reproduction on Bun 1.3.10 showed that a worker otherwise missed environment changes made after process startup. The native worker tests cover selecting a temporary checkout via a just-set `CLAWSCAPE_UPSTREAM`, so the validated path is not silently lost between startup and the worker.

## Validation

- 111 Node tests passed, including 13 legacy-navigation and 8 controlled-clock readiness regressions.
- 7 executions of the actual shared `runEpisode` with simulated game I/O passed. The new scenario starts with an old navigation receipt, sends no movement before settlement, then completes three route legs and one real goal.
- 57 focused native Bun tests passed, including actual worker initialization and failure with temporary local dependency stubs.
- Controller syntax and scoped strict TypeScript checks passed, including the changed navigator and startup protocol.
- Full local native comparison: baseline 386 passed / 14 failed / 2 module-load errors; patch 409 passed / the same 14 failures / 2 errors. The unavailable upstream/map fixtures are not supplied by this patch. This is not a fully green full-repository claim.

No production configuration, live credentials, character state, paid API or server connection was accessed. No live or endurance run was performed. A surviving process is not proof of a logged-in or productive character.

## Applying locally

Stop the existing watchdog and confirm its agent processes have exited. Pull the merged main in `C:\Users\guyro\Documents\Guy\clawscape-agent`, run your tests, then start the existing watchdog once. Do not erase journals, merge database files, overwrite local configuration, or run a second controller.

Legacy navigation may initially report `Legacy navigation settling`; allow at least 30 seconds of verified quiet observations plus the normal retry interval. If it remains blocked, read its specific `legacy-recovery.json` reason and operation type, rather than repeatedly resetting files. Astra can spend up to 60 seconds preparing the collision worker before the login stage; its new error-log diagnostics show where it is spending that time.
