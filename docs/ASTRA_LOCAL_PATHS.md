# Astra local path diagnosis

The path fix is rebased on the startup/journal recovery already in main. It does
not replace that recovery implementation, clear journals, or start a character.

## One selected server checkout

Both collision workers and startup's `checkedUpstream` now use the same validated
resolver. Startup passes its already parsed `game_root` and selected runtime home;
the workers receive the resolved absolute path through `CLAWSCAPE_UPSTREAM`.

Selection order:

1. `CLAWSCAPE_UPSTREAM`, if explicitly set. Relative values are relative to the
   selected runtime home, not the shell's working directory.
2. The configured `game_root`, relative to that runtime home.

An empty or invalid explicit setting is an error. There is no fallback to the old
`agents/tmp/clawscape/upstream` location: a different map must not silently replace
the selected server's map. Direct standalone worker use can read
`CLAWSCAPE_ASTRA_CONFIG`; normal startup uses its `--config` option and passes the
selected checkout to the workers automatically.

The existing local checkout must contain these files:

- `sdk/pathfinding.ts`
- `sdk/collision-data.json`
- `server/vendor/rsmod-pathfinder/rsmod-pathfinder.js`

A repository URL is not a local checkout. Empty placeholder files are not a fix.
This change does not clone a repository, download data or install dependencies.

## Read-only preflight

From the agent repository root:

```powershell
bun scripts/astra-preflight.ts
```

Or using Node.js 22.16.0:

```powershell
node --experimental-strip-types scripts/astra-preflight.ts
```

The preflight uses the same runtime-home selection as `live-entry.ts`: explicit
`--runtime-root`, `CLAWSCAPE_ASTRA_HOME`, or unambiguous existing layout. Two
possible runtime homes produce an error instead of creating a new empty one.
Supply the same options used for the real controller when using a custom home or
configuration:

```powershell
bun scripts/astra-preflight.ts --runtime-root 'C:\actual\Astra runtime' --config 'custom-config.json'
```

For a server-checkout override, set it in the PowerShell session that will launch
the supervisor. A running supervisor cannot inherit a later shell change:

```powershell
$env:CLAWSCAPE_UPSTREAM = 'C:\actual\server-checkout'
bun scripts/astra-preflight.ts
```

Use actual existing paths, not these placeholders. Keep configuration and secrets
local. The preflight reads JSON and checks file presence; it never imports server
modules, logs in, opens the action database, publishes runtime status, or changes
credentials, knowledge or journals. It prints selected local paths and safe error
codes, not configuration contents.

Passing preflight does not validate schemas, credentials, production map content,
WebAssembly dependencies, server compatibility, journal recovery or live health.
The recovery worker's existing map hash and all routing safety rules remain intact.
This patch does not address the separate pending movement-step behavior.

## Verification

Twenty-six filesystem, source-wiring and read-only preflight tests passed locally
on Node.js 22.16.0 on Linux. The new workflow runs these tests on both Linux and
Windows. GitHub workflow results, rather than this document, establish whether
those CI runs passed. No live server or agent was used in these tests.
