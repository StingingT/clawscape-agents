# Clawscape skill update — 8 September 2026

Installed official upstream `Joostrothweiler/clawscape-skill`, commit
`cfc3744dec68d668d21a04146c46bac054b286cd` (the current main revision at installation),
under `C:/Users/guyro/.codex/skills/clawscape`. This is the skill repository linked
by the live game's documentation. The game checkout was not modified.

`src/skill-cli.ts` now supplies the existing three-agent controller and read-only
status script with the installed Python CLI. It reuses `data/online-home`, pins
every character explicitly, and requests `--full` for state/action/wait results.
The new default summary/delta format is not suitable input for these policies.
The existing per-profile controller locks, builds and learning files are retained.
Do not run the older game CLI or quest runner against these characters while
their hosted-session controllers are active; it uses a different client transport.

## Appearance

The upstream `looks` read endpoint succeeded for ClawScout, Stinger and CoinCrafter.
No appearance was changed. An owner-requested edit should coordinate a pause of
the acting controller first, inspect available parts/palettes with `looks`, use
`looks set` with only the requested fields, and verify by reading `looks` again.
Do not reset the shared default character or create a second game connection.

Example read command, using the existing account:

```powershell
$env:CLAWSCAPE_HOME='C:\Users\guyro\Documents\Guy\clawscape-agent\data\online-home'
python 'C:\Users\guyro\.codex\skills\clawscape\clawscape.py' --character stinger looks
```

## Validation / startup

- Existing agent suite plus transport tests: 115 pass, 0 fail, 234 assertions.
- Installed upstream Python CLI suite: 23 pass.
- All three established controllers launched in continuous mode; live full-state
  reads and navigation logs confirm connected characters and movement out of
  the Wizards' Tower after their completed Rune Mysteries trips.
- Astra's separate normal bounded controller was attempted. At 10:16:11 UTC it
  stopped with `MISSING_TOOL_ROUTE`, 10/10 HP, zero gameplay actions. It still lacks
  a fishing net/food acquisition route. Its safety gates and legacy local-client
  transport were not replaced or bypassed. Original Astra was not deleted/remade.
- Appearance writes were not tested because no appearance change was requested.

This validates the transport and startup, not completion of the agents' long-term
goals or an end-to-end successful Astra supply loop. The installed Codex skill is
available automatically on the next user turn.
