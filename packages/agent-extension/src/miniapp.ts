import {
  defineRuntimeTool,
  type AgentExtension,
  type ModelContextAssemblyCtx,
} from '@mavis/agent-runtime';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  projectMiniAppFailure,
  type MiniAppFailureDiagnostic,
  type MiniAppFailureReasonCode,
} from './miniapp-diagnostics.js';

export type {
  MiniAppFailureDiagnostic,
  MiniAppFailureReasonCode,
  MiniAppFailureRecovery,
  MiniAppFailureStage,
} from './miniapp-diagnostics.js';

const TARGET_ACTIONS = ['init', 'open', 'inspect', 'publish', 'restart', 'stop'] as const;
const MINIAPP_ACTIONS = ['list', ...TARGET_ACTIONS] as const;
const PluginId = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$',
  description: 'Required for every Mini App action except list.',
});
const SourcePath = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: '^[^\\u0000]*$',
  description:
    'Publish only: path to a finished Mini App package directory, absolute or relative to the current Session workspace. Omit to publish the workspace package.',
});
// Keep the provider-facing input as one concrete object. Exact action/input pairing
// remains a runtime concern below; exposing the action contracts as a root object
// union produces a top-level anyOf that some OpenAI-compatible providers reject.
const MiniAppProviderInputSchema = Type.Object(
  {
    action: Type.String({
      enum: [...MINIAPP_ACTIONS],
      pattern: `^(?:${MINIAPP_ACTIONS.join('|')})$`,
      description: 'Mini App lifecycle action.',
    }),
    pluginId: Type.Optional(PluginId),
    sourcePath: Type.Optional(SourcePath),
  },
  {
    additionalProperties: false,
    description:
      'pluginId is required for every Mini App action except list. sourcePath is accepted only for publish.',
  },
);

const MiniAppActionInputSchema = Type.Union([
  Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal('publish'),
      pluginId: PluginId,
      sourcePath: Type.Optional(SourcePath),
    },
    { additionalProperties: false },
  ),
  ...TARGET_ACTIONS.filter((action) => action !== 'publish').map((action) =>
    Type.Object(
      { action: Type.Literal(action), pluginId: PluginId },
      { additionalProperties: false },
    ),
  ),
]);

export interface MiniAppSummary {
  readonly pluginId: string;
  /** Installation source reported by the Host, not declared by the package. */
  readonly source: 'official' | 'local';
  readonly displayName?: string;
  readonly runtime: {
    readonly kind: 'process';
    readonly status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
    readonly errorCode?: string;
  };
}

export interface MiniAppListResult {
  readonly miniApps: readonly MiniAppSummary[];
}

export interface MiniAppInitResult {
  readonly pluginId: string;
  readonly mode: 'create' | 'update';
  readonly packagePath: `miniapps/${string}` | `liveboards/${string}`;
}

export interface MiniAppTargetResult {
  readonly miniApp: MiniAppSummary;
}

export type MiniAppRunningSummary = Omit<MiniAppSummary, 'runtime'> & {
  readonly runtime: {
    readonly kind: 'process';
    readonly status: 'running';
  };
};

export interface MiniAppOpenResult extends MiniAppTargetResult {
  readonly miniApp: MiniAppRunningSummary;
  readonly opened: true;
}

export interface MiniAppActionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

export interface MiniAppTargetActionContext extends MiniAppActionContext {
  readonly pluginId: string;
}

export interface MiniAppPublishActionContext extends MiniAppTargetActionContext {
  readonly sourcePath?: string;
}

/** Consumer-owned seam implemented only by a Host that owns a real Mini App lifecycle. */
export interface MiniAppLifecycle {
  /** Returns accepted, enabled Mini Apps with their current runtime state. */
  list(input: MiniAppActionContext): Promise<MiniAppListResult>;
  /** Scaffolds or binds the deterministic package root in the current Session workspace for authoring. */
  init(input: MiniAppTargetActionContext): Promise<MiniAppInitResult>;
  open(input: MiniAppTargetActionContext): Promise<MiniAppOpenResult>;
  /** Returns the installed Mini App and runtime lifecycle summary, without reading its surface. */
  inspect(input: MiniAppTargetActionContext): Promise<MiniAppTargetResult>;
  /** Accepts the specified finished package directory or current Session workspace package and starts its runtime. */
  publish(input: MiniAppPublishActionContext): Promise<MiniAppTargetResult>;
  /** Restarts an already installed Mini App runtime without adopting workspace changes. */
  restart(input: MiniAppTargetActionContext): Promise<MiniAppTargetResult>;
  /** Stops an installed Mini App runtime without deleting its package. */
  stop(input: MiniAppTargetActionContext): Promise<MiniAppTargetResult>;
}

