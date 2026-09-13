# Continuous agents

Windows task: **Clawscape Agents Watchdog**. It runs `supervise-agents.ps1`,
which stays attached to the supervisor. The task starts after user login,
also has an hourly trigger, and ignores duplicate starts. It has no runtime
limit. Closing Codex does not intentionally stop this Windows-owned task.
The computer must remain awake and connected to the internet.

The supervisor observes child exits and restarts with a bounded delay (2–15
minutes after short failures, 1 minute after a longer run). Hourly health
events are separate from these exit-triggered restarts. Manual Astra takeover
and hard-disable controls remain respected. Each controller owns its actions;
the supervisor sends no game commands.

## Goals

- ClawScout: melee progression, equipment opportunities and sustainable food.
- Stinger: ranged/magic progression, ammunition and supply recovery.
- CoinCrafter: profitable production, tool upgrades, mining and smithing;
  blocked tool goals yield to another feasible task and can be retried later.
- Astra: independent planner and journal, balanced melee trials and measured
  encounter learning. His bounded sessions are restarted by the supervisor.

The five-minute action deadline is based on observed progress. Map loading
alone cannot reset it. Temporary action failures expire. These policies do
not guarantee every server mechanic or route is supported.

## Controls

Start: run `start-agents.ps1`, or start **Clawscape Agents Watchdog** in Task
Scheduler. Stop: disable that task, then end it in Task Scheduler. Disabling
prevents the hourly/login trigger from starting it again.

Status: `data/supervisor/status.json` (process state and current log paths).
History: `data/supervisor/events.jsonl` (launch, exit, retry and hourly events).
Game progress is recorded in the individual logs and learning stores; a
running process alone is not proof of XP or item gains.

Previous configuration is preserved in `data/watchdog-before-supervisor.xml`
and `data/start-agents-before-supervisor.ps1`.
