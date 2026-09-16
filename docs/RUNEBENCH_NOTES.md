# RuneBench review notes

Reviewed `MaxBittker/runebench` as an external reference for agent architecture.

Useful transferable ideas:

- Agents are given a compact high-level action surface (`bot`) plus lower-level state access (`sdk`) instead of being forced to script raw packets.
- Successful benchmark prompts explicitly push the agent toward **one small experiment first**, verification, then iteration. They warn against one giant preplanned script.
- Long-running behavior is built from short, observable loops whose effects are periodically checked by an external verifier.
- Game knowledge is supplied as reference material, but live actions are still grounded against current state/tool APIs.

Implications for Clawscape:

- Preserve the current verified-action journal rather than copying RuneBench's benchmark-specific goal model.
- Improve the generic discovery/bootstrap path so an agent with no executable strategic task can select a safe local experiment from fresh observations, verify its effect, and feed learned knowledge back into normal planning.
- Keep experiments bounded and incremental. A failed interaction should cool/defer that exact approach rather than freeze the whole agent or trigger a scripted character-specific fallback.
- Transactional actions remain stricter than exploratory interactions; RuneBench's fast iterative style is not authority to replay an unresolved value-moving action.

RuneBench is a benchmark harness rather than a persistent autonomous-character implementation, so its most useful lesson here is the observe -> minimal experiment -> verify -> iterate control pattern, not its fixed benchmark objectives.
