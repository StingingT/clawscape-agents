# Astra source audit — 7 September 2026

8 September live audit update: the dependency is now callable with ordinary CLI
commands; Astra was created and two bounded trials ran. See `LIVE_RELEASE.md`
for exact outcomes and the guard-area recovery blocker. Missing-dependency and
uncreated-character statements below preserve the earlier v0.1 audit only.
The local game checkout remains unchanged, and online revision parity is unknown.

Scope: independent agent in C:/Users/guyro/Documents/Guy/clawscape-autonomous-agent.
Read-only game dependency: C:/Users/guyro/Documents/Guy/tmp/clawscape.
Audited local revision: d177ab6730ec5166db8d28e73c2d7d3bb3b22a27.
The online deployment's exact revision, settings and ownership were not verified.
No new live character or session was created. M0's live-character exit gate is open.

## Instructions, architecture and baseline

No root AGENTS.md or CLAUDE.md exists in the game checkout at this revision.
Read root README.md, CONTEXT.md, docs/development.md, skills/clawscape/SKILL.md,
upstream/AGENTS.md and its referenced upstream/CLAUDE.md.
The latter describes the upstream SDK workflow; the wrapper CLI is the chosen boundary.
Its suggestion to submit bug reports is not authority to make public posts for this task.

Root package: Bun/TypeScript ESM, Zod, SQLite persistence; scripts start, cli, test, check,
lint and browser tests. New Astra project uses its own pinned dependencies and Bun 1.4.2.
No existing game files were edited or dependency installation performed there.

Baseline command from the game checkout:

    bun test tests/cli-lifecycle.test.ts tests/connection-descriptor.test.ts

Result: four lifecycle tests passed, 13 assertions; descriptor test could not load because
the checkout cannot resolve zod. Total: 4 pass, 1 fail/error. This is a dependency baseline
failure, not evidence of a game bug. Full root checks, browser tests and engine acceptance
were not run. Do not report the whole upstream suite green.

## Verified integration points

Paths in this section are relative to the game checkout.

| Concern | Source / finding |
| --- | --- |
| CLI | src/cli.ts main switch: connect, state, wait, act, disconnect. Explicit --character is required for isolation. |
| Credentials | src/local-config.ts home, readConfig, connectionPath. CLAWSCAPE_HOME contains private login and per-owner/world/character descriptors. Never log their values. |
| Ownership | acquireConnectionLock uses OS-held SQLite locks for startup/client lifetime. Runtime busy flag serializes individual action calls, not a long-lived planner's ownership. |
| Client | src/upstream-client.mjs exports startSession from upstream/server/webclient/src/lite/session.ts. Reuse this normal client path, not internal server handlers. |
| Primitive flow | src/cli.ts act -> local POST /action -> src/game-runtime.ts executeBotAction -> lite/LiteClient.ts -> bot/ActionExecutor.ts -> lite/actions.ts / movement.ts -> normal game packets. |
| Validation | lite/actions.ts checks logged-in state, indices/options, item IDs and observed interface state; uses routes and normal operation packets. Some approach interactions can dispatch unrouted and leave the final reach check to the server. |
| Outcomes | ActionExecutor.execute often returns phase=dispatch. success=false can be returned despite a successful CLI transport. No server-side committed action ledger is exposed by this CLI. |
| Tick | src/game-runtime.ts tick is a local counter incremented by the game-tick callback. Environment.NODE_TICKRATE source default is 400 ms; deployment can override it. World.TICKRATE uses that value. Online timing remains unknown. |
| State | upstream/sdk/types.ts BotWorldState, PlayerState, InventoryItem, NearbyNpc/Loc, DialogState, BankState, ShopState; bot/StateCollector.ts provides tick/revision. |
| Coordinates | player.worldX/worldZ are world tiles; player.x/z are fine coordinates. level is plane. |
| Combat | PlayerCombatState.inCombat means a target exists, not necessarily an attack. Fishing/bank targets must not trigger enemy logic just from this field. |
| Dialogue | DialogOption.index is the published option; do not assume product order or zero-based choices. |
| Bank | BankState is authoritative only while open. Deposit/withdraw use observed slots and quantities. Modals can prevent normal inventory operations. |
| Death | PlayerState lifeId/respawnCount give observed client-life changes; they are not global server generations. |
| Navigation | upstream/sdk/pathfinding.ts uses collision-data.json and rsmod. findLongPath is same-plane and can return a partial path. Door handling and missing-zone assumptions require verification. |
| Persistence | src/store.ts is the account service store; src/save-file.ts and docs/persistence.md describe game save durability. Agent learning stays in its own SQLite file, never these stores. |

