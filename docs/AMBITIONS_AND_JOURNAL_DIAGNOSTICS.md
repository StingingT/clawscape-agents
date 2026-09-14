# Personal ambitions and recovery evidence

## Motivation is not a combat restriction

The live hierarchy is **role preferences → personal ambition → strategic objective → support goals → methods → actions → observed review**. The optional combat build is a separate constraint on skill development, not the character's profession.

The standard and advanced controllers share these first-class ambitions:

| Ambition | Main priorities |
| --- | --- |
| Equipment maker and collector | Production, useful equipment, materials and recipe/item investigations |
| Resource mastery | Efficient gathering, tools and dependable supply trips |
| World explorer | Meaningful destinations and safe access |
| All-skill mastery | Broad progression toward mastering every skill, with weak supported skills receiving additional priority |
| Unrestricted combat mastery | Useful combat development, including Defence and Prayer |
| Comparative build experiment | A deliberately motivated comparison of restricted combat progression |

Initial choice uses role preferences, never character-name checks. Economy preferences favour equipment making and collection; resource preferences favour gathering. Generalist/completionist role preferences are balanced and support all-skill mastery. No number of pures or maxers is imposed on the population.

An active objective is retained through its preparation and failed steps. Creating an initial ambition label may happen alongside an existing objective but does not replace it. Later ambition changes require multiple completed personal objectives, a sufficiently stronger alternative and a recorded explanation. Support preparation, old per-click pseudo-goals, failures and elapsed time do not count as new life achievements. A broad range of verified achievements can motivate all-skill mastery. Different characters' memories are not shared.

An ambition biases **strategic ranking only**. It never overrides feasibility, funds, safety, a pending receipt or protected XP. Crafting can still need combat, and a combat dependency does not make a crafter adopt a pure. The normal unrestricted development strategy is explicitly compared with pure profiles rather than being a fallback when no pure qualifies. Pure adoption needs a separate comparative-build ambition and personal evidence; a newly obtained weapon or available style alone is insufficient. A combat-oriented agent can develop that question after several distinct, loss-free offensive training objectives that preserved one Defence.

Existing deliberately adopted pure restrictions are retained. This patch does not silently raise any cap, erase protected XP or end a pure. All combat strategies, including unrestricted development, may consult the existing sourced training leads without adopting a guide's restrictions. Leads still do not prove live access or mechanics.

**Scope:** these ambitions guide existing executors. They do not implement every skill, a comprehensive equipment/recipe collection tracker, PvP, quest completion or a full maxing route. Unsupported ambitions stay aspirational; the controller must use supported methods or report a capability gap. No server-specific XP tables, combat formulas or prices were added.

## Astra's historical dialogues

A `startup-recovery.json` containing unresolved `dialogue` entries does not identify what the options meant. A closed current interface, unchanged inventory or an old timestamp cannot prove that an earlier choice had no reward or delayed effect. The patch does not retire such records by timeout.

Startup reports now include each unresolved action's original status, hashes, original checkpoint count, snapshot number and (for dialogue) the original interface, bounded dialogue text/options and selected option. Missing or ambiguous original checkpoints are explicitly reported, not reconstructed from later observations. The status summary includes `unresolvedJournalCount`, so `pending: []` no longer suggests that all failed historical records were reconciled.

This command inspects the **existing local SQLite journal read-only**, without a game login, controller takeover, migration, settlement or replay:

```powershell
bun scripts/astra-recovery-report.ts > .\data\astra-recovery-details.json
```

For an intentionally different runtime home:

```powershell
bun scripts/astra-recovery-report.ts --runtime-root "C:\path\to\advanced" > .\data\astra-recovery-details.json
```

The default is `agents/advanced`. Missing databases are never created. At most 100 unresolved records are displayed, with an explicit total and truncation flag. The export excludes account configuration, lease/session tokens, full inventories and arbitrary command payloads; credential-looking dialogue text is redacted. It remains private runtime evidence and is not a file to commit to GitHub.

This report makes exact reconciliation review possible; **it does not itself unblock the five historical dialogue actions** or authorize repeating them. Authoritative effect evidence or a separately reviewed recovery decision is still needed.

## Stale item slots and test exits

New `useItemOnItem` actions bind both observed item IDs before the final state refresh. Missing/ambiguous/empty slots or changed item identities are refused before a new pending intent is written. Both items are validated again at authorization. Existing incomplete receipts keep their historical uncertainty; a missing pre-state item is not proof of non-execution.

An expected-failure startup test previously restored `process.exitCode` to `undefined`. In the pinned Bun 1.3.10 runtime this leaves the previously assigned `2` in place. Cleanup now explicitly restores the saved code or zero; a child-process regression checks the real test process's exit status. Production error codes and the watchdog's success gate are not bypassed. Do not start a watchdog based solely on a parsed `0 fail` summary when the process exits nonzero.

## Deployment

Preserve all local configuration, knowledge and journals. Stop the sole watchdog/controller before pulling updated source. Run tests and check their exit status before restarting once. GitHub validation is offline; a merge is not a live deployment or an endurance test. Inspect `bun scripts/agency-status.ts` for the selected **ambition**, separate combat **strategy**, objective and blockers rather than interpreting every listed alternative as an adopted build.
