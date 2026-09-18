import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';

import { mutateDurableYaml, readYamlDocument } from './durable-yaml.js';
import type { ChannelPlatform } from './route-api.js';
import {
  invalidImStorage,
  nextBindingUpdatedAt,
  readBindingData,
  requireBindingSessionState,
  writeBindingData,
} from './im-connection-store-data.js';
import {
  LocalImConnectionError,
  type LocalImConnection,
  type LocalImConnectionStoreOptions,
  type LocalImPhysicalBinding,
} from './im-connection-types.js';
import { imLogger as logger } from '../common/im-logger.js';

export interface LocalImBindingOperations {
  readonly bindingsPath: string;
  readonly bindingSessionLane: KeyedOperationLane<string>;
  readonly options: Pick<
    LocalImConnectionStoreOptions,
    'nowMs' | 'resolveProjectWorkspace' | 'createSession'
  >;
}

/** Internal-only IM observability facts; no transport identity or message content. */
export interface LocalImBindingAdvanceTelemetry {
  readonly requestKey: string;
  readonly platform: ChannelPlatform;
  readonly bindingId: string;
}

/** Advances one physical Binding; shared legacy cursors are never advanced together. */
export async function advanceImBinding(
  operations: LocalImBindingOperations,
  connection: LocalImConnection,
  bindingId: string,
  requestId: string,
  telemetry?: LocalImBindingAdvanceTelemetry,
): Promise<LocalImPhysicalBinding> {
  return operations.bindingSessionLane.run(bindingId, async () => {
    const existing = await readBindingForConnection(operations, connection, bindingId);
    const prior = requireBindingSessionState(existing).mutationReceipts[requestId];
    if (prior) {
      logAdvanceLifecycle(telemetry, connection, bindingId, 'new_cursor_update', 'replayed', prior);
      return { ...existing, currentSessionId: prior };
    }

    const session = await createBindingSession(
      operations,
      connection,
      existing,
      telemetry,
      'new_session_create',
    );
    logAdvanceLifecycle(
      telemetry,
      connection,
      bindingId,
      'new_cursor_update',
      'started',
      session.sessionId,
    );
    let advanced: LocalImPhysicalBinding;
    try {
      advanced = await mutateDurableYaml(operations.bindingsPath, (document) => {
        const data = readBindingData(document, operations.options.nowMs());
        const current = data.physicalBindings.get(bindingId);
        if (!current) throw bindingNotFound(bindingId);
        const currentState = assertBindingForConnection(current, connection);
        const replay = currentState.mutationReceipts[requestId];
        if (replay) return { changed: false, value: { ...current, currentSessionId: replay } };
        const next: LocalImPhysicalBinding = {
          ...current,
          currentSessionId: session.sessionId,
          updatedAt: nextBindingUpdatedAt(current, operations.options.nowMs()),
          mutationReceipts: appendReceipt(
            currentState.mutationReceipts,
            requestId,
            session.sessionId,
          ),
        };
        data.physicalBindings.set(next.bindingId, next);
        writeBindingData(document, data);
        return { changed: true, value: next };
      });
    } catch (error) {
      logAdvanceLifecycle(
        telemetry,
        connection,
        bindingId,
        'new_cursor_update',
        'failed',
        session.sessionId,
        imAdvanceFailureCode(error, 'CHANNEL_IM_NEW_CURSOR_UPDATE_FAILED'),
      );
      throw error;
    }
    logAdvanceLifecycle(
      telemetry,
      connection,
      bindingId,
      'new_cursor_update',
      advanced.currentSessionId === session.sessionId ? 'updated' : 'replayed',
      advanced.currentSessionId,
    );
    return advanced;
  });
}

/** Creates the first Session only for an empty physical Binding cursor. */
export async function ensureImBindingSession(
  operations: LocalImBindingOperations,
  connection: LocalImConnection,
  bindingId: string,
): Promise<LocalImPhysicalBinding> {
  return operations.bindingSessionLane.run(bindingId, async () => {
    const existing = await readBindingForConnection(operations, connection, bindingId);
    if (requireBindingSessionState(existing).currentSessionId) return existing;

    const session = await createBindingSession(operations, connection, existing);
    return mutateDurableYaml(operations.bindingsPath, (document) => {
      const data = readBindingData(document, operations.options.nowMs());
      const current = data.physicalBindings.get(bindingId);
      if (!current) throw bindingNotFound(bindingId);
      const currentState = assertBindingForConnection(current, connection);
      if (currentState.currentSessionId) return { changed: false, value: current };
      const next: LocalImPhysicalBinding = {
        ...current,
        currentSessionId: session.sessionId,
        updatedAt: nextBindingUpdatedAt(current, operations.options.nowMs()),
      };
      data.physicalBindings.set(next.bindingId, next);
      writeBindingData(document, data);
      return { changed: true, value: next };
    });
  });
}