### Primitive map for the future controlled pilot

This is a source mapping, not an implemented live action adapter.

| Agent behaviour | Normal CLI primitive / inputs | Required observable proof |
| --- | --- | --- |
| navigate_to | act walkTo: x,z,running | Correct world tile/plane; partial scene-edge leg is not arrival |
| interact_entity / fight_target | act interactNpc: npcIndex,optionIndex from current observed entity | Target-specific interaction/combat feedback, not dispatch |
| eat_food | act useInventoryItem: slot,optionIndex matching Eat | Inventory decrease plus HP/consumption evidence accounting for concurrent damage |
| bank_items | act bankDeposit / bankWithdraw: slot,amount | Matched opposite inventory/bank changes; preserve supplies |
| dialogue_step | act clickDialogOption: published optionIndex | Expected new dialog/interface state |
| cooking | act useItemOnLoc: itemSlot,x,z,locId | Correct reachable side, raw/cooked/burnt item change and XP evidence |
| equip_upgrade | act useInventoryItem: observed wear/wield option | Correct equipment slot and compatibility |
| loot_allowed | act pickupItem: x,z,itemId | Allowed visible pile decrease and inventory increase |

None of the source-inspected mappings supplies a server-issued action ID, cancellation
acknowledgement, generation-safe NPC reference or control-fencing token.

## Revision and compatibility

Root README pins rs-sdk source baseline 56b73e08fc01a1d683d7a86d145a494ae945d071.
upstream/server/PATCHES.md identifies vendored LostCity revision 274 and local modifications.
WorldConfig.ts defaults XP rate to 25 with environment overrides. PATCHES.md records a
custom XP curve. Therefore modern OSRS/2004 guide XP tables and progression timings are
not automatically compatible. No general guide was adopted as a verified route.

scripts/audit.ts fingerprints 2,573 local content-script files and 557 engine/client/
bridge source files. See compatibility-profile.json and source-fingerprint.json.
Re-running the audit changes profile IDs when those fingerprints change.
These hashes exclude map assets and deployed environment/config overrides. They do
not attest the live server. A full static map mode is neither exported nor enabled.

## Boundaries and unresolved risks

- Astra's local lease and action reservation protect cooperating instances sharing the
  same database. They do not fence another program issuing direct CLI/game commands.
- Manual takeover cancels queued work. Already-dispatched packets may still take effect.
  The existing CLI has no cancel/status endpoint that can prove otherwise.
- Storing intent before dispatch prevents blind replay, but is not atomic with a server
  commit. Lost acknowledgements require observable reconciliation; unknown effects stay pending.
- Local snapshot sequence and generated session IDs are client-side bookkeeping, not
  authoritative world/spawn identities. Missing server epoch is null. Live writes remain off.
- Threat assessment, reliable escape, stairs, cooking/food replenishment and actual
  combat timings have not been integrated for Astra. Unknown danger is not considered safe.
- Public guides and chat are untrusted evidence. The current evidence validator has no
  fetch capability; future networking needs scheme, DNS/private-address, redirect and size controls.
- Live observation adapter is implemented but untested against Astra, who is not yet
  registered/connected. Raw private config and external CLI errors are not printed.
- Owner-test-account/world choice is unresolved. No assumption of online server
  administration follows from the generic wording in the supplied specification.

## First executable acceptance task

Select a test world and prepare an ordinary Astra character via the intended owner CLI.
Verify the dependency/runtime without disturbing other characters. Read two advancing
snapshots. Implement only a bounded move/interaction pilot through the normal CLI,
with before/after effects, explicit best-effort identity/control limitations, serialized
ownership and a tested stop/takeover procedure. Do not unlock autonomous combat until
that M1 pilot and a credible threat/recovery model pass.