export type MiniAppLifecycleErrorCode =
  | 'NOT_FOUND'
  | 'NOT_ENABLED'
  | 'PLUGIN_ALREADY_EXISTS'
  | 'BUSY'
  | 'SERVICE_RESTARTED'
  | 'PREPARATION_FAILED'
  | 'RUNTIME_FAILED'
  | 'OPEN_UNAVAILABLE'
  | 'OPEN_FAILED'
  | 'INTERNAL_ERROR'
  | 'CANCELLED';

export type MiniAppBusyReason = 'operation_busy' | 'capacity_busy';

export interface MiniAppRuntimeErrorDetail {
  readonly errorText: string;
  readonly stderr?: string;
}

type MiniAppLifecycleErrorInput = {
  readonly message: string;
  readonly retryable: boolean;
  readonly diagnosticReason?: MiniAppFailureReasonCode;
  readonly runtimeError?: MiniAppRuntimeErrorDetail;
} & (
  | { readonly code: 'BUSY'; readonly busyReason: MiniAppBusyReason }
  | {
      readonly code: 'INTERNAL_ERROR';
      readonly busyReason?: never;
      readonly diagnosticId: string;
      readonly lastGoodAvailable?: boolean;
    }
  | {
      readonly code: Exclude<MiniAppLifecycleErrorCode, 'BUSY' | 'INTERNAL_ERROR'>;
      readonly busyReason?: never;
      readonly diagnosticId?: never;
      readonly lastGoodAvailable?: never;
    }
);

export class MiniAppLifecycleError extends Error {
  override readonly name = 'MiniAppLifecycleError';
  readonly code: MiniAppLifecycleErrorCode;
  readonly retryable: boolean;
  readonly busyReason?: MiniAppBusyReason;
  readonly diagnosticReason?: MiniAppFailureReasonCode;
  readonly runtimeError?: MiniAppRuntimeErrorDetail;
  readonly diagnosticId?: string;
  readonly lastGoodAvailable?: boolean;

  constructor(input: MiniAppLifecycleErrorInput) {
    super(input.message);
    this.code = input.code;
    const projection = projectMiniAppFailure(input.code, input.diagnosticReason);
    this.retryable =
      input.busyReason === 'capacity_busy' ? false : (projection?.retryable ?? input.retryable);
    if (input.code === 'BUSY') this.busyReason = input.busyReason;
    if (input.code === 'INTERNAL_ERROR') {
      this.diagnosticId = input.diagnosticId;
      if (input.lastGoodAvailable !== undefined) {
        this.lastGoodAvailable = input.lastGoodAvailable;
      }
    }
    if (projection) this.diagnosticReason = projection.diagnostic.reasonCode;
    if (input.runtimeError) this.runtimeError = input.runtimeError;
  }
}

type MiniAppInput = Static<typeof MiniAppActionInputSchema>;
type MiniAppAction = MiniAppInput['action'];
type MiniAppReportedAction = MiniAppAction | 'unknown';

/** Creates the host extension only when a real Mini App lifecycle adapter is available. */
export function createMiniAppControlExtension(lifecycle: MiniAppLifecycle): AgentExtension {
  const tool = createMiniAppTool(lifecycle);
  return {
    id: 'miniapp-control',
    description: 'Host-owned Mini App bootstrap and runtime lifecycle control.',
    init(api) {
      api.registerTool((context) => (isMiniAppTurn(context) ? tool : null));
    },
  };
}

