/**
 * `@mavis/agent-runtime` — pluggable extension SPI + per-turn assembler on top of
 * `@mavis/agent-core`.
 *
 * Aligned with the `packages/agent-runtime` Feishu design document v1.0 after review. Key
 * constraints:
 * - Extensions must not import one another; host assembly load order alone determines execution
 *   order.
 * - `assembleTurn(ctx)` only assembles contributions; the host constructs `RunTurnInput` from the
 *   result.
 * - Registry state is in-memory only; the host owns persistence (e.g. `extensionOverrides`).
 *
 * Event names follow document §4.2, including `on_step_end` aligned with pi's current
 * step-completion semantics. `AssemblyResult.hooks` maps to agent-core's
 * `PiTurnHooks.onStepEndHook` (the preferred name introduced in §11.6 Step A). agent-core still
 * reads the deprecated per-step slot `onTurnEndHook`, but agent-runtime only writes the new,
 * semantically explicit field; see `HOOK_MAPPINGS` in `registry.ts`.
 */

import type {
  PiAfterLlmCallHook,
  PiAfterLlmCallHookDecision,
  PiAfterLlmCallHookInput,
  PiAfterToolCallHook,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
  PiBeforeToolCallHook,
  PiHistoryChangedHookInput,
  PiLlmCallPreparedHookInput,
  PiOnHistoryChangedHook,
  PiOnStepEndHook,
  PiStepEndHookInput,
  PiTurnHooks,
} from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool, ToolExecutionContext } from '@mavis/agent-core/tools';
import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@sinclair/typebox';
import type { PromptReadScope } from './prompt-read.js';

/**
 * Pi runtime history projection used by both `TurnAssemblyCtx` and
 * `TurnStartEvent`. Matches what `PiTurnRunner.runTurn` consumes as `history`
 * and what pi's `on_history_changed` payload carries — pi's `AgentMessage`
 * union (User / Assistant / ToolResult with `role`-discriminated content),
 * NOT the flat `@mavis/agent-core/protocol` wire shape.
 */
export type TurnHistoryProjection = readonly PiAgentMessage[];

// ─────────────────────────── Utility types ────────────────────────────

export type MaybePromise<T> = T | Promise<T>;

// ─────────────────────────── Turn assembly ctx ────────────────────────

/**
 * Read-only per-turn context exposed to extensions. **Intentionally excludes** `eventWriter`,
 * `llm`, `signal`, and `toolContext`, which belong to the host. See document §6.2 for the minimal
 * field set.
 *
 * `agentConfig` / `model` are declared only as `Readonly<unknown>` to keep agent-runtime neutral to
 * host-specific schemas (local-runtime's `AgentConfigRecord`, cloud-runtime's `ResolvedModel`).
 * Extensions assert types when they need specific fields.
 */
export interface UserMessageContribution {
  readonly text: string;
}

/**
 * Secret-free, host-validated product intent for the current Turn. Extensions
 * may use it to activate an explicit workflow without receiving raw ingress
 * provenance or transport-owned metadata.
 */
