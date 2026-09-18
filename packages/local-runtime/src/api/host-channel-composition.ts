import type { RuntimeConversation } from '@mavis/conversation-contract';
import { TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER } from '@mavis/conversation-contract';
import type { AgentReferenceResolver } from '../agent/port.js';
import type { LocalAgentRuntimePort } from '../agent/runtime-port.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import type { LocalMessageChannelContext } from '../messages/input.js';
import { applyPermissionReplyFromChannel } from '../permissions/reply.js';
import {
  LocalQuestionnaireError,
  LocalQuestionnaireService,
  type LocalQuestionnaireServiceDeps,
} from '../questionnaire/service.js';
import { classifyQuestionnaireReplyError } from '../questionnaire/reply-outcome.js';
import type { LocalSessionListOptions, LocalSessionRecord } from '../sessions/controller.js';
import { wireChannelSubsystem } from './host-channels.js';
import {
  canonicalProjectWorkspaceDir,
  projectKeyForWorkspace,
  workspaceDirFromProjectKey,
} from '../project/canonical-workspace.js';
import { LocalChannelRootlessError } from '../channels/infra.js';
import { hostCreateRootSession, makeId, type LocalRuntimeApiHostOptions } from './host-helpers.js';
import type { LocalApiAgentRoutes } from './routes/agents.js';
import type { LocalPermissionRouteContext } from './routes/permissions.js';

export interface HostChannelCompositionHandle {
  readonly runtimeConversation?: RuntimeConversation;
  readonly configGetter: () => { dataDir: string };
  readonly nowMs: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly agentName: string;
  readonly agentResolver: AgentReferenceResolver;
  readonly agentRuntimePort: Pick<
    LocalAgentRuntimePort,
    | 'getAgent'
    | 'agentExists'
    | 'getAgentOwnerIdentity'
    | 'getSessionAgentRoutingSnapshot'
    | 'getSessionProjectIdentity'
  >;
  readonly agentRoutes: Pick<LocalApiAgentRoutes, 'replaceRootSession'>;
  readonly channelTurnOrigins: Map<string, LocalMessageChannelContext>;
  resolveDefaultWorkspaceDir(): string;
  getSessionById(sessionId: string): Promise<LocalSessionRecord | undefined>;
  listAllSessions(
    agentName?: string,
    options?: LocalSessionListOptions,
  ): Promise<LocalSessionRecord[]>;
  emitBusEvent(type: string, payload: Record<string, unknown>): void;
  questionnaireServiceDeps(): LocalQuestionnaireServiceDeps;
  permissionRouteContext(): LocalPermissionRouteContext;
}

/**
 * One page is enough for a Root scan: a single Agent family with more than a
 * few hundred conversation Roots is already a corrupted state, and paging here
 * would turn a bounded boot step into an unbounded table walk.
 */
const PRIMARY_FAMILY_ROOT_SCAN_LIMIT = 200;

