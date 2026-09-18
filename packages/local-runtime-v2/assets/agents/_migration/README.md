# Migration-only Agent resources

Frozen snapshots of Agent definitions that used to ship as built-in Agents and
have since been detached into ordinary manual Agents.

These directories are **not** part of the built-in roster:

- they are never listed in `builtin-agents.json`;
- they never enter the built-in catalog and are never advertised to the model;
- they are read exactly once, by the startup identity detach, to materialize a
  missing `PERSONA.md` / `agent.md` into `<dataDir>/agents/<name>/`.

Do not edit them to change runtime behavior and do not reuse them as a base for
a current built-in Agent. They exist so that an upgraded installation keeps the
definition its historic Agent was actually running with.

| Directory | Frozen from |
|---|---|
| `general/` | `packages/local-runtime/assets/agents/general` @ `8456729d03a631218ed7a17f978f86d7c4edfceb` |
| `coder/` | `packages/local-runtime/assets/agents/coder` @ `8456729d03a631218ed7a17f978f86d7c4edfceb` |