export interface TurnIntent {
  readonly kind: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface ModelContextAssemblyCtx {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly agentConfig: Readonly<Record<string, unknown>>;
  readonly model: Readonly<Record<string, unknown>>;
  /**
   * pi runtime history for this turn — see `TurnHistoryProjection` for shape.
   */
  readonly history: TurnHistoryProjection;
  readonly userInput?: UserMessageContribution;
  readonly turnIntent?: TurnIntent;
  readonly plan?: {
    readonly active: true;
    readonly canonicalPath: string;
  };
  /**
   * Optional host-captured template snapshot for this model call. Extensions
   * use it only for their managed prompt keys; its absence preserves bundled
   * prompt behavior for hosts that have not opted into dynamic templates.
   */
  readonly promptRead?: PromptReadScope;
  // Per-profile config lives on `ExtensionAPI.params` (document §4.4 line 281 + §5 line 749),
  // not TurnAssemblyCtx, preserving the minimal read-only projection in §6.2.
}

export interface TurnAssemblyCtx extends ModelContextAssemblyCtx {
  readonly userInput: UserMessageContribution;
  /** Host-captured output requirements; no credentials or mutable Runtime configuration. */
  readonly outputContract?: {
    readonly schema?: Readonly<Record<string, unknown>>;
    readonly revisionInstruction?: string;
  };
}

// ─────────────────────────── Tool contribution ────────────────────────

/**
 * Per-turn dynamic tool factory used by `registerTool(fn)`. Return `null` to contribute no tool
 * this turn, or an array to contribute a whole domain catalog at once (e.g. local native + MCP
 * progressive disclosure).
 */
export type RuntimeToolFactory<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> = (
  ctx: ModelContextAssemblyCtx,
) => MaybePromise<RuntimeTool<S, TCtx> | readonly RuntimeTool<S, TCtx>[] | null>;

export type RuntimeToolContribution<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> = RuntimeTool<S, TCtx> | RuntimeToolFactory<S, TCtx>;

// ─────────────────────────── Prompt / reminder ────────────────────────

export type PromptContributor<TContext extends ModelContextAssemblyCtx = TurnAssemblyCtx> = (
  ctx: TContext,
) => MaybePromise<string | null | undefined>;

export type SystemPromptContributor = PromptContributor<ModelContextAssemblyCtx>;
export type UserPromptContributor = PromptContributor<TurnAssemblyCtx>;

export interface Reminder {
  /**
   * Exactly one non-empty rendered `<system-reminder>...</system-reminder>`
   * block. Raw, nested (including self-closing/attributed same-name tags),
   * prefixed, suffixed, or multiple blocks are malformed.
   * The host preserves provider order and must not add another wrapper.
   */
  readonly content: string;
  readonly priority?: number;
  readonly cooldownKey?: string;
}

export interface ReminderProvider {
  readonly name: string;
  compute(ctx: TurnAssemblyCtx): MaybePromise<Reminder | null | undefined>;
}

// ─────────────────────────── Hook / event names ───────────────────────

export const HOOK_NAMES = [
  'turn_start',
  'turn_end',
  'on_history_changed',
  'before_llm_call',
  'on_llm_call_prepared',
  'after_llm_call',
  'before_tool_call',
  'after_tool_call',
  'on_step_end',
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

// ─────────────────────────── Turn / step events ───────────────────────

export interface TurnStartEvent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  /**
   * pi runtime history for this turn — see `TurnHistoryProjection` for shape.
   */
  readonly history: TurnHistoryProjection;
  readonly userInput: UserMessageContribution;
}

export interface TurnEndEvent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  /** Terminal reason exposed by host; see `TurnResult` in pi-turn-runner. */
  readonly reason?: string;
}

// ─────────────────────────── Handler shapes ───────────────────────────

export type ExtensionHandler<E, R = void> = (event: E, ctx: TurnAssemblyCtx) => MaybePromise<R>;

export type TurnStartHandler = ExtensionHandler<TurnStartEvent, void>;
export type TurnEndHandler = ExtensionHandler<TurnEndEvent, void>;
export type HistoryChangedHandler = ExtensionHandler<PiHistoryChangedHookInput, void>;

/**
 * Step-level handlers reuse existing `agent-core` hook input types, keeping one contract instead of
 * redefining pi's per-step payloads in the SPI.
 */
export type BeforeLlmCallHandler = ExtensionHandler<
  PiBeforeLlmCallHookInput,
  PiBeforeLlmCallHookDecision | void | undefined
>;
/** Observation only. Core isolates failures and invokes this once per logical agent call. */
export type LlmCallPreparedHandler = ExtensionHandler<PiLlmCallPreparedHookInput, void>;
export type AfterLlmCallHandler = ExtensionHandler<
  PiAfterLlmCallHookInput,
  PiAfterLlmCallHookDecision | void | undefined
