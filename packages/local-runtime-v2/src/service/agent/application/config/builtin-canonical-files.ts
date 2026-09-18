import { BuiltinAgentCatalog, resolveCanonicalCapabilities } from '../../builtin/catalog.js';
import { LEGACY_PRIMARY_AGENT_NAME } from '../../domain/names.js';
import type {
  AgentConfigurationSelection,
  AgentStorePort,
  BuiltinAgentDefinition,
} from '../../contracts.js';
import type {
  BuiltinCanonicalAgentConfigForWrite,
  CanonicalAgentConfig,
  CanonicalAgentMavisConfig,
} from '../../storage/canonical-agent-config.js';
import { resolveLocale } from '../../domain/validation.js';

export type BuiltinModelGroup = Pick<
  AgentConfigurationSelection,
  'model' | 'effort' | 'contextWindow' | 'maxOutputTokens'
>;

/**
 * The Model System binds this only after its live catalog is ready. It owns
 * the previous -> explicit bundled -> unset fallback chain and returns one coherent
 * group, so Agent files never keep a model's limits after its model changes.
 */
export type BuiltinModelGroupResolver = (input: {
  readonly previous?: BuiltinModelGroup;
  readonly bundled?: BuiltinModelGroup;
}) => Promise<BuiltinModelGroup | undefined>;

export async function rebuildBuiltinCanonicalFiles(input: {
  readonly repository: AgentStorePort;
  readonly catalog: BuiltinAgentCatalog;
  readonly definitions: readonly BuiltinAgentDefinition[];
  readonly modelGroupResolver?: BuiltinModelGroupResolver;
  readonly bundledModelGroup?: BuiltinModelGroup;
}): Promise<void> {
  await removeRetiredLegacyPrimaryBuiltinFile(input.repository);
  if (!input.repository.writeBuiltinCanonicalConfig) return;
  for (const definition of input.definitions) {
    await rebuildBuiltinCanonicalFile(input, definition);
  }
}

/** `main` is only a compatibility owner; its old launch file cannot execute. */
async function removeRetiredLegacyPrimaryBuiltinFile(repository: AgentStorePort): Promise<void> {
  await repository.removeBuiltinCanonicalConfig?.(LEGACY_PRIMARY_AGENT_NAME);
}

async function rebuildBuiltinCanonicalFile(
  input: {
    readonly repository: AgentStorePort;
    readonly catalog: BuiltinAgentCatalog;
    readonly modelGroupResolver?: BuiltinModelGroupResolver;
    readonly bundledModelGroup?: BuiltinModelGroup;
  },
  definition: BuiltinAgentDefinition,
): Promise<void> {
  const capabilities = resolveCanonicalCapabilities(undefined, definition.capabilityOverride);
  const [previous, content] = await Promise.all([
    readPreviousBuiltinConfig(input.repository, definition.name),
    input.catalog.readCanonicalContent({
      agentName: definition.name,
      surface: 'interactive',
      appMode: 'coding',
      locale: resolveLocale(),
      promptChannel: 'online',
      capabilities,
    }),
  ]);
  const modelGroup = await resolveBuiltinModelGroup({
    previous,
    resolver: input.modelGroupResolver,
    bundled: input.bundledModelGroup,
  });
  await input.repository.writeBuiltinCanonicalConfig?.(
    definition.name,
    toBuiltinCanonicalConfig(definition, modelGroup, capabilities, content),
  );
}

/**
 * Generates the dynamic bundled baseline returned by Config GET. The caller
 * may pass a currently selected model group so Reset restores platform-owned
 * prompt/capabilities without discarding a user's persistent model choice.
 */
export async function buildBuiltinCanonicalBaseline(input: {
  readonly catalog: BuiltinAgentCatalog;
  readonly definition: BuiltinAgentDefinition;
  readonly modelGroup?: BuiltinModelGroup;
}): Promise<Omit<CanonicalAgentConfig, 'diagnostics'>> {
  const capabilities = resolveCanonicalCapabilities(undefined, input.definition.capabilityOverride);
  const content = await input.catalog.readCanonicalContent({
    agentName: input.definition.name,
    surface: 'interactive',
    appMode: 'coding',
    locale: resolveLocale(),
    promptChannel: 'online',
    capabilities,
  });
  return toBuiltinCanonicalConfig(input.definition, input.modelGroup, capabilities, content);
}

