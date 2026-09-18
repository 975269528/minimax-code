import type {
  AgentDetail,
  CreateAgentInput as CreateAgentReq,
  CreateAgentResult as CreateAgentResp,
  DeleteAgentInput as DeleteAgentReq,
  DeleteAgentResult as DeleteAgentResp,
  AgentConfiguredDefinition as DesktopAgentConfiguredDefinition,
  GetAgentInput as GetAgentReq,
  GetAgentResult as GetAgentResp,
  ListAgentsInput as ListAgentsReq,
  ListAgentsResult as ListAgentsResp,
  UpdateAgentInput as UpdateAgentReq,
  UpdateAgentResult as UpdateAgentResp,
} from "@mavis/protocol/local";
import {
  AgentServiceError,
  type AgentConfiguredDefinition,
  type AgentListOptions,
  type AgentView,
} from "../../service/agent/index.js";
import type { ApplicationContext } from "../context.js";
import { AppError, NotImplementedError } from "../errors.js";
import type { AgentApplication } from "./agent-application.js";

interface IncludeFlags {
  readonly identity: boolean;
  readonly persona: boolean;
  readonly systemPrompt: boolean;
}

/** V2 Agent RPC adapter. All persistence and root sequencing stays in AgentApplication. */
export class AgentManagementApplication {
  constructor(private readonly application?: AgentApplication) {}

  async listAgents(
    _ctx: ApplicationContext,
    req: ListAgentsReq,
  ): Promise<ListAgentsResp> {
    const application = this.requireApplication();
    return mapAgentErrors(async () => {
      const include = readInclude(req.include);
      const options: AgentListOptions = {
        ...(req.search === undefined ? {} : { search: req.search }),
        includeAliases: false,
      };
      const listed = await application.list(options);
      const filtered = listed.filter(
        (agent) =>
          !(req.excludePrimary === true && agent.canonicalViewName === "mavis"),
      );
      const offset = Math.max(0, req.offset ?? 0);
      const limit =
        req.limit === undefined ? undefined : Math.max(0, req.limit);
      const page = filtered.slice(
        offset,
        limit === undefined ? undefined : offset + limit,
      );
      const agents = await Promise.all(
        page.map(async (agent) => {
          const detail =
            include.persona || include.systemPrompt
              ? await application.get(agent.requestRef, {
                  includeContent: true,
                })
              : agent;
          return toAgentDetail(detail, include);
        }),
      );
      return { agents };
    });
  }

  async createAgent(
    _ctx: ApplicationContext,
    req: CreateAgentReq,
  ): Promise<CreateAgentResp> {
    const application = this.requireApplication();
    return mapAgentErrors(async () => {
      const input = {
        ...(req.name === undefined ? {} : { name: req.name }),
        ...(req.displayName === undefined
          ? {}
          : { displayName: req.displayName }),
        ...(req.persona === undefined ? {} : { persona: req.persona }),
        ...(req.systemPrompt === undefined
          ? {}
          : { systemPrompt: req.systemPrompt }),
        ...(req.description === undefined
          ? {}
          : { description: req.description }),
        ...(req.avatar === undefined ? {} : { avatar: req.avatar }),
        ...(req.defaultWorkspaceDir === undefined
          ? {}
          : { defaultWorkspaceDir: req.defaultWorkspaceDir }),
        ...(req.initialDefinition === undefined
          ? {}
          : {
              initialDefinition: fromDesktopConfiguredDefinition(
                req.initialDefinition,
              ),
            }),
      };
      // Product decision 2026-09-04 (desktop and cloud agree): manual Agent
      // creation is definition-only — no Root Session, no greeting. The first
      // message from Chat creates the Session lazily. The legacy `create`
      // (Root materialization) path is retired; `definitionOnly` is accepted
      // but no longer consulted (renderer already always sent true; no other
      // shipped client calls this endpoint without it).
      const created = await application.createDefinition(input);
      return {
        name: created.exactOwnerName,
        ...(created.rootSessionId === undefined
          ? {}
          : { rootSessionId: created.rootSessionId }),
      };
    });
  }

  async getAgent(
    _ctx: ApplicationContext,
    req: GetAgentReq,
  ): Promise<GetAgentResp> {
    const application = this.requireApplication();
    return mapAgentErrors(async () => {
      const name = requireText(req.name, "name");
      const include = readInclude(req.include);
      const agent = await application.get(name, {
        includeContent: include.persona || include.systemPrompt,
      });
      return { agent: toAgentDetail(agent, include) };
    });
  }

  async updateAgent(
    _ctx: ApplicationContext,
    req: UpdateAgentReq,
  ): Promise<UpdateAgentResp> {
    const application = this.requireApplication();
    return mapAgentErrors(async () => {
      const raw = req as UpdateAgentReq & { displayName?: string | null };
      const name = requireText(req.name, "name");
      const updated = await application.update({
        requestRef: name,
        ...(raw.displayName === undefined
          ? {}
          : { displayName: raw.displayName }),
        ...(req.persona === undefined ? {} : { persona: req.persona }),
        ...(req.systemPrompt === undefined
          ? {}
          : { systemPrompt: req.systemPrompt }),
        ...(req.description === undefined
          ? {}
          : { description: req.description }),
        ...(req.avatar === undefined ? {} : { avatar: req.avatar }),
      });
      const detail = await application.get(updated.requestRef, {
        includeContent: true,
      });
      return { success: true, agent: toAgentDetail(detail, ALL_INCLUDE) };
    });
  }

