import {
  AgentServiceError,
  type LocalAgentService,
  type PrimaryExecutionIdentity,
} from '../../service/agent/index.js';
import type { PluginServiceLogger } from '../../service/plugin-system/index.js';
import {
  isCurrentSessionAgentDefinition,
  type SessionAgentDefinition,
} from '../../service/session-system/index.js';
import type {
  AgentExecutionSnapshot,
  AgentExecutionSource,
} from '../../service/turn-system/index.js';

type ExecutionSnapshotContext = Parameters<AgentExecutionSource['getExecutionSnapshot']>[1];

export function createV2AgentExecutionSource(
  agentService: LocalAgentService,
  logger: PluginServiceLogger,
  sessionDefinitions?: {
    ensureSessionAgentDefinition(sessionId: string): Promise<SessionAgentDefinition | undefined>;
  },
): AgentExecutionSource {
  return {
    getExecutionSnapshot: async (exactOwnerName, context) => {
      if (context?.sessionId && context.sessionKind === 'task') {
        if (!sessionDefinitions) throw new Error('Session Agent definition reader is unavailable.');
        const binding = await sessionDefinitions.ensureSessionAgentDefinition(context.sessionId);
        if (
          !binding ||
          binding.sessionId !== context.sessionId ||
          !isCurrentSessionAgentDefinition(binding.definition)
        ) {
          throw new Error(`Session Agent definition is invalid: ${context.sessionId}`);
        }
        const definition = binding.definition;
        return {
          agentName: exactOwnerName,
          executionOwnerName: definition.exactOwnerName,
          resourceAgentName: definition.exactOwnerName,
          displayName: definition.exactOwnerName,
          systemPrompt: definition.systemPrompt,
        };
      }
      // Ordinary Sessions and non-Session callers retain the live owner lookup.
      const readPersistedOwner = (ownerName: string) =>
        agentService.getPersistedOwnerForFrozenTask(ownerName);
      const storage = await readPersistedOwner(exactOwnerName);
      if (!storage) {
        return resolveDeletedOwnerFallback(agentService, logger, exactOwnerName, context);
      }
      const executionOwnerName = await resolveExecutionOwnerName(
        agentService,
        storage.exactOwnerName,
        logger,
      );
      // The persisted Session owner stays the ledger/association identity.
      // Live execution reads its current view; frozen Tasks retain only the
      // immutable definition plus identity metadata from the execution row.
      const execution =
        executionOwnerName === storage.exactOwnerName
          ? storage
          : ((await readPersistedOwner(executionOwnerName)) ?? storage);
      return {
        agentName: storage.exactOwnerName,
        executionOwnerName: execution.exactOwnerName,
        resourceAgentName: execution.exactOwnerName,
        displayName: execution.displayName,
        agentRole: execution.agentRole,
        systemPrompt: '',
        metadata: {
          requestRef: execution.requestRef,
          canonicalViewName: execution.canonicalViewName,
          resolvedAgentName: execution.resolvedAgentName,
          creationSource: execution.creationSource,
        },
      };
    },
  };
}

/**
 * Product decision 2026-09-11: deleting an Agent keeps its ordinary
 * conversations in the sidebar, so those Sessions must keep answering under the
 * default (primary) Agent instead of failing with
 * `AgentExecutionSnapshotNotFoundError`.
 *
 * Only `conversation` falls back. `task` never reaches this branch (it is served
 * by the frozen Session definition above), and `cron` / `channel` / `peek` /
 * `unknown` / non-Session callers must keep failing loudly: silently switching
 * identity there would revive orphaned Cron work or answer a preview under an
 * Agent the caller never asked for.
 *
 * The Session keeps its original `agentName`, so ledger/association ownership
 * (`validateAgentAssociation` in turn-preflight) and history attribution do not
 * move; only the behaviour owner becomes the primary row. This is the same
 * storage-owner vs execution-owner split the primary family already relies on.
 */
async function resolveDeletedOwnerFallback(
  agentService: LocalAgentService,
  logger: PluginServiceLogger,
  storageOwnerName: string,
  context: ExecutionSnapshotContext,
): Promise<AgentExecutionSnapshot | undefined> {
  if (!context?.sessionId || context.sessionKind !== 'conversation') {
    logger.warn(
      {
        storage_owner: storageOwnerName,
        session_id: context?.sessionId ?? null,
        session_kind: context?.sessionKind ?? null,
      },
      'agent_execution_snapshot_missing_no_fallback',
    );
    return undefined;
  }
  // Resolve through the existing primary-family chain instead of reading a fixed
  // row: it keeps the legacy alias compatibility (`main` -> `mavis`) and the
  // PRIMARY_AGENT_IDENTITY_CONFLICT fail-closed check, which a hardcoded lookup
  // would bypass.
  const fallbackOwnerName = await resolveExecutionOwnerName(
    agentService,
    agentService.defaultExecutionAgentName,
    logger,
  );
  const fallback = await agentService.getPersistedOwnerForFrozenTask(fallbackOwnerName);
  if (!fallback) {
    // The default Agent itself is unreadable; fail as before rather than guess.
    logger.warn(
      {
        storage_owner: storageOwnerName,
        fallback_owner: fallbackOwnerName,
        session_id: context.sessionId,
        session_kind: context.sessionKind,
      },
      'deleted_agent_fallback_primary_missing',
    );
    return undefined;
  }
  logger.info(
    {
      storage_owner: storageOwnerName,
      fallback_owner: fallback.exactOwnerName,
      session_id: context.sessionId,
      session_kind: context.sessionKind,
    },
    'deleted_agent_execution_fallback',
  );
  return {
    agentName: storageOwnerName,
    executionOwnerName: fallback.exactOwnerName,
    resourceAgentName: fallback.exactOwnerName,
    displayName: fallback.displayName,
    agentRole: fallback.agentRole,
    systemPrompt: '',
    metadata: {
      requestRef: fallback.requestRef,
      canonicalViewName: fallback.canonicalViewName,
      resolvedAgentName: fallback.resolvedAgentName,
      creationSource: fallback.creationSource,
    },
  };
}

/**
 * The persisted Session owner stays the storage owner; only the behaviour owner
 * is pinned to the canonical primary row. Emitted as one bounded event with no
 * secret, token, user message or ACL member detail.
 */
async function resolveExecutionOwnerName(
  agentService: LocalAgentService,
  storageOwnerName: string,
  logger: PluginServiceLogger,
): Promise<string> {
  try {
    const identity = await agentService.resolvePrimaryExecutionIdentity(storageOwnerName);
    // Deliberately unlogged: every ordinary Agent takes this branch on every
    // Turn, and it performs no rebinding. Only the primary family — where the
    // behaviour owner can differ from the persisted owner — is worth an event.
    if (!identity) return storageOwnerName;
    logPrimaryExecutionIdentity(logger, identity);
    return identity.executionOwnerName;
  } catch (error) {
    if (error instanceof AgentServiceError && error.code === 'PRIMARY_AGENT_IDENTITY_CONFLICT') {
      logPrimaryExecutionIdentity(logger, {
        storageOwnerName,
        executionOwnerName: storageOwnerName,
        outcome: 'conflict',
      });
    }
    throw error;
  }
}

function logPrimaryExecutionIdentity(
  logger: PluginServiceLogger,
  identity: PrimaryExecutionIdentity,
): void {
  logger.info(
    {
      storage_owner: identity.storageOwnerName,
      execution_owner: identity.executionOwnerName,
      outcome: identity.outcome,
    },
    'primary_agent_execution_identity',
  );
}