async function readBindingForConnection(
  operations: LocalImBindingOperations,
  connection: LocalImConnection,
  bindingId: string,
): Promise<LocalImPhysicalBinding> {
  const data = readBindingData(
    await readYamlDocument(operations.bindingsPath),
    operations.options.nowMs(),
  );
  const binding = data.physicalBindings.get(bindingId);
  if (!binding) throw bindingNotFound(bindingId);
  assertBindingForConnection(binding, connection);
  return binding;
}

function assertBindingForConnection(
  binding: LocalImPhysicalBinding,
  connection: LocalImConnection,
): ReturnType<typeof requireBindingSessionState> {
  if (binding.connectionId !== connection.connectionId || binding.channel !== connection.channel) {
    throw invalidImStorage('physicalBindings', binding.bindingId);
  }
  const state = requireBindingSessionState(binding);
  if (state.resolvedProjectKey !== connection.resolvedProjectKey) {
    throw new LocalImConnectionError(
      409,
      'CHANNEL_IM_BINDING_PROJECT_MISMATCH',
      'The IM Binding Project does not match its Connection.',
    );
  }
  return state;
}

async function createBindingSession(
  operations: LocalImBindingOperations,
  connection: LocalImConnection,
  binding: LocalImPhysicalBinding,
  telemetry?: LocalImBindingAdvanceTelemetry,
  stage: 'new_session_create' = 'new_session_create',
): Promise<{ sessionId: string }> {
  const state = assertBindingForConnection(binding, connection);
  const workspace = operations.options.resolveProjectWorkspace(state.resolvedProjectKey);
  logAdvanceLifecycle(telemetry, connection, binding.bindingId, stage, 'started');
  try {
    const session = await operations.options.createSession({
      agentName: connection.agentName,
      workspaceDir: workspace.workspaceDir,
      isDefaultWorkspace: workspace.isDefaultWorkspace,
      sessionType: 'branch',
      sessionKind: 'channel',
      parentSessionId: null,
      visibility: 'visible',
      purpose: `im_binding:${binding.bindingId}`,
    });
    logAdvanceLifecycle(
      telemetry,
      connection,
      binding.bindingId,
      stage,
      'created',
      session.sessionId,
    );
    return session;
  } catch (error) {
    logAdvanceLifecycle(
      telemetry,
      connection,
      binding.bindingId,
      stage,
      'failed',
      undefined,
      imAdvanceFailureCode(error, 'CHANNEL_IM_NEW_SESSION_CREATE_FAILED'),
    );
    throw error;
  }
}

function bindingNotFound(bindingId: string): LocalImConnectionError {
  return new LocalImConnectionError(
    409,
    'IM_BINDING_NOT_FOUND',
    `IM Binding not found: ${bindingId}`,
  );
}

function logAdvanceLifecycle(
  telemetry: LocalImBindingAdvanceTelemetry | undefined,
  connection: LocalImConnection,
  bindingId: string,
  stage: 'new_session_create' | 'new_cursor_update',
  outcome: 'started' | 'created' | 'updated' | 'replayed' | 'failed',
  sessionId?: string,
  code = 'IM_BINDING_ADVANCE',
): void {
  if (!telemetry) return;
  const fields = {
    requestKey: telemetry.requestKey,
    platform: telemetry.platform,
    connectionId: connection.connectionId,
    bindingId,
    ...(sessionId ? { sessionId } : {}),
    stage,
    code,
    outcome,
    ...(outcome === 'failed' ? { failureKind: stage } : {}),
  };
  if (outcome === 'failed') {
    logger.warn(fields, 'IM Binding /new lifecycle failed');
  } else {
    logger.info(fields, 'IM Binding /new lifecycle');
  }
}

function imAdvanceFailureCode(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null) return fallback;
  const code = (error as { code?: unknown }).code;
  // These codes are locally controlled persistence/Agent contracts. Do not
  // serialize an arbitrary thrown message or third-party transport error.
  return code === 'IM_BINDING_NOT_FOUND' || code === 'AGENT_NOT_FOUND' ? code : fallback;
}

function appendReceipt(
  receipts: Readonly<Record<string, string>>,
  requestId: string,
  sessionId: string,
): Record<string, string> {
  const next = { ...receipts, [requestId]: sessionId };
  const ids = Object.keys(next);
  if (ids.length <= 32) return next;
  for (const id of ids.slice(0, ids.length - 32)) delete next[id];
  return next;
}