  async deleteAgent(
    _ctx: ApplicationContext,
    req: DeleteAgentReq,
  ): Promise<DeleteAgentResp> {
    const application = this.requireApplication();
    return mapAgentErrors(async () => {
      await application.delete(requireText(req.name, "name"));
      return { success: true };
    });
  }

  private requireApplication(): AgentApplication {
    if (!this.application) throw new NotImplementedError("agent application");
    return this.application;
  }
}

/** Legacy/non-owner hosts keep the generated route fail-closed. */

export function createAgentManagementApplication(
  application: AgentApplication,
): AgentManagementApplication {
  return new AgentManagementApplication(application);
}

const ALL_INCLUDE: IncludeFlags = {
  identity: true,
  persona: true,
  systemPrompt: true,
};

function readInclude(raw: string | undefined): IncludeFlags {
  const tokens = new Set(
    (raw ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const all = tokens.has("all") || tokens.has("*");
  return {
    identity: all || tokens.has("identity"),
    persona: all || tokens.has("persona"),
    systemPrompt:
      all ||
      tokens.has("prompt") ||
      tokens.has("system_prompt") ||
      tokens.has("systemprompt"),
  };
}

function requireText(value: string | undefined, field: string): string {
  if (value !== undefined && value.trim() !== "") return value;
  throw new AppError(400, "VALIDATION_ERROR", `${field} is required`);
}

function toAgentDetail(
  agent: AgentView & {
    readonly persona?: string;
    readonly systemPrompt?: string;
  },
  include: IncludeFlags,
): AgentDetail {
  return {
    ...toAgentIdentity(agent, include),
    ...toAgentContent(agent, include),
  };
}

function toAgentIdentity(
  agent: AgentView & {
    readonly persona?: string;
    readonly systemPrompt?: string;
  },
  include: IncludeFlags,
): AgentDetail {
  return {
    name: agent.name,
    displayName: agent.displayName,
    agentRole: agent.agentRole,
    ...(agent.rootSessionId === undefined
      ? {}
      : { rootSessionId: agent.rootSessionId }),
    ...(agent.agentConfigDir === undefined
      ? {}
      : { agentConfigDir: agent.agentConfigDir }),
    createdAt: agent.createdAtMs,
    updatedAt: agent.updatedAtMs,
    ...(agent.defaultWorkspaceDir === undefined
      ? {}
      : {
          defaultWorkspaceDir: agent.defaultWorkspaceDir,
          userDefaultWorkspaceDir: agent.defaultWorkspaceDir,
        }),
    creationSource: toCreationSource(agent.creationSource),
    ...(include.identity
      ? {
          ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
          ...(agent.description === undefined
            ? {}
            : { description: agent.description }),
        }
      : {}),
  };
}

function toAgentContent(
  agent: AgentView & {
    readonly persona?: string;
    readonly systemPrompt?: string;
  },
  include: IncludeFlags,
): Pick<AgentDetail, "persona" | "systemPrompt"> {
  return {
    ...(include.persona && agent.persona !== undefined
      ? { persona: agent.persona }
      : {}),
    ...(include.systemPrompt && agent.systemPrompt !== undefined
      ? { systemPrompt: agent.systemPrompt }
      : {}),
  };
}

function toCreationSource(source: AgentView["creationSource"]): 0 | 1 | 2 | 3 {
  switch (source) {
    case "manual":
      return 1;
    case "auto":
      return 2;
    case "builtin":
      return 3;
    default:
      return 0;
  }
}

function fromDesktopConfiguredDefinition(
  input: DesktopAgentConfiguredDefinition,
): AgentConfiguredDefinition {
  return {
    name: input.name,
    description: input.description,
    ...fromDesktopDefinitionFields(input),
    ...(input.mavis === undefined
      ? {}
      : { mavis: fromDesktopMavisConfig(input.mavis) }),
    systemPrompt: input.systemPrompt,
  };
}

function fromDesktopDefinitionFields(
  input: DesktopAgentConfiguredDefinition,
): Omit<
  AgentConfiguredDefinition,
  "name" | "description" | "mavis" | "systemPrompt"
> {
  return {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    ...(input.disallowedTools === undefined
      ? {}
      : { disallowedTools: [...input.disallowedTools] }),
    ...(input.mcpServers === undefined
      ? {}
      : { mcpServers: [...input.mcpServers] }),
    ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
  };
}

function fromDesktopMavisConfig(
  input: NonNullable<DesktopAgentConfiguredDefinition["mavis"]>,
): NonNullable<AgentConfiguredDefinition["mavis"]> {
  return {
    ...(input.displayName === undefined
      ? {}
      : { displayName: input.displayName }),
    ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
    ...(input.contextWindow === undefined
      ? {}
      : { contextWindow: input.contextWindow }),
    ...(input.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: input.maxOutputTokens }),
    ...(input.defaultWorkspaceDir === undefined
      ? {}
      : { defaultWorkspaceDir: input.defaultWorkspaceDir }),
    ...(input.extensionSkills === undefined
      ? {}
      : { extensionSkills: [...input.extensionSkills] }),
  };
}

async function mapAgentErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof AgentServiceError) {
      throw new AppError(err.status, err.code, err.message);
    }
    throw new AppError(500, "INTERNAL_ERROR", "internal error");
  }
}
