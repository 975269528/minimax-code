import {
  projectAgentReferencesForModel,
  type AgentMentionSurface,
  type AgentReferenceErrorCode,
  type AgentReferenceResolution,
} from '@mavis/shared/agent-mention';

const TASK_CHILD_PURPOSE_PREFIXES = [
  'local-task:',
  'local-background-task:',
  'team-plan:',
] as const;

export function resolveAgentPromptSurface(
  session: {
    readonly sessionType: string;
    readonly sessionKind?: string;
    readonly parentSessionId?: string | null;
    readonly visibility?: string;
    readonly purpose?: string;
  },
  runtimeOwnerKind: string | undefined,
): 'interactive' | 'task-child' | 'cli' {
  const taskChild =
    session.sessionKind === 'task' ||
    (session.sessionType === 'branch' &&
      Boolean(session.parentSessionId) &&
      session.visibility === 'hidden' &&
      TASK_CHILD_PURPOSE_PREFIXES.some((prefix) => session.purpose?.startsWith(prefix)));
  if (taskChild) return 'task-child';
  return runtimeOwnerKind === 'cli' || runtimeOwnerKind === 'tui' ? 'cli' : 'interactive';
}

export interface LocalAgentReferenceProjection {
  readonly resolveAgentReference: (
    requestRef: string,
  ) => AgentReferenceResolution | Promise<AgentReferenceResolution>;
  readonly emitDiagnostic?: (event: {
    readonly stage: 'llm_projection';
    readonly outcome: 'success' | 'failure';
    readonly count: number;
    readonly surface: AgentMentionSurface;
    readonly runtime: 'desktop';
    readonly errorCode?: AgentReferenceErrorCode;
  }) => void;
}

export async function projectLocalAgentReferencesForModel(input: {
  readonly content: string;
  readonly agentConfig: Readonly<Record<string, unknown>>;
  readonly projection: LocalAgentReferenceProjection;
}): Promise<string> {
  const surface = resolveAgentMentionSurface(input.agentConfig);
  const result = await projectAgentReferencesForModel(input.content, {
    surface,
    resolveAgentReference: input.projection.resolveAgentReference,
  });

  // A no-mention turn is intentionally silent. Projection telemetry is
  // useful for a real protocol outcome, but logging one success per normal
  // user turn would create high-volume noise without diagnostic value.
  if (result.projectedCount > 0) {
    input.projection.emitDiagnostic?.({
      stage: 'llm_projection',
      outcome: 'success',
      count: result.projectedCount,
      surface,
      runtime: 'desktop',
    });
  }

  const errorCounts = new Map<AgentReferenceErrorCode, number>();
  for (const errorCode of result.errorCodes) {
    errorCounts.set(errorCode, (errorCounts.get(errorCode) ?? 0) + 1);
  }
  for (const [errorCode, count] of errorCounts) {
    input.projection.emitDiagnostic?.({
      stage: 'llm_projection',
      outcome: 'failure',
      count,
      surface,
      runtime: 'desktop',
      errorCode,
    });
  }

  return result.content;
}

function resolveAgentMentionSurface(
  agentConfig: Readonly<Record<string, unknown>>,
): AgentMentionSurface {
  const profile = agentConfig.agent_profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return 'direct-subagent';
  const facts = profile as Readonly<Record<string, unknown>>;
  if (facts.surface === 'task-child') return 'task-child';
  return facts.surface === 'interactive' &&
    facts.trusted_builtin === true &&
    facts.canonical_view_name === 'mavis'
    ? 'main'
    : 'direct-subagent';
}