>;
/**
 * Tool hook handlers receive the immutable per-turn assembly context as a
 * third argument. The registry closes it over when adapting back to Pi's
 * two-argument hook contract, so existing two-argument handlers remain
 * source-compatible while extensions that persist artifacts can identify the
 * owning session/turn without reaching into Pi internals.
 */
export type BeforeToolCallHandler = (
  input: Parameters<PiBeforeToolCallHook>[0],
  signal: Parameters<PiBeforeToolCallHook>[1],
  ctx: TurnAssemblyCtx,
) => ReturnType<PiBeforeToolCallHook>;
export type AfterToolCallHandler = (
  input: Parameters<PiAfterToolCallHook>[0],
  signal: Parameters<PiAfterToolCallHook>[1],
  ctx: TurnAssemblyCtx,
) => ReturnType<PiAfterToolCallHook>;
export type StepEndHandler = ExtensionHandler<PiStepEndHookInput, void>;

/**
 * Event name → handler type map. Consumed by `Registry` to type its internal
 * `Record<HookName, Array<HandlerFor<K>>>` storage so read-side casts to
 * per-event handler arrays remain type-safe end-to-end. Extending
 * `HOOK_NAMES` requires adding the matching entry here — TS enforces
 * exhaustiveness via `HookHandlerMap[HookName]`.
 */
export interface HookHandlerMap {
  turn_start: TurnStartHandler;
  turn_end: TurnEndHandler;
  on_history_changed: HistoryChangedHandler;
  before_llm_call: BeforeLlmCallHandler;
  on_llm_call_prepared: LlmCallPreparedHandler;
  after_llm_call: AfterLlmCallHandler;
  before_tool_call: BeforeToolCallHandler;
  after_tool_call: AfterToolCallHandler;
  on_step_end: StepEndHandler;
}

export type HandlerFor<K extends HookName> = HookHandlerMap[K];

// ─────────────────────────── ExtensionAPI ─────────────────────────────

export interface ExtensionAPI {
  /**
   * Per-profile params merged from `ProfileOverlay.param` (document §4.4 line 281 / §5 line 749:
   * per-profile config read during extension init). Extensions read them in `init`, for example to
   * select behavior or consume host flags. An empty object means the profile has no overlay or no
   * param definition.
   */
  readonly params: Readonly<Record<string, unknown>>;

  registerTool<
    S extends TSchema = TSchema,
    TCtx extends ToolExecutionContext = ToolExecutionContext,
  >(
    contribution: RuntimeToolContribution<S, TCtx>,
  ): void;

  contributeSystemPrompt(fn: SystemPromptContributor): void;
  contributeUserPromptPrefix(fn: UserPromptContributor): void;
  registerReminderProvider(provider: ReminderProvider): void;

  // Turn level
  on(event: 'turn_start', handler: TurnStartHandler): void;
  on(event: 'turn_end', handler: TurnEndHandler): void;
  on(event: 'on_history_changed', handler: HistoryChangedHandler): void;

  // Step level
  on(event: 'before_llm_call', handler: BeforeLlmCallHandler): void;
  on(event: 'on_llm_call_prepared', handler: LlmCallPreparedHandler): void;
  on(event: 'after_llm_call', handler: AfterLlmCallHandler): void;
  on(event: 'before_tool_call', handler: BeforeToolCallHandler): void;
  on(event: 'after_tool_call', handler: AfterToolCallHandler): void;
  on(event: 'on_step_end', handler: StepEndHandler): void;

  /**
   * Generic fallback overload—consumed by `wireHandlers` and any table-driven
   * caller that iterates `HOOK_NAMES`. Individual per-event overloads above
   * still apply for call sites that pass a literal event name (better error
   * messages). Type-safety is preserved by `HandlerFor<K>` throughout the
   * pipeline.
   */
  on<K extends HookName>(event: K, handler: HandlerFor<K>): void;
}

// ─────────────────────────── Extension shape ──────────────────────────

