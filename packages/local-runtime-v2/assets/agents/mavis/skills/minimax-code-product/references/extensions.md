# MiniMax Code extensions reference

Use this reference for Skills, Plugins, MCP, Apps, Connectors, Marketplace, extension installation/development, discovery/loading/triggering/execution, or why an extension is missing or has no tools.

## Stable concepts and boundaries

- Skill is instruction content that guides an Agent; Plugin is a distributable product extension; MCP connects supported external tools/services; App/Connector is a product-managed user-facing integration concept.
- `discovered ≠ installed ≠ loaded ≠ triggered ≠ executed`: a catalog/list entry alone proves none of the later states.
- A capability can also be gated by surface, version, login, permissions, provider/model, region, account, or plan.

## Official source discovery

Use only the current region's MiniMax Code index:

- `region: cn` → `https://agent.minimaxi.com/docs/llms.txt`
- `region: en` → `https://agent.minimax.io/docs/llms.txt`

Read the current `.md` pages for `/docs/code/agents/mcp`, `/docs/code/agents/plugins`, and the regional CLI pages `/docs/cli/quick-start`, `/docs/cli/features`, `/docs/cli/faq`.

Do not copy current field names, transport lists, UI labels, or command options from memory. Never query both regional indexes for an ordinary current-region question.

## Diagnostic workflow

1. Name the requested object: Skill, Plugin, MCP server, App/Connector, or built-in tool.
2. Check discovery/install state, then surface/version/login and permission state.
3. For Skill: verify it is selected/loaded and that trigger wording matches; being listed does not mean it was injected into the turn.
4. For Plugin: verify installation/package health and whether its exposed capabilities are available; OAuth or credential setup remains user-controlled.
5. For MCP: verify current-doc configuration syntax, server connection/test result, enabled tools, and server-side health. “Plugin has MCP but no tools” is not fixed by guessing a connection address.
6. For execution failures, identify the first failed state and give one concrete user action.

## Safety

Never request or repeat passwords, API keys, OAuth secrets, tokens, or verification codes in chat. Never bypass consent, permission, plan, or server validation. Do not represent an internal component as an independent public product.
