import type {
  AgentConfigDiagnostic,
  AgentConfigDocument,
  AgentConfiguredDefinition,
  AgentEffectiveConfigForNewSession,
} from '../../contracts.js';
import type { CanonicalAgentConfig } from '../../storage/canonical-agent-config.js';

/**
 * Pure projection shared by Config GET and successful Config PUT. The raw
 * document remains authoritative; this is deliberately not a second parser.
 */
export function toAgentConfigDocument(input: {
  readonly exactOwnerName: string;
  readonly ownerKind: 'builtin' | 'custom';
  readonly content: string;
  readonly revision: string;
  readonly config: CanonicalAgentConfig;
  readonly ownerInstanceId?: string;
  readonly baselineContent?: string;
  /** Resolved by the Runtime ModelSystem, never inferred from a raw string here. */
  readonly effectiveModel?: Pick<
    AgentEffectiveConfigForNewSession,
    'providerId' | 'modelId' | 'effort' | 'contextWindow' | 'maxOutputTokens'
  >;
}): AgentConfigDocument {
  const configured = toConfiguredDefinition(input.config);
  return {
    exactOwnerName: input.exactOwnerName,
    ...(input.ownerInstanceId ? { ownerInstanceId: input.ownerInstanceId } : {}),
    ownerKind: input.ownerKind,
    persistence: input.ownerKind === 'builtin' ? 'launch-scoped' : 'persistent',
    appliesTo: 'new-sessions-only',
    revision: input.revision,
    content: input.content,
    configured,
    effectiveForNewSession: toEffectiveConfig(input.config, input.effectiveModel),
    diagnostics: input.config.diagnostics.map(toDiagnostic),
    ...(input.baselineContent === undefined ? {} : { baselineContent: input.baselineContent }),
  };
}

/** Canonical model intent reused when a bundled profile has not materialized yet. */
export function toConfiguredModelSelection(config: CanonicalAgentConfig): Pick<
  AgentEffectiveConfigForNewSession,
  'effort' | 'contextWindow' | 'maxOutputTokens'
> & {
  readonly model?: string;
} {
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.xMavis?.contextWindow === undefined
      ? {}
      : { contextWindow: config.xMavis.contextWindow }),
    ...(config.xMavis?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.xMavis.maxOutputTokens }),
  };
}

/** Projects a parsed canonical config without reinterpreting its raw document. */
export function toConfiguredDefinition(config: CanonicalAgentConfig): AgentConfiguredDefinition {
  const mavis = config.xMavis;
  return {
    name: config.name,
    description: config.description,
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.tools === undefined ? {} : { tools: [...config.tools] }),
    ...(config.disallowedTools === undefined
      ? {}
      : { disallowedTools: [...config.disallowedTools] }),
    ...(config.mcpServers === undefined ? {} : { mcpServers: [...config.mcpServers] }),
    ...(config.skills === undefined ? {} : { skills: [...config.skills] }),
    ...(mavis === undefined ? {} : { mavis: toConfiguredMavis(mavis) }),
    systemPrompt: config.systemPrompt,
  };
}

function toConfiguredMavis(
  mavis: NonNullable<CanonicalAgentConfig['xMavis']>,
): NonNullable<AgentConfiguredDefinition['mavis']> {
  return {
    ...(mavis.displayName ? { displayName: mavis.displayName } : {}),
    ...(mavis.avatar ? { avatar: mavis.avatar } : {}),
    ...(mavis.contextWindow === undefined ? {} : { contextWindow: mavis.contextWindow }),
    ...(mavis.maxOutputTokens === undefined ? {} : { maxOutputTokens: mavis.maxOutputTokens }),
    ...(mavis.defaultWorkspaceDir ? { defaultWorkspaceDir: mavis.defaultWorkspaceDir } : {}),
    ...(mavis.extensionSkills === undefined ? {} : { extensionSkills: [...mavis.extensionSkills] }),
  };
}

function toEffectiveConfig(
  config: CanonicalAgentConfig,
  effectiveModel:
    | Pick<
        AgentEffectiveConfigForNewSession,
        'providerId' | 'modelId' | 'effort' | 'contextWindow' | 'maxOutputTokens'
      >
    | undefined,
): AgentEffectiveConfigForNewSession {
  return {
    ...(effectiveModel?.providerId ? { providerId: effectiveModel.providerId } : {}),
    ...(effectiveModel?.modelId ? { modelId: effectiveModel.modelId } : {}),
    ...(effectiveModel?.effort ? { effort: effectiveModel.effort } : {}),
    ...(effectiveModel?.contextWindow === undefined
      ? {}
      : { contextWindow: effectiveModel.contextWindow }),
    ...(effectiveModel?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: effectiveModel.maxOutputTokens }),
    ...(config.tools === undefined ? {} : { tools: [...config.tools] }),
    ...(config.mcpServers === undefined ? {} : { mcpServers: [...config.mcpServers] }),
    ...(config.skills === undefined ? {} : { skills: [...config.skills] }),
    ...(config.xMavis?.extensionSkills === undefined
      ? {}
      : { extensionSkills: [...config.xMavis.extensionSkills] }),
  };
}

function toDiagnostic(input: CanonicalAgentConfig['diagnostics'][number]): AgentConfigDiagnostic {
  return { code: input.code, fieldPath: input.field };
}
