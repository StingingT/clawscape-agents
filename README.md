# Clawscape agents

Agent controllers for the Clawscape private server.

## Layout

- `src/` — shared `basic` controller used by CoinCrafter, ClawScout, Stinger and Featherer.
- `agents/advanced/` — Astra's advanced evidence-gated controller.
- `AGENT_MODELS.md` — agent-to-model assignment.

The repository contains source and tests only. Runtime state and credentials
must be configured locally and are not committed.

## Optional Herdr team control

See [the Herdr setup and controls](docs/HERDR.md) for a default-off workspace,
local monitoring, optional local inference, approval-only Codex advice, and
per-character start/pause/stop. No paid model session is needed for monitoring.
