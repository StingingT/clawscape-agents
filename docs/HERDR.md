# Clawscape team control in Herdr

This is an opt-in control plane around the existing five game runtimes. Opening it starts **no game workers, no local model and no Codex consultation**. All characters start stopped, including after a manager restart. Their original profiles, memories, journals and safety rules stay in place.

The Overseer pane runs a small local control process. The five character panes are lightweight views of the runtimes owned by that process; they are **not five additional LLM sessions or duplicate game controllers**. The game runtime still executes and verifies every action.

## First setup on Windows

Before updating, stop and disable **Clawscape Agents Watchdog** in Task Scheduler, and stop its existing agent processes using the established controls. Do not delete their saved journals. A still-running supervisor makes setup refuse exclusive ownership instead of starting a duplicate team. Do not use a blanket `taskkill /IM bun.exe`: that could terminate unrelated work.

From your existing repository:

```powershell
cd "C:\Users\guyro\Documents\Guy\clawscape-agent"
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw "Git pull failed" }
bun test
if ($LASTEXITCODE -ne 0) { throw "Tests failed; keep the agents stopped" }
bun run team:doctor
bun run team:setup
bun run team:herdr
```

Herdr's CLI must be on PATH. The already-configured RuneScape CLI and Astra configuration are reused; no credentials are requested or copied by team setup. `team:doctor` checks local prerequisites without logging in to the game or a model. No Ollama/Codex installation is needed for the initial token-free control panel.

The workspace has an **Overseer / controls** tab and one view tab per character. In the Overseer pane, start one character first:

```text
start clawscout
```

Then use `start all` when ready. The first version leaves the existing gameplay/recovery bugs visible; orchestration does not repair missing navigation or verification capabilities.

The same panel works without Herdr:

```powershell
bun run team:ui
```

Do not open a second control panel for the same checkout. It will refuse the existing controller lock.

## Controls and RAM

| Panel command | Effect |
| --- | --- |
| `start NAME` / `resume NAME` | Start a stopped worker, or resume a paused worker. |
| `start all` | Start all five existing profiles; no LLM session per worker. |
| `restart NAME` | Cooperatively stop one worker, preserve its journals, then start a fresh worker from current observations. |
| `reload` | Stop all workers and replace the Overseer with a new process loading the current local source. |
| `pause NAME` / `pause all` | Stop issuing new game actions. Processes remain in memory. |
| `stop NAME` | Stop that worker and any consultation currently serving it. |
| `stop all` | Stop the five workers, cancel owned consultations/local inference, and exit the panel. |
| `status` | Refresh the control dashboard. |
| `details NAME` | Show fresh goals/blockers and numbered available objectives. |
| `goal NAME N` | Suggest objective N from the last displayed list for that character. |
| `help NAME` | Queue a Codex advice request; this does not run Codex. |
| `requests` | Inspect the exact question, data scope and approval code. |
| `deny ID` | Refuse a consultation; other workers continue. |

Names are `clawscout`, `stinger`, `coincrafter`, `featherer` and `astra`.

**Pause is not a game-world freeze.** A previously accepted action may finish server-side, and a character can still be attacked. Pause does not perform unattended safety actions while paused. Stop is preferable when leaving for a long time. Stop waits briefly for the cooperative loop, then terminates only child processes owned by this manager when necessary. In-flight outcomes remain unknown in their existing journals and must reconcile on restart; no old command is replayed.

**Closing/detaching Herdr is not Stop All.** Herdr sessions persist. Use `stop all` (or Ctrl+C in the control panel) to release the game's worker processes. Character view processes exit after the team stops. Herdr itself, its shell panes, an independently running game server, and unrelated applications are not closed. The small global Ollama service, when installed, is not killed; only our configured model is asked to unload. Unloading is best-effort if that service is unavailable or another client is using the same model.

## Reopen the controls

`bun run team:herdr` is a package command, so run it in the agent checkout, not from an arbitrary PowerShell directory:

```powershell
cd "C:\Users\guyro\Documents\Guy\clawscape-agent"
bun run team:herdr
```

Closing only the Herdr client normally detaches from the existing workspace; the command above focuses it again, including when its controller is stale. It never injects commands into that terminal or presents it as restarted. After a source update, first use `stop all` in the existing Overseer when available, then create a clean panel with:

```powershell
bun scripts/team.ts herdr --fresh-workspace
```

All workers start stopped in that new session. Use `start NAME`, `start all`, or `restart NAME` in the Overseer pane afterwards.

When the existing Overseer is visible, the shorter update path is simply `reload`. It is an explicit stop-and-relaunch boundary: all workers stop, journals remain intact, and the replacement Overseer starts from the latest source with every worker stopped.

The durable `data/team-control/enabled.json` marker suppresses future legacy watchdog starts, even after Stop All. There is no automatic team startup at login and no resurrection of stopped workers by the old hourly task. To deliberately return to legacy supervision, first stop the team and all its children, remove **only that marker**, then explicitly re-enable the old task. Never remove game journals or controller locks belonging to live processes.

