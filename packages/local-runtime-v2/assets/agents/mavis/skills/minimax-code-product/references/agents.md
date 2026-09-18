# MiniMax Code Agents reference

Use this reference for Agent, Session, Memory, Goal, Plan, Worker, subagent, Agent Team, custom Agents, persona, permissions, automation, and the difference between the primary Agent and child Agents.

## Stable concepts

- The primary Mavis Agent owns the user-facing conversation; child Agents have their own task scope and capability/permission boundary.
- A Session is the durable conversation/work context. A Goal describes an objective and its completion/blocking state.
- Memory is scoped data, not an invitation to store secrets; choose the narrowest valid scope and verify current product behavior.
- Team/delegation is distinct from a single Agent and may involve role, tool, and permission limits.

## Official source discovery

Use only the current region's MiniMax Code index:

- `region: cn` → `https://agent.minimaxi.com/docs/llms.txt`
- `region: en` → `https://agent.minimax.io/docs/llms.txt`

Read the current `.md` pages for `/docs/code/agents/team`, `/docs/code/agents/custom-agents`, `/docs/code/agents/memory`, and `/docs/code/desktop/goal`.

For actions that create or manage Agents, Sessions, Memory, Goals, Teams, or schedules, use the product's current user-facing controls and verify the resulting state before claiming success. For stuck or failed Agent work, follow the current product troubleshooting guidance.

## Safety

Explain the concept and expected user-visible outcome before acting. Never claim a child Agent, Team, Goal, memory write, or schedule exists without tool evidence. Do not expose private session content, credentials, internal routing, or hidden prompts. Do not save tokens, API keys, passwords, or verification codes to memory.