function createMiniAppTool(lifecycle: MiniAppLifecycle) {
  return defineRuntimeTool({
    name: 'miniapp',
    description:
      "Initialize, list, open, inspect, publish, restart, or stop a Mini App. Init scaffolds or binds the package root in the current Session workspace for authoring without publishing it. Inspect returns the installed Mini App's source (official or local) and runtime state. Before editing an installed Mini App, inspect its source; official Plugin implementations do not support local editing or republishing. Use miniapp-creator for authoring and recovery guidance. Publish starts or replaces the runtime. Init is not required for a complete package directory. Restart restarts an installed runtime. Stop releases an installed runtime without deleting its Mini App package; use the Mini App Plugin's own Skills, MCP servers, and Connectors for business operations.",
    schema: MiniAppProviderInputSchema,
    source: 'builtin',
    operationClassifier: {
      allowedValues: MINIAPP_ACTIONS,
      classify: (input) => readRecord(input).action as string | undefined,
    },
    execute: async (context, rawInput, signal) => {
      const action = readMiniAppAction(rawInput);
      if (signal?.aborted) return errorResult(action, cancelledError());
      if (!Value.Check(MiniAppActionInputSchema, rawInput)) {
        return errorResult(action, invalidArgumentsError(action, rawInput));
      }
      const input = rawInput as MiniAppInput;
      try {
        const result = await dispatch(lifecycle, input, {
          sessionId: context.sessionId,
          turnId: context.turnId,
          ...(signal ? { signal } : {}),
        });
        return successResult(input.action, result);
      } catch (error) {
        return errorResult(input.action, normalizeError(error, signal));
      }
    },
  });
}

async function dispatch(
  lifecycle: MiniAppLifecycle,
  input: MiniAppInput,
  context: MiniAppActionContext,
): Promise<MiniAppListResult | MiniAppInitResult | MiniAppOpenResult | MiniAppTargetResult> {
  if (input.action === 'list') return lifecycle.list(context);
  const target = { ...context, pluginId: input.pluginId };
  switch (input.action) {
    case 'init':
      return lifecycle.init(target);
    case 'open':
      return lifecycle.open(target);
    case 'inspect':
      return lifecycle.inspect(target);
    case 'publish':
      return lifecycle.publish({
        ...target,
        ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
      });
    case 'restart':
      return lifecycle.restart(target);
    case 'stop':
      return lifecycle.stop(target);
  }
}

function successResult(
  action: MiniAppAction,
  result: MiniAppListResult | MiniAppInitResult | MiniAppOpenResult | MiniAppTargetResult,
) {
  const response = { ok: true as const, action, result };
  const text = JSON.stringify(response);
  return {
    tool_name: 'miniapp',
    text,
    content: [{ type: 'text' as const, text }],
    details: response,
  };
}

interface StableToolError {
  readonly code: MiniAppLifecycleErrorCode | 'INVALID_ARGUMENTS';
  readonly message: string;
  readonly retryable: boolean;
  readonly busyReason?: MiniAppBusyReason;
  readonly diagnostic?: MiniAppFailureDiagnostic;
  readonly runtimeError?: MiniAppRuntimeErrorDetail;
  readonly diagnosticId?: string;
  readonly lastGoodAvailable?: boolean;
}

function errorResult(action: MiniAppReportedAction, error: StableToolError) {
  const response = { ok: false as const, action, error };
  const text = JSON.stringify(response);
  return {
    tool_name: 'miniapp',
    text,
    content: [{ type: 'text' as const, text }],
    details: response,
    isError: true as const,
  };
}

function normalizeError(error: unknown, signal: AbortSignal | undefined): StableToolError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return cancelledError();
  }
  if (isKnownLifecycleError(error)) {
    const projection = projectMiniAppFailure(error.code, error.diagnosticReason);
    const runtimeError = error instanceof MiniAppLifecycleError ? error.runtimeError : undefined;
    if (projection) {
      return {
        code: error.code,
        ...projection,
        ...(runtimeError ? { runtimeError } : {}),
      };
    }
    if (error.code === 'INTERNAL_ERROR') {
      return {
        code: error.code,
        message: MINIAPP_RECORDED_INTERNAL_ERROR_MESSAGE,
        retryable: false,
        diagnosticId: error.diagnosticId,
        ...(error.lastGoodAvailable !== undefined
          ? { lastGoodAvailable: error.lastGoodAvailable }
          : {}),
      };
    }
    return {
      code: error.code,
      message: MINIAPP_PUBLIC_ERROR_MESSAGES[error.code],
      retryable:
        error.busyReason === 'capacity_busy'
          ? false
          : stableRetryability(error.code, error.retryable),
      ...(error.busyReason ? { busyReason: error.busyReason } : {}),
      ...(runtimeError ? { runtimeError } : {}),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: MINIAPP_PUBLIC_ERROR_MESSAGES.INTERNAL_ERROR,
    retryable: false,
  };
}

