# Catalog build guidance

This is the repository's compact implementation note derived from the supplied
`README.md` and `BUILD_COMPLETE_CATALOG.md`. Those documents remain the source
requirements; this file explains how the agent implementation maps them to
the repository.

## Required separation

- Reference facts belong in `data/catalog/`.
- Runtime observations belong in the agent journal.
- Learned route estimates belong in agent memory, with context and evidence.
- Character knowledge restrictions must not be confused with the complete
  developer-facing reference database.

## Required route fields

Every route keeps an output item, method, interaction, location references,
requirements, consumables/tools, lifecycle, evidence status and unresolved
gaps. Ground items, NPC anchors and shops use different location records.
Coordinates preserve the plane. A coordinate's existence does not prove
reachability.

## Safe defaults

- Never invent item IDs, prices, drop rates, probabilities or coordinates.
- Never infer a shop price from an inventory row's third field.
- Never infer a route from an item name, an external modern wiki, or a peer's
  assertion alone.
- Never mark an item unobtainable because its route is not indexed yet.
- A failed attempt creates an observation and a reason to replan; it does not
  permanently blacklist a route.

## Completeness gates

Report item-registry coverage, acquisition coverage, unresolved semantic sites
and runtime-validated routes separately. A generated file or a large item
count is not evidence that the catalog is complete.

