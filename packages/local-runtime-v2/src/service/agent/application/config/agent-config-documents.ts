import { createHash } from 'node:crypto';

import { BuiltinAgentCatalog, canonicalBuiltinName } from '../../builtin/catalog.js';
import { parseExplicitNameOrStable } from '../../domain/names.js';
import { AgentServiceError } from '../../errors.js';
import type {
  AgentConfigDocument,
  AgentConfigPutInput,
  AgentEffectiveConfigForNewSession,
  AgentExecutionProfile,
  AgentProfileRequest,
  AgentReadScope,
  AgentStoreMeta,
  AgentStorePort,
  BuiltinAgentDefinition,
} from '../../contracts.js';
import {
  AgentConfigError,
  serializeCanonicalAgentConfig,
  type CanonicalAgentConfig,
} from '../../storage/canonical-agent-config.js';
import {
  BuiltinAgentConfigModelOnlyError,
  AgentConfigInstanceConflictError,
  AgentConfigRevisionConflictError,
} from '../../storage/agent-files.js';
import { redactedErrorFacts, type RedactedErrorFacts } from '../../diagnostics.js';
import { asAgentConfigServiceError } from '../agent-profile.js';
import {
  buildBuiltinCanonicalBaseline,
  builtinModelGroupFromCanonical,
} from './builtin-canonical-files.js';
import { toAgentConfigDocument, toConfiguredModelSelection } from './config-document.js';

type EffectiveModelPreview = Pick<
  AgentEffectiveConfigForNewSession,
  'providerId' | 'modelId' | 'effort' | 'contextWindow' | 'maxOutputTokens'
>;

type EffectiveModelResolver = (
  config: CanonicalAgentConfig,
) => Promise<EffectiveModelPreview | undefined>;

/** Runtime-owned model resolution for Config's non-authoritative effective preview. */
export type AgentEffectiveConfigResolver = (input: {
  readonly profile: AgentExecutionProfile;
  readonly configuredModelSelection: ReturnType<typeof toConfiguredModelSelection>;
}) => Promise<EffectiveModelPreview | undefined>;

/**
 * One bounded fact per unexpected effective-model preview failure.
 *
 * A *known* unusable model (deleted model, removed provider, disabled catalog
 * entry) is normal degradation and is already mapped to `undefined` inside the
 * bound resolver — it must not produce a log line. Anything reported here got
 * past that mapping, i.e. it is a defect whose stack we need in order to
 * diagnose a degraded Config read that the user never sees as an error.
 */
export interface AgentConfigPreviewDiagnostic extends RedactedErrorFacts {
  readonly exactOwnerName: string;
  readonly stage: 'render_profile' | 'resolve_effective_model';
}

export type AgentConfigPreviewDiagnosticsReporter = (event: AgentConfigPreviewDiagnostic) => void;

/**
 * Why a candidate configuration may not be persisted.
 *
 * `not_configured` covers "the Agent ends up with no model at all" — including
 * the resolver returning `undefined` — and `unavailable` covers "the selected
 * model exists in the file but the catalog can no longer serve it". They are
 * separate because the user-facing fix differs (pick *a* model vs. pick
 * *another* model).
 */
type AgentCandidateModelVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'not_configured' | 'unavailable';
      readonly detail?: string;
    };

/**
 * Runtime-owned strict model validation for a not-yet-persisted configuration.
 *
 * Deliberately *not* the preview resolver: the preview degrades to `undefined`
 * so a read stays available, whereas this gate must reject the write. It is
 * also evaluated against the candidate config alone — never the rendered
 * profile — because the profile still reflects the currently persisted file.
 */
export type AgentCandidateModelValidator = (input: {
  readonly exactOwnerName: string;
  readonly configuredModelSelection: ReturnType<typeof toConfiguredModelSelection>;
}) => Promise<AgentCandidateModelVerdict>;