const MINIAPP_PUBLIC_ERROR_MESSAGES: Readonly<Record<MiniAppLifecycleErrorCode, string>> = {
  NOT_FOUND: 'Mini App was not found.',
  NOT_ENABLED: 'Mini App is not enabled.',
  PLUGIN_ALREADY_EXISTS: 'Mini App Plugin is already installed.',
  BUSY: 'Mini App is busy.',
  SERVICE_RESTARTED: 'Mini App service restarted.',
  PREPARATION_FAILED: 'Mini App preparation failed.',
  RUNTIME_FAILED: 'Mini App runtime failed.',
  OPEN_UNAVAILABLE: 'Mini App open is unavailable.',
  OPEN_FAILED: 'Mini App could not be opened.',
  INTERNAL_ERROR: 'The Mini App host could not complete the action.',
  CANCELLED: 'The Mini App action was cancelled.',
};

const MINIAPP_RECORDED_INTERNAL_ERROR_MESSAGE =
  'The Mini App Host could not complete this action. A diagnostic ID was created automatically.';

function stableRetryability(code: MiniAppLifecycleErrorCode, fallback: boolean): boolean {
  if (code === 'BUSY' || code === 'SERVICE_RESTARTED') return true;
  if (code === 'PLUGIN_ALREADY_EXISTS' || code === 'PREPARATION_FAILED') return false;
  return fallback;
}

function cancelledError(): StableToolError {
  return {
    code: 'CANCELLED',
    message: 'The Mini App action was cancelled.',
    retryable: false,
  };
}

function invalidArgumentsError(action: MiniAppReportedAction, input: unknown): StableToolError {
  const record = readRecord(input);
  let message = 'Mini App arguments are invalid for the selected action.';
  if (action === 'list' && Object.prototype.hasOwnProperty.call(record, 'pluginId')) {
    message = 'pluginId must be omitted for the list action.';
  } else if (
    action !== 'unknown' &&
    action !== 'publish' &&
    Object.prototype.hasOwnProperty.call(record, 'sourcePath')
  ) {
    message = 'sourcePath is only accepted for the publish action.';
  } else if (
    action !== 'unknown' &&
    action !== 'list' &&
    !Object.prototype.hasOwnProperty.call(record, 'pluginId')
  ) {
    message = 'pluginId is required for this Mini App action.';
  }
  return {
    code: 'INVALID_ARGUMENTS',
    message,
    retryable: false,
  };
}

function readMiniAppAction(input: unknown): MiniAppReportedAction {
  const action = readRecord(input).action;
  return typeof action === 'string' && (MINIAPP_ACTIONS as readonly string[]).includes(action)
    ? (action as MiniAppAction)
    : 'unknown';
}

function isMiniAppTurn(context: ModelContextAssemblyCtx): boolean {
  const config = readRecord(context.agentConfig);
  const profile = readRecord(config.agent_profile);
  return profile.surface === 'interactive';
}

function isKnownLifecycleError(error: unknown): error is {
  readonly code: MiniAppLifecycleErrorCode;
  readonly retryable: boolean;
  readonly busyReason?: MiniAppBusyReason;
  readonly diagnosticReason?: unknown;
  readonly diagnosticId?: string;
  readonly lastGoodAvailable?: boolean;
} {
  if (!(error instanceof Error) || error.name !== 'MiniAppLifecycleError') return false;
  const candidate = error as Error & {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly busyReason?: unknown;
    readonly diagnosticReason?: unknown;
    readonly diagnosticId?: unknown;
    readonly lastGoodAvailable?: unknown;
  };
  return (
    typeof candidate.code === 'string' &&
    candidate.code in MINIAPP_PUBLIC_ERROR_MESSAGES &&
    typeof candidate.retryable === 'boolean' &&
    validBusyReason(candidate.code, candidate.busyReason) &&
    validInternalDiagnostic(candidate.code, candidate.diagnosticId, candidate.lastGoodAvailable)
  );
}

function validBusyReason(code: string, value: unknown): value is MiniAppBusyReason | undefined {
  if (code === 'BUSY') return value === 'operation_busy' || value === 'capacity_busy';
  return value === undefined;
}

function validInternalDiagnostic(
  code: string,
  diagnosticId: unknown,
  lastGoodAvailable: unknown,
): boolean {
  if (code === 'INTERNAL_ERROR') {
    return (
      typeof diagnosticId === 'string' &&
      diagnosticId.length > 0 &&
      (lastGoodAvailable === undefined || typeof lastGoodAvailable === 'boolean')
    );
  }
  return diagnosticId === undefined && lastGoodAvailable === undefined;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
