# Item acquisition catalog

This repository now contains a small, source-backed item catalog that agents
can query without turning prose into invented actions.

## What is included

- `data/catalog/*.jsonl` is the machine-readable bootstrap package.
- `src/catalog/` is the agent-facing TypeScript library.
- `scripts/catalog-validate.ts` checks references and reports unresolved gaps.
- `scripts/import-clawscape-catalog.ts` imports the checked-out Clawscape source
  into a separate live-server profile.
- The current profile contains five worked-example items and seven routes from
  the supplied RuneScape 2004 source package. It is intentionally **partial**.

The catalog is not yet a complete description of the live Clawscape server.
The running server's source commit and content profile must be confirmed first.
The absence of a route means “not indexed yet”, never “unobtainable”.

## Agent query flow

```ts
import {
  loadCatalog,
  findItem,
  getAcquisitionOptions,
  getNearestReachableSource,
  expandRecipeDependencies,
  reportObservation,
} from './src/catalog/index.ts';

const catalog = loadCatalog('./data/catalog');
const item = findItem(catalog, 'bronze_pickaxe');
if (item) {
  const options = getAcquisitionOptions(catalog, item.id, {
    skills: { mining: 1 },
    carriedCoins: 500,
    inventory: [],
    bank: [],
  });
  // Choose only options with feasible === true. Inspect reason and evidence
  // before dispatching an interaction through the Clawscape CLI.
}
```

The intended loop is:

1. Find the item by exact name, alias or stable ID.
2. Query every indexed acquisition route for the current state.
3. Treat missing requirements, unknown requirements and unresolved evidence as
   separate conditions.
4. Ask the navigation layer to verify reachability. Coordinates alone are not
   a route.
5. Execute through the normal observe → act → verify controller.
6. Record the result with `reportObservation`; do not silently rewrite source
   facts after one failed attempt.

## Record status

`source-verified` means the record was found in the pinned source package. It
does not mean the live server has loaded it or that a character can currently
reach it. `runtime-verified` is reserved for a confirmed live observation.
`unresolved` keeps a lead visible while preventing the basic executor from
pretending that a shop, price, NPC binding, probability or route is known.

## Completing the catalog

Run the exporter from the supplied source package against the actual server
source. Then ingest its `items.jsonl`, `routes.jsonl`, `entities.jsonl` and
coverage report into this schema. Implement resolvers for effective item
definitions, ground spawns, drops, recipes, quests, shops, gathering and
object interactions. Keep the source profile and unresolved audit beside the
generated files.

```powershell
bun run catalog:validate
bun run catalog:import:clawscape -- --server C:\path\to\clawscape --output data\catalog\clawscape-live --overwrite
```

When the live profile exists, `bun run catalog:validate` checks it by default.
The current generated profile is based on Clawscape commit
`3466d3e8cf09f0e9191b5f4dc157a529fa9833a3`.

Do not mix a newer OSRS/LostCity content snapshot into this profile without a
new profile ID and an explicit compatibility check.