/** Config orchestration shared by LocalAgentService's public API surface. */
export abstract class AgentConfigDocuments {
  protected abstract readonly options: { readonly repository: AgentStorePort };
  protected abstract readonly catalog: BuiltinAgentCatalog;
  protected abstract resolveAgentReadScope(requestRef: string): Promise<AgentReadScope>;
  protected abstract requireMeta(name: string): Promise<AgentStoreMeta>;
  protected abstract isBuiltin(meta: AgentStoreMeta): boolean;
  protected abstract definitionFor(name: string): Promise<BuiltinAgentDefinition | undefined>;
  protected abstract renderProfile(input: AgentProfileRequest): Promise<AgentExecutionProfile>;

  /** Custom callers may need a broader write boundary than the document's per-Agent CAS. */
  protected abstract withConfigDocumentWriteLock<T>(
    _meta: AgentStoreMeta,
    operation: () => Promise<T>,
  ): Promise<T>;

  /** Runs after the current document is read and before its CAS replacement. */
  protected abstract validateConfigDocumentWrite(_input: {
    readonly meta: AgentStoreMeta;
    readonly current: AgentConfigDocument;
    readonly request: AgentConfigPutInput;
  }): Promise<void>;

  private effectiveConfigResolver: AgentEffectiveConfigResolver | undefined;
  private configPreviewDiagnostics: AgentConfigPreviewDiagnosticsReporter | undefined;
  private candidateModelValidator: AgentCandidateModelValidator | undefined;

  /** Binds after ModelSystem construction; isolated/CLI tests may intentionally omit it. */
  bindEffectiveConfigResolver(resolver: AgentEffectiveConfigResolver): void {
    this.effectiveConfigResolver = resolver;
  }

  /**
   * Binds the Runtime logger to unexpected preview failures. Optional on
   * purpose: an unbound sink only costs observability, never correctness, so
   * isolated/CLI compositions may omit it exactly like the resolver above.
   */
  bindConfigPreviewDiagnostics(report: AgentConfigPreviewDiagnosticsReporter): void {
    this.configPreviewDiagnostics = report;
  }

  /**
   * Binds strict save-time model validation. Unlike the preview sinks above
   * this one is *required* by every write path — see `assertCandidateModelIsUsable`.
   */
  bindCandidateModelValidator(validate: AgentCandidateModelValidator): void {
    this.candidateModelValidator = validate;
  }

  /**
   * Fail-closed model gate for one candidate configuration.
   *
   * Saving a configuration whose model cannot be resolved produces an Agent
   * that looks correct in the UI and then fails at execution time, far away
   * from the action that caused it. The write is therefore rejected up front.
   *
   * Unbound is treated as *not ready*, never as *allowed*: silently skipping
   * the check would reintroduce exactly the unusable-model writes this gate
   * exists to stop, and a half-composed runtime is a transient startup state
   * that the caller can retry.
   */
  protected async assertCandidateModelIsUsable(input: {
    readonly exactOwnerName: string;
    readonly configuredModelSelection: ReturnType<typeof toConfiguredModelSelection>;
  }): Promise<void> {
    const validate = this.candidateModelValidator;
    if (!validate) {
      throw new AgentServiceError(
        'CANONICAL_AGENT_NOT_AVAILABLE',
        'Agent model validation is not ready yet; retry once the runtime has finished starting.',
      );
    }
    const verdict = await validate({
      exactOwnerName: input.exactOwnerName,
      configuredModelSelection: input.configuredModelSelection,
    });
    if (verdict.ok) return;
    throw new AgentServiceError('AGENT_CONFIG_INVALID', candidateModelRejectionMessage(verdict));
  }