/** Wires Channel transport to Session V2; no V1 queue or turn fallback exists. */
export function wireHostChannelSubsystem(
  host: HostChannelCompositionHandle,
  options: LocalRuntimeApiHostOptions,
): ReturnType<typeof wireChannelSubsystem> {
  const requireConversation = (): RuntimeConversation => {
    if (!host.runtimeConversation) {
      throw new Error('Runtime Conversation is unavailable for Channel execution');
    }
    return host.runtimeConversation;
  };

  return wireChannelSubsystem({
    dataDir: () => host.configGetter().dataDir,
    nowMs: host.nowMs,
    agentName: host.agentName,
    ...(host.runtimeConversation
      ? {
          resolveAgentReadScope: (requestedName: string) =>
            host.agentResolver.resolveAgentReadScope(requestedName),
          resolveAgentWriteTarget: (requestedName: string) =>
            host.agentResolver.resolveAgentWriteTarget(requestedName),
        }
      : {}),
    makeId,
    fetchImpl: host.fetchImpl,
    ...(host.runtimeConversation ? { conversation: host.runtimeConversation } : {}),
    resolveDefaultWorkspaceDir: () => host.resolveDefaultWorkspaceDir(),
    getSessionById: (id) => host.getSessionById(id),
    listSessions: (agentName, listOptions) => host.listAllSessions(agentName, listOptions),
    createSession: (input) => requireConversation().lifecycle.createSession(input as never),
    ...(host.runtimeConversation
      ? {
          revealMigratedSession: async (sessionId: string) => {
            const conversation = requireConversation();
            const session = await conversation.query.getSession(sessionId);
            if (!session || session.sessionKind === 'cron' || session.sessionKind === 'peek')
              return;
            const trustedLegacyRoot =
              session.sessionType === 'root' && session.sessionKind === 'conversation';
            const markerMissing =
              trustedLegacyRoot && !hasTrustedLegacyImRootMarker(session.purpose);
            if (session.visibility !== 'hidden' && !markerMissing) return;
            await conversation.lifecycle.updateSession(sessionId, {
              ...(session.visibility === 'hidden' ? { visibility: 'visible' } : {}),
              ...(markerMissing
                ? { purpose: appendTrustedLegacyImRootMarker(session.purpose) }
                : {}),
            });
          },
        }
      : {}),
    ...(host.runtimeConversation
      ? {
          imConversationModel: true,
          legacyImCredentialAgent: async (agentName: string) => {
            const detail = (await host.agentRuntimePort.getAgent({ name: agentName })).agent;
            if (!detail) return undefined;
            const workspaceDir = canonicalProjectWorkspaceDir(detail.defaultWorkspaceDir);
            const hasConfiguredWorkspace = (detail.defaultWorkspaceDir?.trim().length ?? 0) > 0;
            return {
              ...(detail.rootSessionId?.trim()
                ? { rootSessionId: detail.rootSessionId.trim() }
                : {}),
              ...(workspaceDir
                ? { defaultProjectKey: projectKeyForWorkspace(workspaceDir) }
                : !hasConfiguredWorkspace
                  ? { defaultProjectKey: projectKeyForWorkspace(undefined) }
                  : {}),
            };
          },
          rootlessV2: {
            getAgentOwnerIdentity: (requestRef: string) =>
              host.agentRuntimePort.getAgentOwnerIdentity(requestRef),
            getSessionAgentRoutingSnapshot: (sessionId: string) =>
              host.agentRuntimePort.getSessionAgentRoutingSnapshot(sessionId),
            getSessionProjectIdentity: (sessionId: string) =>
              host.agentRuntimePort.getSessionProjectIdentity(sessionId),
            resolveProjectWorkspace: (projectKey: string) => {
              if (projectKey === 'default') {
                return {
                  workspaceDir: host.resolveDefaultWorkspaceDir(),
                  isDefaultWorkspace: true,
                };
              }
              const workspaceDir = workspaceDirFromProjectKey(projectKey);
              if (!workspaceDir) {
                throw new LocalChannelRootlessError(
                  400,
                  'CHANNEL_PROJECT_INVALID',
                  'The Channel route Project is invalid.',
                );
              }
              return { workspaceDir, isDefaultWorkspace: false };
            },
          },
        }
      : {}),
    createRootSession: async (agentName) => {
      const conversation = requireConversation();
      const previousRoot = (
        await conversation.query.listSessions({ agentName, sessionType: 'root', limit: 1 })
      )[0];
      return hostCreateRootSession({
        agentName,
        createSession: (input) =>
          conversation.lifecycle.createSession({
            ...input,
            agentName: input.agentName ?? agentName,
          }),
        replaceRootSession: (replacementAgentName, sessionId) =>
          host.agentRoutes.replaceRootSession(replacementAgentName, sessionId),
        deleteSession: (sessionId) => conversation.lifecycle.deleteSession(sessionId),
        resolveWorkspaceDir: () => previousRoot?.workspaceDir ?? host.resolveDefaultWorkspaceDir(),
      });
    },
    configGetter: () => host.configGetter() as LocalRuntimeConfig,
    // Family reconciliation is V2-only. Standalone V1 has no runtime
    // conversation or Agent resolver and must retain its own startup path.
    ...(host.runtimeConversation
      ? {
          primaryFamilyRootSessions: {
            listConversationRoots: async (agentName) =>
              (
                await requireConversation().query.listSessions({
                  agentName,
                  sessionType: 'root',
                  includeSessionKinds: ['conversation'],
                  includeHidden: true,
                  limit: PRIMARY_FAMILY_ROOT_SCAN_LIMIT,
                })
              ).map((session) => ({
                sessionId: session.sessionId,
                agentName: session.agentName,
                runtime: session.runtime,
                sessionType: session.sessionType,
                sessionKind: session.sessionKind,
                archived: session.archived,
                updatedAtMs: session.updatedAtMs,
              })),
            replaceRoot: async (agentName, sessionId) => {
              const replacement = await requireConversation().lifecycle.replaceRootSession(
                agentName,
                sessionId,
              );
              return {
                previousRootSessionIds: replacement.previousRoots.map((root) => root.sessionId),
              };
            },
            // No `workspaceDir`: that is the existing "return the Agent's Root,
            // creating it only when there is none" path, not a second create.
            ensureRoot: async (agentName) => {
              const created = await requireConversation().lifecycle.createRootSession({
                agentName,
              });
              return {
                sessionId: created.sessionId,
                agentName: created.agentName,
                runtime: created.runtime,
                sessionType: created.sessionType,
                sessionKind: created.sessionKind,
                archived: created.archived,
                updatedAtMs: created.updatedAtMs,
              };
            },
            getAgentRootPointer: async (agentName) => {
              if (!(await host.agentRuntimePort.agentExists(agentName))) return undefined;
              const detail = (await host.agentRuntimePort.getAgent({ name: agentName })).agent;
              return detail?.rootSessionId?.trim() || undefined;
            },
            agentExists: (agentName) => host.agentRuntimePort.agentExists(agentName),
          },
          primaryFamilySessionModels: {
            getSession: async (sessionId: string) => {
              const session = await requireConversation().query.getSession(sessionId);
              return session
                ? {
                    sessionId: session.sessionId,
                    effectiveModel: session.effectiveModel ?? null,
                    effectiveModelVariant: session.effectiveModelVariant ?? null,
                  }
                : undefined;
            },
            updateSession: (
              sessionId: string,
              fields: { effectiveModel: string; effectiveModelVariant: null },
            ) => requireConversation().lifecycle.updateSession(sessionId, fields),
          },
        }
      : {}),
    enqueueMessage: async (session, body, enqueueOptions) => {
      const source = enqueueOptions?.source;
      if (
        source !== 'channel:wechat' &&
        source !== 'channel:feishu' &&
        source !== 'channel:telegram'
      ) {
        throw new Error(`Channel enqueue requires a channel source: ${String(source)}`);
      }
      const accepted = await requireConversation().ingress.submit({
        sessionId: session.sessionId,
        source,
        allowQueue: true,
        message: {
          content: body.content,
          ...(body.attachments ? { attachments: body.attachments } : {}),
          ...(body.quotedMessage ? { quotedMessage: body.quotedMessage } : {}),
          ...(body.channelContext ? { channelContext: body.channelContext } : {}),
        },
        ...(enqueueOptions?.clientRequestId
          ? { clientRequestId: enqueueOptions.clientRequestId }
          : {}),
        ...(enqueueOptions?.dedupeKey ? { dedupeKey: enqueueOptions.dedupeKey } : {}),
        ...(enqueueOptions?.expiresAt !== undefined ? { expiresAt: enqueueOptions.expiresAt } : {}),
      });
      return accepted.queue
        ? {
            itemId: accepted.queue.itemId,
            position: accepted.queue.position,
            ahead: accepted.queue.ahead,
          }
        : undefined;
    },
    abortSession: async (sessionId) => {
      await requireConversation().ingress.abort(sessionId, 'user_stop');
    },
    requestCompaction: ({ sessionId, agentName, customInstructions, reason, onStarted }) =>
      requireConversation().maintenance.compact({
        sessionId,
        agentName,
        ...(customInstructions ? { customInstructions } : {}),
        ...(reason ? { reason } : {}),
        ...(onStarted ? { onStarted } : {}),
      }),
    emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
    ...(options.channelOwnerStore ? { ownerStoreOverride: options.channelOwnerStore } : {}),
    ...(options.channelBridgeInfra ? { bridgeInfraOverride: options.channelBridgeInfra } : {}),
    ...(options.channelRunner ? { runnerOverride: options.channelRunner } : {}),
    ...(options.feishuChannelStore
      ? { feishuChannelStoreOverride: options.feishuChannelStore }
      : {}),
    ...(options.telegramChannelStore
      ? { telegramChannelStoreOverride: options.telegramChannelStore }
      : {}),
    ...(options.wechatChannelStore
      ? { wechatChannelStoreOverride: options.wechatChannelStore }
      : {}),
    ...(options.wechatRuntimeSdk ? { wechatRuntimeSdkOverride: options.wechatRuntimeSdk } : {}),
    ...(options.telegramTokenVerifyFetcher
      ? { telegramTokenVerifyFetcher: options.telegramTokenVerifyFetcher }
      : {}),
    ...(options.wechatOnboardFetcher ? { wechatOnboardFetcher: options.wechatOnboardFetcher } : {}),
    ...(options.feishuWsEnabled === false ? { feishuWsEnabled: false } : {}),
    ...(options.capabilityProfile === 'cli'
      ? { channelCapabilityPolicy: 'disabled' as const }
      : {}),
    ...(options.deferChannelStartup === true ? { deferChannelStartup: true } : {}),
    ...(options.metricsReporter ? { metricsReporter: options.metricsReporter } : {}),
    submitQuestionnaireReply: async ({ agentName, requestId, reply }) => {
      try {
        await new LocalQuestionnaireService(host.questionnaireServiceDeps()).reply({
          agentName,
          requestId,
          reply,
        });
        return { status: 'accepted' };
      } catch (error) {
        if (error instanceof LocalQuestionnaireError) {
          host.emitBusEvent('questionnaire.reply_rejected', {
            requestId,
            agentName,
            status: error.status,
            code: error.code,
          });
        } else {
          host.emitBusEvent('questionnaire.reply_failed', {
            requestId,
            agentName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return classifyQuestionnaireReplyError(error);
      }
    },
    applyPermissionReply: (input) =>
      applyPermissionReplyFromChannel(host.permissionRouteContext(), input, () =>
        host.emitBusEvent('permission.im_reply_skipped', { ...input }),
      ),
    resolveChannelTurnOrigin: (sessionId) => {
      const origin = host.channelTurnOrigins.get(sessionId);
      if (!origin) return undefined;
      const { platform, clientName, chatId, threadId } = origin;
      return { platform, clientName, chatId, ...(threadId ? { threadId } : {}) };
    },
    runLegacyImCredentialMigration: options.runLegacyImCredentialMigration,
  });
}

function hasTrustedLegacyImRootMarker(purpose: string | undefined): boolean {
  return Boolean(
    purpose === TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER ||
    purpose?.endsWith(`\n${TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER}`),
  );
}

function appendTrustedLegacyImRootMarker(purpose: string | undefined): string {
  return purpose
    ? `${purpose}\n${TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER}`
    : TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER;
}
