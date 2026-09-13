# Agent models

| Agent | Model | Role |
|---|---|---|
| CoinCrafter | basic | Economy, gathering and production |
| ClawScout | basic | Melee progression and combat discovery |
| Stinger | basic | Ranged/magic supply and combat discovery |
| Featherer | basic | Feather and resource gathering |
| Astra | advanced | Independent world learning and exploration |

The `basic` agents share the main controller in `src/agent.ts`. Astra is kept
under `agents/advanced/` because it uses the separate evidence-gated policy
and CLI harness.

Live credentials, character passwords, server state, logs, checkpoints and
generated builds are intentionally excluded from this repository.