export function builtinModelGroupFromCanonical(
  config: CanonicalAgentConfig | undefined,
): BuiltinModelGroup | undefined {
  return modelGroupFromCanonical(config);
}

async function readPreviousBuiltinConfig(
  repository: AgentStorePort,
  name: string,
): Promise<CanonicalAgentConfig | undefined> {
  if (!repository.getBuiltinCanonicalConfig) return undefined;
  try {
    return await repository.getBuiltinCanonicalConfig(name);
  } catch {
    // Only a fully valid old file contributes a user-chosen model limit.
    return undefined;
  }
}

function toBuiltinCanonicalConfig(
  definition: BuiltinAgentDefinition,
  modelGroup: BuiltinModelGroup | undefined,
  capabilities: ReturnType<typeof resolveCanonicalCapabilities>,
  content: Awaited<ReturnType<BuiltinAgentCatalog['readCanonicalContent']>>,
): BuiltinCanonicalAgentConfigForWrite {
  const xMavis = builtinMavisConfig(definition, modelGroup);
  return {
    name: definition.name,
    description: definition.identity.description?.trim() || definition.name,
    ...(xMavis ? { xMavis } : {}),
    ...(modelGroup?.model ? { model: modelGroup.model } : {}),
    ...(modelGroup?.effort ? { effort: modelGroup.effort } : {}),
    ...(capabilities.tools === undefined ? {} : { tools: capabilities.tools }),
    // `builtinTools` are tool IDs, not MCP server names. Absence here inherits
    // the ready server inventory, which is the bundled default.
    ...(capabilities.skills === undefined ? {} : { skills: capabilities.skills }),
    features: { ...capabilities.features },
    systemPrompt: mergeBuiltinAgentSystemPrompt(content.persona, content.systemPrompt),
  };
}

function builtinMavisConfig(
  definition: BuiltinAgentDefinition,
  modelGroup: BuiltinModelGroup | undefined,
): CanonicalAgentMavisConfig | undefined {
  const displayName = definition.identity.displayName?.trim() || undefined;
  const contextWindow = modelGroup?.contextWindow;
  const maxOutputTokens = modelGroup?.maxOutputTokens;
  if (displayName === undefined && contextWindow === undefined && maxOutputTokens === undefined) {
    return undefined;
  }
  return {
    ...(displayName ? { displayName } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

async function resolveBuiltinModelGroup(input: {
  readonly previous: CanonicalAgentConfig | undefined;
  readonly resolver: BuiltinModelGroupResolver | undefined;
  readonly bundled: BuiltinModelGroup | undefined;
}): Promise<BuiltinModelGroup | undefined> {
  const previous = modelGroupFromCanonical(input.previous);
  if (input.resolver) return input.resolver({ previous, bundled: input.bundled });
  // Agent storage opens before the Desktop Model System has a live catalog.
  // This value is inert until the startup barrier below binds the resolver and
  // rebuilds the files again; preserving it avoids destructive loss on a
  // crash between the two startup phases.
  return previous;
}

function modelGroupFromCanonical(
  config: CanonicalAgentConfig | undefined,
): BuiltinModelGroup | undefined {
  if (!config) return undefined;
  const group = {
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.xMavis?.contextWindow === undefined
      ? {}
      : { contextWindow: config.xMavis.contextWindow }),
    ...(config.xMavis?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.xMavis.maxOutputTokens }),
  };
  return Object.keys(group).length > 0 ? group : undefined;
}

export function mergeBuiltinAgentSystemPrompt(
  persona: string | undefined,
  systemPrompt: string | undefined,
): string {
  const parts = [persona?.trim() ?? '', systemPrompt?.trim() ?? ''].filter(Boolean);
  return parts.join('\n\n');
}