  /**
   * Gate for identity-only writes (display name, avatar).
   *
   * Such a patch never carries a model, so the merged candidate's model *is*
   * the persisted one — reading it back is how this entry point obtains a
   * candidate at all. Without it, renaming an Agent stays a way to write an
   * Agent that cannot run, reachable by calling the API directly even though
   * the UI routes identity saves through Config PUT.
   *
   * Reads the canonical config rather than the full Config document: only the
   * model group matters here, and the document read would additionally compute
   * the effective-model preview this write does not need.
   */
  protected async assertPersistedModelIsUsable(exactOwnerName: string): Promise<void> {
    const readCanonical = this.options.repository.getCanonicalConfig;
    if (!readCanonical) {
      // Fail closed for the same reason as an unbound validator: skipping the
      // read would silently skip the gate.
      throw new AgentServiceError(
        'CANONICAL_AGENT_NOT_AVAILABLE',
        'Canonical Agent configuration reads are unavailable, so the Agent model cannot be validated.',
      );
    }
    // A missing or invalid canonical file surfaces as its real AgentConfigError
    // (mapped by the caller); it is never treated as "no model to check".
    const config = await readCanonical.call(this.options.repository, exactOwnerName);
    await this.assertCandidateModelIsUsable({
      exactOwnerName,
      configuredModelSelection: toConfiguredModelSelection(config),
    });
  }

  /** Full raw Config API document; exact owner + incarnation are server-owned. */
  async getConfigDocument(requestRef: string): Promise<AgentConfigDocument> {
    const scope = await this.resolveAgentReadScope(requestRef);
    const meta = await this.requireMeta(scope.exactOwnerName);
    return this.readConfigDocumentForMeta(meta, scope.exactOwnerName);
  }

  /** Captures the just-created Custom incarnation before any fallible Config parse/read. */
  async getOrCreateCustomAgentInstanceId(requestRef: string): Promise<string> {
    const exactOwnerName = parseExplicitNameOrStable(requestRef);
    const readInstanceId = this.options.repository.getOrCreateCustomAgentInstanceId;
    if (!readInstanceId) {
      throw new AgentServiceError(
        'AGENT_CONFIG_INVALID',
        'Conditional Agent cleanup marker is unavailable.',
      );
    }
    return readInstanceId.call(this.options.repository, exactOwnerName);
  }

  /**
   * Applies one complete canonical document. Existing Sessions remain frozen;
   * only a later Session capture sees the re-read effective configuration.
   */
  async putConfigDocument(input: AgentConfigPutInput): Promise<AgentConfigDocument> {
    if (!input.expectedRevision.trim()) {
      throw new AgentServiceError(
        'VALIDATION_ERROR',
        'expectedRevision is required for Agent configuration updates.',
      );
    }
    const scope = await this.resolveAgentReadScope(input.requestRef);
    const meta = await this.requireMeta(scope.exactOwnerName);
    await this.withConfigDocumentWriteLock(meta, async () => {
      const current = await this.readConfigDocumentForMeta(meta, scope.exactOwnerName);
      const builtin = this.isBuiltin(meta);
      await this.validateConfigDocumentWrite({ meta, current, request: input });
      await replaceAgentConfigDocument({
        repository: this.options.repository,
        request: input,
        current,
        storageName: builtin ? canonicalBuiltinName(meta.name) : meta.name,
        builtin,
      });
    });
    return this.getConfigDocument(`agent:${meta.name}`);
  }

  /** Import rollback never removes a same-name Agent created after the failed PUT. */
  async deleteIfOwnerInstanceId(
    requestRef: string,
    expectedOwnerInstanceId: string,
  ): Promise<boolean> {
    const exactOwnerName = parseExplicitNameOrStable(requestRef);
    const conditionalDelete = this.options.repository.deleteIfOwnerInstanceId;
    if (!conditionalDelete) {
      throw new AgentServiceError(
        'AGENT_CONFIG_INVALID',
        'Conditional Agent cleanup is unavailable.',
      );
    }
    return conditionalDelete.call(this.options.repository, exactOwnerName, expectedOwnerInstanceId);
  }

  private async readConfigDocumentForMeta(
    meta: AgentStoreMeta,
    exactOwnerName: string,
  ): Promise<AgentConfigDocument> {
    const resolveEffectiveModel = (config: CanonicalAgentConfig) =>
      this.resolveEffectiveConfigPreview(exactOwnerName, config);
    if (!this.isBuiltin(meta)) {
      return readCustomAgentConfigDocument({
        repository: this.options.repository,
        name: meta.name,
        exactOwnerName,
        resolveEffectiveModel,
      });
    }
    const storageName = canonicalBuiltinName(meta.name);
    const definition = await this.definitionFor(storageName);
    if (!definition) {
      throw new AgentServiceError(
        'AGENT_CONFIG_NOT_FOUND',
        'Built-in Agent definition is unavailable.',
      );
    }
    return readBuiltinAgentConfigDocument({
      repository: this.options.repository,
      catalog: this.catalog,
      name: storageName,
      exactOwnerName,
      definition,
      resolveEffectiveModel,
    });
  }

