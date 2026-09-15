# Semantic items, source leads and survey recovery

## Operator commands

From the repository root, `bun run status:export` writes `data/status-report.txt`. Upload that text file; screenshots and whole SQLite journals are unnecessary. This is read-only with respect to the agents: no connect, wait, gameplay, watchdog restart, or recovery mutation is performed. The report collects all four standard profiles and the advanced Astra runtime, current status, compact pending input identities, acquisition dependencies, route failures, and bounded structured recent supervisor logs. Missing/invalid files are warnings, not healthy-state claims. Checkout SHA does not identify the code already loaded by a running process. Historical counters are separately labelled.

Configuration, credentials, complete SQLite journals, opaque log lines, and long policy histories are not exported. Text matching credential patterns is redacted. Review reports before sharing; they still contain game activity and timestamps. The default layout is `data/<profile>` and `agents/advanced/data/astra-live`.

## Identity before slot

A newly selected item action captures the original item IDs, minimum quantities, container, and relevant option text in `itemRefs`. The next fresh snapshot resolves those identities to their current slots. An unrelated item in the old slot cannot substitute for the intended one. Bank stock, merchant stock and carried inventory are separate containers. Secondary metalworking/bow/fishing validators use the same captured identities. No packet is dispatched if a required identity or option cannot be validated. The receipt preserves the actual pre-dispatch snapshot and bound identities, while the API packet contains current slots only.

A requirement missing after selection becomes a `carried:<id>` or normalized item-name support goal, linked to the original objective. An absent item does not mean it is permanently unobtainable. The acquisition adapter compares remembered own bank stock, visible ground items, current/remembered merchant stock, supported gathering recipes, and sourced monster-drop leads. Current stock, prices, encounter capability/risk and collision-safe travel remain mandatory at execution. Visiting a shop, attacking a monster, or reading a guide never satisfies the carried-item predicate.

Initial ammunition dependencies include feathers for owned shafts, a knife for logs, and obtaining finished bronze arrows as an alternative to unavailable arrow tips. Existing production routines remain available. This is not a universal crafting/quest solver: unsupported recipes, unseen source locations, unknown prices and unbounded combat risk can still leave a recorded acquisition blocker. A monster mentioned in a drop table is not automatically an approved encounter. Existing economy, health, ownership, budget, and irreversible XP checks remain in force.

## Historical malformed input

Some old standard-controller receipts recorded a normal knife/tinderbox acting on an inventory slot that was already empty in the saved pre-state. This narrow invalid context can be abandoned after a fresh continuous 30-second quiet window, only with matching actor/world/life/plane and complete inventories, while the target slot remains empty. Its effect remains unknown. No success, item output, non-execution or replay permission is inferred. The original receipt is retained in a bounded local interruption audit. New recipes require new validated identities. Real target items, quest combinations, bank/shop transactions and other unknown operations do not qualify for this exception.

## Drop information: a lead, not a server contract

User-provided website: https://thesneilert.github.io/2004scape/

The site's source and README point to `2004Scape/Server` drop scripts:
- https://github.com/thesneilert/2004scape
- https://github.com/2004Scape/Server/tree/main/data/src/scripts/drop%20tables/scripts

`bun run knowledge:refresh-drops` explicitly refreshes `data/shared/drop-leads.json`. It reads the site's two bounded filename lists as data (never evaluates JavaScript), pins a source commit, and collects literal `obj_add(npc_coord, item_symbol, ...)` entries. At most 96 table files are requested, with size/time limits. The bundled `knowledge/2004scape-drop-leads.json` is a fallback for offline play. No web or paid API call is made by loading that cache.

All imported entries remain `unverified`, with retrieval date, source URL, revision/hash and `rate: null`. Branch probabilities, nested rare tables, configurable default drops, aliases and complete quest conditions are not inferred. Conflicting quantities are recorded as unknown. This is deliberately **not a claim to have imported every drop**. Monster labels initially derive from the source filenames and are matched to personally observed or existing local-catalogue names; ambiguous/unmatched sources remain non-executable. The user's customized Clawscape server may differ. Personal acquisition is observed separately, and one pickup does not validate an imported drop rate or silently share individual knowledge between characters.

## Surveys

Survey feasibility tests the target and its immediate neighbouring tiles through the existing collision/coverage checks, within a bounded assessment window. The selected approach is retained for navigation. Reaching an approach is positional survey evidence, not evidence that a bank, door or other service was operated successfully. A failed source route records the actual reason and a temporary retry condition; it is not universal proof of permanent unreachability. Standalone surveys can yield, while failed investigative support leaves the crafting/combat parent intact. Elapsed cooldown or relevant new capability/learning permits reassessment.

## Combat evidence

A public kill event may omit damage. The normalizer preserves it only with valid tick, source identity and NPC target identity. An explicitly observed own-player index is preferred; the existing own damage-dealt/XP correlation remains a conservative fallback. NPC zero HP or XP gain alone no longer awards a standard-agent kill. Astra allows a short read-only window for delayed event publication after target clearing and closes without kill credit when evidence remains absent. Reused NPC indices, foreign attackers, changed lives and duplicate observations are rejected. Actual XP and supply use remain useful measurements even when the kill is unconfirmed; old uncertain samples are not relabelled as kills.

## Validation and deployment boundary

Tests use synthetic observations, local temporary journals and fake transport. They do not access real credentials, start the watchdog, log into the game or establish live endurance. Keep the full process exit status as a test gate; a printed zero-failure summary alone is not sufficient. Never delete a journal to apply this patch.
