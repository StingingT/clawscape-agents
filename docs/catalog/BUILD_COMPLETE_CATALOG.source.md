# Supplied build requirements (recorded reference)

This repository's catalog layer follows the user-supplied
`BUILD_COMPLETE_CATALOG.md` in `C:\Users\guyro\Downloads`.

Its main requirements are:

1. Confirm the actual running server source profile before extraction.
2. Keep the complete registry separate from normal-player acquisition facts.
3. Preserve item identity, variants, routes, locations, planes, requirements,
   tools, consumables, lifecycle, evidence and unresolved gaps.
4. Cover ground spawns, monster drops, recipes and transformations, quests,
   shops, gathering, thieving, minigames and initial loadouts.
5. Prefer parsed source semantics and runtime tests over keyword matches.
6. Expose bounded agent queries for item search, route choice, reachability,
   recipe dependencies, requirements, evidence and observations.
7. Keep source facts, runtime observations and learned strategy estimates
   separate; online information is a prior, not proof of live behavior.
8. Report registry coverage, acquisition coverage, unresolved semantic sites
   and runtime-validated routes separately.

The implementation must never invent IDs, coordinates, prices, probabilities or
routes and must not claim completeness from generated output alone.

