import type {
  ListRuntimeSkillsInput as ListRuntimeSkillsReq,
  ListRuntimeSkillsResult as ListRuntimeSkillsResp,
  SkillInfo,
} from "@mavis/protocol/local";

interface LocalRuntimeSkillScope {
  readonly agentName?: string;
  readonly workspaceDir?: string;
}

export interface RuntimePluginSkillSummary {
  readonly runtimeName: string;
  readonly pluginName: string;
  readonly skillName: string;
  readonly pluginDisplayName?: string;
  readonly skillDisplayName?: string;
  readonly description?: string;
  readonly pluginIconUrl?: string;
  readonly pluginDarkIconUrl?: string;
}

interface RuntimeSkillApplicationOptions {
  readonly agents: {
    requireExactAgentKey(requestRef: string): Promise<string>;
  };
  readonly standalone: {
    listRuntimeSkills(scope?: LocalRuntimeSkillScope): Promise<{
      skills: SkillInfo[];
      refreshedAt: number;
    }>;
    setSkillEnabled(
      input: { skillName: string; locationUri?: string; agentName?: string },
      enabled: boolean,
    ): Promise<{ ok: true; name: string; enabled: boolean } | undefined>;
  };
  readonly plugins: {
    listEnabledPluginSkillSummaries(): Promise<
      readonly RuntimePluginSkillSummary[]
    >;
  };
  readonly sessions: {
    find(sessionId: string): Promise<
      | {
          readonly agentName: string;
          readonly workspaceDir: string;
        }
      | undefined
    >;
  };
  readonly nowMs?: () => number;
}

/** Cross-domain Desktop application for the existing Runtime Skill roster surface. */
export class RuntimeSkillApplication {
  private readonly nowMs: () => number;

  constructor(private readonly options: RuntimeSkillApplicationOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  setSkillEnabled(
    input: { skillName: string; locationUri?: string; agentName?: string },
    enabled: boolean,
  ): Promise<{ ok: true; name: string; enabled: boolean } | undefined> {
    return this.options.standalone.setSkillEnabled(input, enabled);
  }

  async listRuntimeSkills(
    req: ListRuntimeSkillsReq,
  ): Promise<ListRuntimeSkillsResp> {
    const scope = await this.resolveScope(req);
    if (!scope) return { skills: [], refreshedAt: this.nowMs() };

    if (req.includePluginSkills !== true) {
      return this.options.standalone.listRuntimeSkills(scope);
    }

    const [standaloneResult, pluginResult] = await Promise.allSettled([
      this.options.standalone.listRuntimeSkills(scope),
      this.options.plugins.listEnabledPluginSkillSummaries(),
    ]);
    if (
      standaloneResult.status === "rejected" &&
      pluginResult.status === "rejected"
    ) {
      throw standaloneResult.reason;
    }
    const standalone =
      standaloneResult.status === "fulfilled"
        ? standaloneResult.value
        : { skills: [], refreshedAt: this.nowMs() };
    const pluginSkills =
      pluginResult.status === "fulfilled" ? pluginResult.value : [];
    return {
      ...standalone,
      skills: mergeRuntimeSkills(standalone.skills, pluginSkills),
    };
  }

  private async resolveScope(
    req: ListRuntimeSkillsReq,
  ): Promise<LocalRuntimeSkillScope | null> {
    const requestedAgentRef = normalizeNonEmptyString(req.agentName);
    const requestedSessionId = normalizeNonEmptyString(req.sessionId);
    const requestedWorkspaceDir = normalizeNonEmptyString(req.workspaceDir);
    let requestedAgent: string | undefined;
    try {
      requestedAgent = requestedAgentRef
        ? await this.options.agents.requireExactAgentKey(requestedAgentRef)
        : undefined;
    } catch {
      return null;
    }
    if (!requestedSessionId) {
      return { agentName: requestedAgent, workspaceDir: requestedWorkspaceDir };
    }
    let session: Awaited<
      ReturnType<RuntimeSkillApplicationOptions["sessions"]["find"]>
    >;
    try {
      session = await this.options.sessions.find(requestedSessionId);
    } catch {
      session = undefined;
    }
    if (!session || (requestedAgent && session.agentName !== requestedAgent))
      return null;
    return {
      agentName: requestedAgent ?? session.agentName,
      workspaceDir:
        normalizeNonEmptyString(session.workspaceDir) ?? requestedWorkspaceDir,
    };
  }
}

export function createRuntimeSkillApplication(
  pluginSystem: {
    readonly skill: RuntimeSkillApplicationOptions["standalone"];
    readonly plugin: RuntimeSkillApplicationOptions["plugins"];
  },
  sessions: RuntimeSkillApplicationOptions["sessions"],
  agents: RuntimeSkillApplicationOptions["agents"],
  nowMs: () => number,
): RuntimeSkillApplication {
  return new RuntimeSkillApplication({
    agents,
    standalone: pluginSystem.skill,
    plugins: pluginSystem.plugin,
    sessions,
    nowMs,
  });
}

function mergeRuntimeSkills(
  standalone: readonly SkillInfo[],
  plugins: readonly RuntimePluginSkillSummary[],
): SkillInfo[] {
  const seen = new Set(standalone.map((skill) => normalizedName(skill.name)));
  const appended = [...plugins]
    .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName))
    .flatMap((skill): SkillInfo[] => {
      const name = skill.runtimeName.trim();
      const key = normalizedName(name);
      if (!name || seen.has(key)) return [];
      seen.add(key);
      const description = skill.description?.trim() ?? "";
      return [
        {
          name,
          displayName: skill.skillDisplayName?.trim() || name,
          description,
          displayDescription: description,
          sourceKind: "plugin",
          enabled: true,
        },
      ];
    });
  return [...standalone, ...appended];
}

function normalizeNonEmptyString(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}