export interface AgentExtension {
  /** Open string identifier: extension sets are host/plugin-defined, not a closed enum. */
  readonly id: string;
  /** Control-plane label returned by `listExtensions`; never affects execution semantics. */
  readonly description?: string;
  init(pi: ExtensionAPI): MaybePromise<void>;
}

// ─────────────────────────── Assembly result ──────────────────────────

export interface ReminderEmission {
  readonly providerName: string;
  readonly reminder: Reminder;
}

export interface AssemblyDiagnostic {
  readonly loadedExtensions: readonly string[];
  readonly enabledExtensions: readonly string[];
  readonly disabledExtensions: readonly string[];
  readonly toolCount: number;
  readonly reminderCount: number;
}

/**
 * `PiTurnHooks` covers agent-core's existing step-level contract; the host explicitly consumes turn
 * lifecycle handlers as raw arrays. This lets agent-runtime land without modifying
 * `@mavis/agent-core` (see document §11.6 migration strategy).
 */
export interface AssemblyResult<TCtx extends ToolExecutionContext = ToolExecutionContext> {
  readonly systemPromptPrefix: string;
  readonly userPromptPrefix: string;
  readonly tools: readonly RuntimeTool<TSchema, TCtx>[];
  readonly hooks: PiTurnHooks;
  readonly reminders: readonly ReminderEmission[];
  readonly turnStartHandlers: readonly TurnStartHandler[];
  readonly turnEndHandlers: readonly TurnEndHandler[];
  readonly diagnostic: AssemblyDiagnostic;
}

export interface ModelContextAssemblyResult<
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> {
  readonly systemPromptPrefix: string;
  readonly tools: readonly RuntimeTool<TSchema, TCtx>[];
}

export interface ModelContextAssemblySeed {
  readonly tools: readonly RuntimeTool[];
}

export interface TurnAssemblySeed extends ModelContextAssemblySeed {
  readonly userPromptPrefix: string;
}

// ─────────────────────────── Registry state view ──────────────────────

export interface ExtensionContributionStats {
  readonly tools: number;
  readonly promptContributors: number;
  readonly reminderProviders: number;
  readonly hooks: Readonly<Record<HookName, number>>;
}

export interface ExtensionState {
  readonly id: string;
  /** Human-readable control-plane metadata copied from `AgentExtension.description`. */
  readonly description?: string;
  readonly enabled: boolean;
  readonly contributions: ExtensionContributionStats;
}

export interface EnabledScope {
  readonly sessionId?: string;
}

// ─────────────────────────── Runtime API ──────────────────────────────

export interface AgentRuntime {
  assembleModelContext(
    ctx: ModelContextAssemblyCtx,
    seed?: ModelContextAssemblySeed,
  ): Promise<ModelContextAssemblyResult>;
  assembleTurn(ctx: TurnAssemblyCtx, seed?: TurnAssemblySeed): Promise<AssemblyResult>;
  setEnabled(extensionId: string, enabled: boolean, scope?: EnabledScope): void;
  listExtensions(scope?: EnabledScope): ExtensionState[];
  disposeSession(sessionId: string): void;
}

// ─────────────────────────── Runtime options ──────────────────────────

export interface ProfileOverlay {
  readonly enable?: readonly string[];
  readonly disable?: readonly string[];
  readonly replace?: Readonly<Record<string, string>>;
  readonly param?: Readonly<Record<string, unknown>>;
}

export interface RuntimeOptions {
  readonly base: readonly AgentExtension[];
  readonly additions?: readonly AgentExtension[];
  readonly overlays?: Readonly<Record<string, ProfileOverlay>>;
  readonly profile?: string;
}

// ─────────────────────────── Re-exports ───────────────────────────────

export type {
  PiAfterLlmCallHook,
  PiAfterLlmCallHookDecision,
  PiAfterLlmCallHookInput,
  PiAfterToolCallHook,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
  PiBeforeToolCallHook,
  PiHistoryChangedHookInput,
  PiOnHistoryChangedHook,
  PiOnStepEndHook,
  PiStepEndHookInput,
  PiTurnHooks,
};