  /**
   * The effective model is a *preview*, not an authority: execution resolves
   * its own model. The already-read raw document (name, avatar, prompt,
   * fields, revision, ownerInstanceId) is therefore never withheld because
   * this preview could not be computed — losing the preview degrades one
   * optional field, while throwing here fails the whole Config GET and takes
   * the Agent's detail page down with it.
   *
   * The guard deliberately covers the whole boundary instead of enumerating
   * exception classes: profile rendering and the bound resolver both reach
   * Runtime-owned code (prompt files, model catalog, provider config) whose
   * failure modes are not enumerable from here.
   */
  private async resolveEffectiveConfigPreview(
    exactOwnerName: string,
    config: CanonicalAgentConfig,
  ): Promise<EffectiveModelPreview | undefined> {
    if (!this.effectiveConfigResolver) return undefined;
    let stage: AgentConfigPreviewDiagnostic['stage'] = 'render_profile';
    try {
      // Profile rendering is the same Agent source used by Session-definition
      // capture. The raw canonical config remains available as a first-start
      // fallback before a bundled Builtin has a managed profile file.
      const profile = await this.renderProfile({
        exactOwnerName,
        requestRef: `agent:${exactOwnerName}`,
        surface: 'interactive',
      });
      stage = 'resolve_effective_model';
      // `return await` keeps an async rejection inside this try; a bare
      // `return` would let the Promise reject after the guard has exited.
      return await this.effectiveConfigResolver({
        profile,
        configuredModelSelection: toConfiguredModelSelection(config),
      });
    } catch (error) {
      this.reportConfigPreviewFailure(exactOwnerName, stage, error);
      return undefined;
    }
  }

  /** Fail-open: observability must never turn a degraded preview into a failed read. */
  private reportConfigPreviewFailure(
    exactOwnerName: string,
    stage: AgentConfigPreviewDiagnostic['stage'],
    error: unknown,
  ): void {
    const report = this.configPreviewDiagnostics;
    if (!report) return;
    try {
      report({ exactOwnerName, stage, ...redactedErrorFacts(error) });
    } catch {
      // A broken log sink is strictly less important than returning the config.
    }
  }
}

async function readCustomAgentConfigDocument(input: {
  readonly repository: AgentStorePort;
  readonly name: string;
  readonly exactOwnerName: string;
  readonly resolveEffectiveModel: EffectiveModelResolver;
}): Promise<AgentConfigDocument> {
  if (!input.repository.readCustomCanonicalDocumentWithInstance) {
    throw unavailableConfigStorage();
  }
  try {
    const { document, ownerInstanceId } =
      await input.repository.readCustomCanonicalDocumentWithInstance(input.name);
    return toAgentConfigDocument({
      exactOwnerName: input.exactOwnerName,
      ownerKind: 'custom',
      ownerInstanceId,
      ...document,
      effectiveModel: await input.resolveEffectiveModel(document.config),
    });
  } catch (error) {
    throw asAgentConfigServiceError(error);
  }
}

async function readBuiltinAgentConfigDocument(input: {
  readonly repository: AgentStorePort;
  readonly catalog: BuiltinAgentCatalog;
  readonly name: string;
  readonly exactOwnerName: string;
  readonly definition: BuiltinAgentDefinition;
  readonly resolveEffectiveModel: EffectiveModelResolver;
}): Promise<AgentConfigDocument> {
  if (!input.repository.readCanonicalDocument) throw unavailableConfigStorage();
  let document;
  try {
    document = await input.repository.readCanonicalDocument(input.name, true);
  } catch (error) {
    if (!(error instanceof AgentConfigError) || error.code !== 'AGENT_CONFIG_NOT_FOUND') {
      throw asAgentConfigServiceError(error);
    }
  }
  const baseline = await buildBuiltinBaselineDocument(input.catalog, input.definition, document);
  const current = document ?? baseline;
  return toAgentConfigDocument({
    exactOwnerName: input.exactOwnerName,
    ownerKind: 'builtin',
    ...current,
    baselineContent: baseline.content,
    effectiveModel: await input.resolveEffectiveModel(current.config),
  });
}