## What the Overseer does

Default configuration is a **token-free monitor**, not a hidden LLM. Existing workers still select their own goals. The monitor displays progress, detects stalls and queues help requests. You can assign temporary preferences from a worker's own current catalogue.

An optional local model can reason about a stalled character and suggest a feasible alternative. Suggestions are validated against fresh worker state, expire after five minutes, and do not overwrite productive committed work. Replanning at a safe boundary cannot clear pending interactions, override protected XP, invent items/observations, expand risk budgets, or introduce executable commands. Character identity does not come with a scripted escape route or mandatory activity.

A consultant can legitimately return “no listed action solves this; an executor capability is missing.” That is not permission to bypass an uncertainty lock. Broader LLM-authored plans and newly learned executable skills are outside this first integration.

## Optional local model

Stop the control panel before changing its configuration. Install and configure a local Ollama model separately, then use its exact installed name:

```powershell
bun scripts/team.ts config local YOUR-INSTALLED-MODEL
bun run team:ui
```

The client connects only to `http://127.0.0.1:11434`. It checks installed model metadata and refuses cloud/remote models. It never pulls a model and never falls back to a hosted provider. Requests are serialized, at most one per minute, only for stalled running workers, with a 45-second timeout. Context is limited to 4096 tokens and output to 512 generated tokens. `keep_alive: 0` requests unloading after each inference. A local model uses **RAM/CPU/GPU and local tokens**, but not your Codex subscription allowance.

No model runs just to poll status, or when all workers are stopped/paused. Model/hardware selection can be made later. To disable it:

```powershell
bun scripts/team.ts config local off
```

## Codex: explicit, one-use approval

Codex is normally **off**. A pending help request changes the Herdr Overseer status to `blocked` with an approval message; other workers are not blocked by that request. Use `requests` to inspect its snapshot and exact scope, then type the displayed command:

```text
approve REQUEST-ID SCOPE-HASH
```

Approvals require an interactive control terminal. A model response cannot call the approval method; it can only return a listed goal ID and reasoning. The exact scope and one-use consumption are persisted **before** spawning Codex. Denial, timeout, errors and manager restarts never silently retry a paid request. An expired or materially changed snapshot needs a new request. Scope confirmation is an application-level guard for cooperating local processes, not an OS security boundary against malicious software running as your Windows user.

A consultation is one ephemeral `codex exec` invocation, with a separate temporary working directory, read-only sandbox, user/project configuration disabled, web/tool/agent features disabled, and no game/Herdr environment or API-key overrides inherited. Existing Codex sign-in is used. Its answer is advisory JSON, not an action sent to RuneScape. The question plus snapshot is capped at 32,000 characters, answer at 16,000 characters, and the owned process is stopped at 90 seconds. **This is not an exact token or financial spending cap:** a consultation can consume your Codex allowance while it runs.

Use a recent CLI supporting the configured flags. Unsupported versions fail rather than relaxing the safeguards. On Windows the launcher needs a **native executable** (`codex.exe`), not a `.cmd` shell wrapper. Set a path explicitly when needed:

```powershell
bun scripts/team.ts config codex "C:\path\to\codex.exe"
```

Do not start a permanent Codex pane. Codex is not needed to launch, monitor, pause or stop the game workers.

## Restart and diagnostics

All session modes reset to stopped on a new manager session. Temporary objective suggestions do not resume automatically. Character learning remains in its existing profile stores. Old started consultations are marked interrupted; unconsumed approvals from the previous session expire.

Run `bun run status:export` for the existing game report. Team diagnostics are in `data/team-control/status.json`, `session.json`, `workers/NAME.json` and `approvals.json`. **Do not post the approvals file publicly without reviewing it:** it contains the exact selected observation data and consultation questions, although the control plane never intentionally adds credentials.

A saved Herdr workspace is reused/focused, never injected into blindly. If the Overseer/view commands previously exited, rerun `bun run team:ui` in its tab and `bun scripts/team.ts view NAME` in a character tab. If the workspace was deleted, inspect Herdr first, then remove only `data/team-control/herdr-workspace.json` and run `team:herdr` again. Partial setup is recorded and is not silently treated as success.

## Validation and boundaries

Tests cover ownership, stale observations, pending-journal preservation, real child start/pause/resume/stop, restart default-off, exact paid-approval scope, no automatic retries, local-only inference and actual shared-planner handoff. CI runs the integration on Windows and Linux under Node and Bun. It does not sign into Herdr, RuneScape, Ollama or Codex. The full game-dependent suite still needs the configured upstream game checkout on your PC.

Official interface references used for this integration:
- Herdr CLI: https://herdr.dev/docs/cli-reference/
- Herdr custom lifecycle reporting: https://herdr.dev/docs/integrations/
- Codex non-interactive use: https://developers.openai.com/codex/noninteractive/
- Codex configuration reference: https://developers.openai.com/codex/config-reference/
- Ollama generation API: https://docs.ollama.com/api/generate
