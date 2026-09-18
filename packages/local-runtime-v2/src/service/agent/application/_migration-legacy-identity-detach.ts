import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveAgentCapabilities } from '@mavis/config';
import { isTrustedBuiltinCreationSource } from '@mavis/agent-tools/desktop/subagent-roles';

import type { BuiltinAgentCatalog, BuiltinRenderInput } from '../builtin/catalog.js';
import {
  createBuiltinPromptContext,
  parseFrontmatter,
  renderBuiltinTemplate,
} from '../builtin/prompt-renderer.js';
import type {
  AgentPromptMaterializationAction,
  AgentStoreMeta,
  AgentStorePort,
} from '../contracts.js';

/**
 * Historic built-in Agents that become ordinary manual Agents on upgrade. They
 * are matched by exact stable name only; a same-named manual or unknown row is
 * left untouched.
 */
const DETACHABLE_LEGACY_BUILTIN_NAMES = ['general', 'coder'] as const;

/** Frozen, roster-excluded asset root. See assets/agents/_migration/README.md. */
const MIGRATION_ASSET_DIR = '_migration';
const SYSTEM_PROMPT_TEMPLATE = 'system-prompt.md.hbs';
const UNRENDERED_TEMPLATE_RE = /\{\{/u;
const FROZEN_PERSONA_FILE_RE = /^PERSONA(?:-[a-z0-9][a-z0-9_-]*)?\.md$/iu;

/** Bounded startup stages; never use prompt, Persona, Memory, or credential text as a stage. */
type LegacyIdentityDetachPhase =
  | 'eligibility'
  | 'materialization'
  | 'validation'
  | 'identity_update';

/** Bounded outcome for the stage-local startup record. */
type LegacyIdentityDetachOutcome = 'completed' | 'skipped' | 'failed';
type LegacyIdentityDetachAsset = 'persona' | 'system_prompt';
type LegacyIdentityDetachAction = AgentPromptMaterializationAction;
type LegacyIdentityDetachAvatarDecision =
  | 'clear_builtin_default'
  | 'preserve_custom'
  | 'preserve_missing';

interface LegacyIdentityDetachAssetContext {
  readonly asset: LegacyIdentityDetachAsset;
  /** Absent only while the initial profile read has not produced a decision. */
  readonly action?: LegacyIdentityDetachAction;
}

interface MaterializedProfileAsset extends LegacyIdentityDetachAssetContext {
  readonly action: LegacyIdentityDetachAction;
}

interface LegacyIdentityDetachReport {
  readonly phase: LegacyIdentityDetachPhase;
  readonly outcome: LegacyIdentityDetachOutcome;
  /** Identifies a profile read/materialization failure without exposing its path or error. */
  readonly context?: LegacyIdentityDetachAssetContext;
  /** Bounded identity result; never carries an avatar value. */
  readonly avatarDecision?: LegacyIdentityDetachAvatarDecision;
}

/**
 * Startup-only, content-free detach record. It identifies only the stable row,
 * bounded stage, and bounded result. `asset` may identify an initial read
 * failure before an action is known; `action` is omitted in that case. It
 * never carries Persona, prompt, Memory, credential, path, or error text.
 */
export interface LegacyIdentityDetachEvent {
  readonly agentName: string;
  readonly phase: LegacyIdentityDetachPhase;
  readonly outcome: LegacyIdentityDetachOutcome;
  /** Present for every materialization result and asset-local read/failure. */
  readonly asset?: LegacyIdentityDetachAsset;
  /** Bounded decision once known; omitted for an initial read failure. */
  readonly action?: LegacyIdentityDetachAction;
  /** Identity outcome without an avatar URL or other profile content. */
  readonly avatarDecision?: LegacyIdentityDetachAvatarDecision;
}

export interface LegacyIdentityDetachInput {
  readonly repository: AgentStorePort;
  readonly catalog: BuiltinAgentCatalog;
  readonly locale: string;
  readonly report?: (event: LegacyIdentityDetachEvent) => void;
}

/**
 * Detaches the historic General/Coder built-in identities in place.
 *
 * Their Persona and system prompt used to be read from the install package, so
 * flipping `creation_source` alone would leave an ordinary Agent with no stable
 * definition. This is deliberately limited to proven builtin provenance: a
 * same-named manual/custom row must retain every profile byte as authoritative.
 * Missing assets publish through durable no-replace staging; semantic blanks
 * are archived and atomically repaired; both are read back through the
 * ordinary Agent path before `creation_source` changes. The persisted avatar
 * is cleared only when it exactly matches one of this Agent's frozen historic
 * Persona defaults. Every published frozen locale is considered because an
 * upgrade can run under a locale different from the one that wrote the avatar;
 * a custom or missing user avatar remains untouched. Either failure leaves a
 * retryable builtin; if clearing succeeds but the source flip fails, that
 * builtin state uses its catalog avatar fallback instead of exposing it as
 * Custom. No other row field is written.
 */
export async function detachLegacyBuiltinIdentities(
  input: LegacyIdentityDetachInput,
): Promise<void> {
  // Canonical Custom reads intentionally fail closed, but older releases may
  // already have detached General/Coder rows whose profile is still plain
  // Markdown.  Consult the startup-only runtime index first so eligibility can
  // skip those non-builtins without parsing them before the later legacy
  // Custom materialization barrier has converted their files.
  const legacyCustomNames = new Set(
    (await input.repository.listLegacyCustomAgents?.())?.map((meta) => meta.name) ?? [],
  );
  for (const agentName of DETACHABLE_LEGACY_BUILTIN_NAMES) {
    if (legacyCustomNames.has(agentName)) {
      report(input, agentName, { phase: 'eligibility', outcome: 'skipped' });
      continue;
    }
    await detachOne(input, agentName);
  }
}

async function detachOne(input: LegacyIdentityDetachInput, agentName: string): Promise<void> {
  let phase: LegacyIdentityDetachPhase = 'eligibility';
  let activeAsset: LegacyIdentityDetachAssetContext | undefined;
  let materialized: readonly MaterializedProfileAsset[] = [];
  let avatarDecision: LegacyIdentityDetachAvatarDecision | undefined;
  try {
    const meta = await input.repository.get(agentName);
    if (!meta || !isTrustedBuiltinCreationSource(meta.creationSource)) {
      report(input, agentName, { phase, outcome: 'skipped' });
      return;
    }
    report(input, agentName, { phase, outcome: 'completed' });

    phase = 'materialization';
    materialized = await materializeFrozenProfile(input, meta, {
      onStart: (context) => {
        activeAsset = context;
      },
      onCompleted: (context) => {
        report(input, agentName, { phase, outcome: 'completed', context });
        activeAsset = undefined;
      },
    });

    phase = 'validation';
    await assertManualProfileIsReadable(input, meta, materialized);
    report(input, agentName, { phase, outcome: 'completed' });

    phase = 'identity_update';
    avatarDecision = await resolveAvatarDecision(input, meta.name);
    if (avatarDecision === 'clear_builtin_default') {
      await input.repository.updateIdentity(meta.name, { avatar: undefined });
    }
    // This must remain last: all required files are durably published/repaired
    // and read back first. A crash before this source flip leaves a retryable
    // builtin; a crash after it cannot expose a Custom Agent with a missing
    // profile. A cleared historic default falls back through the builtin catalog
    // only until this source flip completes; custom and missing avatars persist.
    await input.repository.update(meta.name, { creationSource: 'manual' });
    report(input, agentName, { phase, outcome: 'completed', avatarDecision });
  } catch (error) {
    report(input, agentName, {
      phase,
      outcome: 'failed',
      context: error instanceof LegacyProfileValidationError ? error.context : activeAsset,
      ...(avatarDecision ? { avatarDecision } : {}),
    });
    throw error;
  }
}

async function resolveAvatarDecision(
  input: LegacyIdentityDetachInput,
  agentName: string,
): Promise<LegacyIdentityDetachAvatarDecision> {
  const avatar = (await input.repository.getIdentity(agentName))?.avatar;
  if (avatar === undefined) return 'preserve_missing';
  return (await readFrozenDefaultAvatars(input.catalog, agentName)).has(avatar)
    ? 'clear_builtin_default'
    : 'preserve_custom';
}

/**
 * Frozen Persona frontmatter is the source of truth for the only legacy
 * defaults we may clear. Read every published locale rather than the current
 * runtime locale: locale drift must not turn a historic default into a custom
 * avatar or erase a user replacement.
 */
async function readFrozenDefaultAvatars(
  catalog: BuiltinAgentCatalog,
  agentName: string,
): Promise<ReadonlySet<string>> {
  const assetDir = join(await catalog.resolveAssetsDir(), MIGRATION_ASSET_DIR, agentName);
  const personaFiles = (await readdir(assetDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && FROZEN_PERSONA_FILE_RE.test(entry.name))
    .map((entry) => entry.name);
  const avatars = new Set(
    (
      await Promise.all(
        personaFiles.map(async (file) => {
          const raw = await readFile(join(assetDir, file), 'utf8');
          return parseFrontmatter(raw).frontmatter.avatar;
        }),
      )
    ).filter((avatar): avatar is string => typeof avatar === 'string'),
  );
  if (avatars.size === 0) {
    throw new Error(`Frozen migration Persona avatar is missing for Agent "${agentName}".`);
  }
  return avatars;
}

interface MaterializationCallbacks {
  onStart(context: LegacyIdentityDetachAssetContext): void;
  onCompleted(context: MaterializedProfileAsset): void;
}

/**
 * Each asset is decided separately: one damaged half can self-heal while an
 * existing body on the other half remains user-owned and untouched.
 */
async function materializeFrozenProfile(
  input: LegacyIdentityDetachInput,
  meta: AgentStoreMeta,
  callbacks: MaterializationCallbacks,
): Promise<readonly MaterializedProfileAsset[]> {
  const persona = await materializeFrozenAsset(input, meta, 'persona', callbacks);
  const systemPrompt = await materializeFrozenAsset(input, meta, 'system_prompt', callbacks);
  return [persona, systemPrompt];
}

async function materializeFrozenAsset(
  input: LegacyIdentityDetachInput,
  meta: AgentStoreMeta,
  asset: LegacyIdentityDetachAsset,
  callbacks: MaterializationCallbacks,
): Promise<MaterializedProfileAsset> {
  // The first read can fail before we know whether the asset is missing,
  // preserved, or blank. Keep its exact bounded asset for failure reporting
  // but do not invent an action until the read completes.
  callbacks.onStart({ asset });
  const existing = await readProfileAsset(input.repository, meta.name, asset);
  const planned: MaterializedProfileAsset = {
    asset,
    action: materializationAction(existing),
  };
  callbacks.onStart(planned);
  if (planned.action === 'preserved') {
    callbacks.onCompleted(planned);
    return planned;
  }

  const assetDir = join(await input.catalog.resolveAssetsDir(), MIGRATION_ASSET_DIR, meta.name);
  const frozen =
    asset === 'persona'
      ? await readFrozenPersona(assetDir, meta.name, input.locale)
      : await renderFrozenSystemPrompt(assetDir, meta.name, input.locale);
  const action =
    asset === 'persona'
      ? await input.repository.materializePersonaForTrustedBuiltin(meta.name, frozen)
      : await input.repository.materializeSystemPromptForTrustedBuiltin(meta.name, frozen);
  const materialized = { asset, action };
  callbacks.onCompleted(materialized);
  return materialized;
}

function materializationAction(value: string | null): LegacyIdentityDetachAction {
  if (value === null) return 'published_missing';
  return value.trim().length === 0 ? 'repaired_blank' : 'preserved';
}

function readProfileAsset(
  repository: AgentStorePort,
  name: string,
  asset: LegacyIdentityDetachAsset,
): Promise<string | null> {
  return asset === 'persona' ? repository.getPersona(name) : repository.getSystemPrompt(name);
}

async function readFrozenPersona(
  assetDir: string,
  agentName: string,
  locale: string,
): Promise<string> {
  const language = locale.trim().toLowerCase().split(/[-_]/u)[0] || 'en';
  const candidates = [
    language.startsWith('zh') ? 'PERSONA-zh.md' : `PERSONA-${language}.md`,
    'PERSONA.md',
  ];
  for (const candidate of candidates) {
    const raw = await readOptionalFile(join(assetDir, candidate));
    if (raw !== undefined) return raw;
  }
  throw new Error(`Frozen migration Persona is missing for Agent "${agentName}".`);
}

async function renderFrozenSystemPrompt(
  assetDir: string,
  agentName: string,
  locale: string,
): Promise<string> {
  const template = await readOptionalFile(join(assetDir, SYSTEM_PROMPT_TEMPLATE));
  if (template === undefined) {
    throw new Error(`Frozen migration system prompt is missing for Agent "${agentName}".`);
  }
  const rendered = renderBuiltinTemplate(
    template,
    createBuiltinPromptContext(frozenRenderInput(agentName, locale), {}),
    `${MIGRATION_ASSET_DIR}/${agentName}/${SYSTEM_PROMPT_TEMPLATE}`,
  );
  // An ordinary Agent prompt is used verbatim, so a surviving placeholder would
  // become permanent user-visible template text.
  if (UNRENDERED_TEMPLATE_RE.test(rendered)) {
    throw new Error(
      `Frozen migration system prompt for Agent "${agentName}" still contains unrendered template syntax.`,
    );
  }
  return rendered;
}

/**
 * Reads back exactly what the ordinary Agent profile path reads, so a broken
 * materialization fails while the row is still a recoverable built-in.
 */
async function assertManualProfileIsReadable(
  input: LegacyIdentityDetachInput,
  meta: AgentStoreMeta,
  materialized: readonly MaterializedProfileAsset[],
): Promise<void> {
  const [persona, systemPrompt] = await Promise.all([
    input.repository.getPersona(meta.name),
    input.repository.getSystemPrompt(meta.name),
  ]);
  if (!persona?.trim()) {
    throw new LegacyProfileValidationError('persona', materializedAction(materialized, 'persona'));
  }
  if (!systemPrompt?.trim()) {
    throw new LegacyProfileValidationError(
      'system_prompt',
      materializedAction(materialized, 'system_prompt'),
    );
  }
  await input.catalog.renderSharedBasePrompt(
    frozenRenderInput(meta.name, input.locale),
    meta.agentRole,
  );
}

function materializedAction(
  materialized: readonly MaterializedProfileAsset[],
  asset: LegacyIdentityDetachAsset,
): LegacyIdentityDetachAction {
  return materialized.find((entry) => entry.asset === asset)?.action ?? 'preserved';
}

class LegacyProfileValidationError extends Error {
  readonly context: LegacyIdentityDetachAssetContext;

  constructor(asset: LegacyIdentityDetachAsset, action: LegacyIdentityDetachAction) {
    super('Legacy Agent profile is not readable after identity detach preparation.');
    this.context = { asset, action };
  }
}

/**
 * Stable render context for the one-shot migration. The frozen prompts are
 * gated only on capability features, so default capabilities keep the result
 * deterministic across installations.
 */
function frozenRenderInput(agentName: string, locale: string): BuiltinRenderInput {
  return {
    agentName,
    surface: 'interactive',
    appMode: 'coding',
    locale,
    promptChannel: 'online',
    capabilities: resolveAgentCapabilities(undefined),
  };
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function report(
  input: LegacyIdentityDetachInput,
  agentName: string,
  event: LegacyIdentityDetachReport,
): void {
  try {
    input.report?.({
      agentName,
      phase: event.phase,
      outcome: event.outcome,
      ...(event.context ? { asset: event.context.asset } : {}),
      ...(event.context?.action ? { action: event.context.action } : {}),
      ...(event.avatarDecision ? { avatarDecision: event.avatarDecision } : {}),
    });
  } catch {
    // Observability must never change the identity detach outcome.
  }
}
