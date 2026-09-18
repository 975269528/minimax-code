/**
 * Core tool contracts.
 *
 * `ToolDefinition`: The public tool contract. Its typebox schema (`TSchema`) is forwarded by
 * PiTurnRunner to pi as `AgentTool.parameters` and used with `Static<S>` to infer strongly typed
 * `ToolImpl.execute(input)` arguments. `prepareArguments` / `executionMode` map directly to the
 * corresponding Pi 0.79.1 `AgentTool` fields.
 *
 * `ToolExecutionContext`: Minimal context built by the host each turn and captured by the pi
 * `AgentTool` wrapper. Hosts can extend it (cloud-runtime's `CloudRuntimeContext` adds reporter /
 * bizId / workspaceRoot, etc.) and declare their TCtx in `ToolImpl<S, TCtx>`. **Never** inject
 * per-turn tool state through `AsyncLocalStorage`; the wrapper closure is the only injection point.
 *
 * `ToolImpl<S, TCtx>`: Tool implementation. The first argument to `execute(ctx, input, signal?,
 * onUpdate?)` is per-turn context, captured by the host in `assembleAgentTools`. One ToolDefinition
 * may have multiple ToolImpl implementations (cloud / local / mock), all sharing the same execute
 * signature.
 *
 * `RuntimeTool<S, TCtx>` — the `(def, impl)` pair consumed by PiTurnRunner. New platform-owned
 * tools should prefer declaring this object directly with `defineRuntimeTool(...)`, keeping the
 * LLM-facing definition and runtime implementation co-located.
 *
 * `bindTool(def)` / `toRuntimeTool(instance)` remain available for decorated class implementations,
 * but new code should prefer `defineRuntimeTool(...)`.
 */

import type { AgentToolUpdateCallback, ToolExecutionMode } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { Static, TSchema } from '@sinclair/typebox';
import type { IPluginCapabilityProvenance } from '@mavis/protocol';

export type RuntimeToolSource = 'builtin' | 'builtin-matrix' | 'configured';

export interface ToolCallProvenanceResolutionInput {
  readonly phase: 'start' | 'end';
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  readonly isError?: boolean;
}

export type ToolCallProvenanceResolver = (
  input: ToolCallProvenanceResolutionInput,
) => readonly IPluginCapabilityProvenance[] | undefined;

export interface VideoContent {
  type: 'video';
  data: string;
  mimeType: string;
}

export type ToolResultContent = TextContent | ImageContent | VideoContent;

/**
 * Source-owned, bounded operation classification for observability.
 *
 * The tool owns its operation vocabulary; PiTurnRunner accepts a classifier
 * result only when it belongs to this fixed allowlist. Unknown, malformed, or
 * throwing classifications collapse to the shared `unknown` metric value.
 */
export interface ToolOperationClassifier {
  readonly allowedValues: readonly string[];
  classify(args: unknown): string | undefined;
}

export interface ToolDefinition<S extends TSchema = TSchema> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly schema: S;
  readonly promptGuidelines?: readonly string[];
  readonly prepareArguments?: (args: unknown) => Static<S>;
  readonly executionMode?: ToolExecutionMode;
  readonly operationClassifier?: ToolOperationClassifier;
}

/**
 * Tool result. `content` stays compatible with pi `AgentToolResult` (a single text segment is
 * sufficient); `details` holds structured byproducts (read by the UI / caller, not the LLM);
 * `terminate` maps to Pi `AgentToolResult.terminate`; `output` is a legacy field retained only for
 * migration compatibility. New code should use `details`.
 */
export interface ToolResult {
  tool_name: string;
  text: string;
  content: ToolResultContent[];
  isError?: boolean;
  details?: Record<string, unknown>;
  output?: Record<string, unknown>;
  terminate?: boolean;
}

/**
 * Per-turn execution context, captured by the host in each `AgentTool.execute` wrapper in
 * `assembleAgentTools`. The minimal fields are sessionId / turnId. Hosts may extend it
 * (cloud-runtime's `CloudRuntimeContext` adds `bizId` / `reporter` / `workspaceRoot`, etc.) and
 * declare the corresponding TCtx in their `ToolImpl<S, TCtx>`.
 */
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  /** Per-call id supplied by the provider loop; absent in older/direct test paths. */
  readonly toolCallId?: string;
  /** Assistant message carrying this tool call; supplied by the runtime bridge when available. */
  readonly assistantMessageId?: string;
}

/**
 * Tool implementation.
 *
 * `ctx` is host-built per-turn context injected via a closure in `assembleAgentTools`, not
 * `AsyncLocalStorage`. `input` fields are strongly typed from ToolDefinition.schema using
 * `Static<typeof schema>`.
 *
 * `signal` is an optional turn-level abort channel passed by pi `AgentTool.execute` and triggered
 * when SessionController aborts. Potentially blocking implementations (HTTP, long-running sandbox
 * shell, external resource IO) should forward it to fetch or check `signal.aborted` at key points,
 * allowing SessionController to interrupt inflight operations instead of waiting for natural
 * timeouts.
 *
 * `onUpdate` is Pi's partial tool result callback for streaming long-task progress. Implementations
 * may ignore it; when used, partial results must share the semantics of the final
 * `ToolResult.content/details`.
 */
export interface ToolImpl<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> {
  execute(
    ctx: TCtx,
    input: Static<S>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<Record<string, unknown>>,
  ): Promise<ToolResult>;
}

/**
 * `(def, impl)` pair. PiTurnRunner only depends on this protocol shape; it
 * does not care whether a tool comes from cloud, desktop, mobile, or a test
 * host.
 */
export interface RuntimeTool<
  S extends TSchema = TSchema,
  TCtx extends ToolExecutionContext = ToolExecutionContext,
> {
  readonly def: ToolDefinition<S>;
  readonly impl: ToolImpl<S, TCtx>;
  readonly source?: RuntimeToolSource;
  /** Turn-local display attribution; never affects execution or permission semantics. */
  readonly toolCallProvenanceResolver?: ToolCallProvenanceResolver;
}

export type { ToolExecutionMode };