async function replaceAgentConfigDocument(input: {
  readonly repository: AgentStorePort;
  readonly request: AgentConfigPutInput;
  readonly current: AgentConfigDocument;
  readonly storageName: string;
  readonly builtin: boolean;
}): Promise<void> {
  const expectedInstanceId = input.request.expectedOwnerInstanceId;
  if (!input.builtin && !expectedInstanceId?.trim()) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INSTANCE_REQUIRED',
      'expectedOwnerInstanceId is required for Custom Agent configuration updates.',
    );
  }
  if (!input.builtin && expectedInstanceId !== input.current.ownerInstanceId) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INSTANCE_CONFLICT',
      'Agent instance has changed; reload the configuration before saving.',
    );
  }
  if (!input.repository.replaceCanonicalDocument) throw unavailableConfigStorage();
  try {
    await input.repository.replaceCanonicalDocument({
      name: input.storageName,
      content: input.request.content,
      expectedRevision: input.request.expectedRevision,
      builtin: input.builtin,
      ...(input.builtin ? { missingContent: input.current.content } : {}),
      ...(!input.builtin && expectedInstanceId ? { expectedInstanceId } : {}),
    });
  } catch (error) {
    throw asConfigDocumentWriteError(error);
  }
}

async function buildBuiltinBaselineDocument(
  catalog: BuiltinAgentCatalog,
  definition: BuiltinAgentDefinition,
  current: Awaited<ReturnType<NonNullable<AgentStorePort['readCanonicalDocument']>>> | undefined,
) {
  const baseline = await buildBuiltinCanonicalBaseline({
    catalog,
    definition,
    modelGroup: builtinModelGroupFromCanonical(current?.config),
  });
  const content = serializeCanonicalAgentConfig({ config: baseline });
  const config: CanonicalAgentConfig = { ...baseline, diagnostics: [] };
  return {
    content,
    revision: createHash('sha256').update(content, 'utf8').digest('hex'),
    config,
  };
}

function unavailableConfigStorage(): AgentServiceError {
  return new AgentServiceError(
    'AGENT_CONFIG_NOT_FOUND',
    'Canonical Agent configuration storage is unavailable.',
  );
}

function asConfigDocumentWriteError(error: unknown): Error {
  if (error instanceof BuiltinAgentConfigModelOnlyError) {
    return new AgentServiceError(
      'BUILTIN_AGENT_IMMUTABLE',
      'Built-in Agent configuration may only change its model selection.',
    );
  }
  if (error instanceof AgentConfigRevisionConflictError) {
    return new AgentServiceError(
      'AGENT_CONFIG_REVISION_CONFLICT',
      'Agent configuration has changed; reload before saving.',
    );
  }
  if (error instanceof AgentConfigInstanceConflictError) {
    return new AgentServiceError(
      'AGENT_CONFIG_INSTANCE_CONFLICT',
      'Agent instance has changed; reload before saving.',
    );
  }
  return asAgentConfigServiceError(error);
}

/**
 * Builds the user-facing rejection text. The message must name the action the
 * user can take, because this error surfaces directly in the Agent editor
 * where the only available remedy is changing the model selection.
 */
function candidateModelRejectionMessage(
  verdict: Extract<AgentCandidateModelVerdict, { ok: false }>,
): string {
  const base =
    verdict.reason === 'not_configured'
      ? 'This Agent has no usable model configured; select a model before saving.'
      : 'The model selected for this Agent is no longer available; select another model before saving.';
  const detail = verdict.detail ? ` (${verdict.detail})` : '';
  return `${base}${detail}`;
}
