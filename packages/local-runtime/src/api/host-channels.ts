import {
  LocalChannelBridgeInfra,
  type LocalChannelContext,
  type LocalChannelBridgeInfraOptions,
  type LocalChannelPreflightResult,
} from "../channels/infra.js";
import {
  LocalChannelRunner,
  type LocalMultiChannelClient,
} from "../channels/runner.js";
import { LocalChannelOwnerStore } from "../channels/owner-store.js";
import {
  LocalAccessControlStore,
  bindAccessControlAuditLogger,
  type AccessControlAuditLogger,
} from "../channels/access-control-store.js";
import type { LocalChannelAdapterRegistry } from "../channels/adapter-registry.js";
import type { QuestionnaireReplyOutcome } from "../questionnaire/reply-outcome.js";
import {
  LocalFeishuChannelApi,
  LocalFeishuChannelStore,
  feishuClientId,
  type FeishuBotNameResolver,
  type FeishuQuotedMessageResolver,
  type LocalFeishuBindingRecord,
} from "../channels/feishu.js";
import { LocalFeishuChannelClient } from "../channels/feishu-outbound-client.js";
import { FeishuPlatformAdapter } from "../channels/adapters/feishu/feishu-adapter.js";
import type { FeishuPendingReactionStore } from "../channels/adapters/feishu/feishu-ws.js";
import { LocalChannelQuestionnaireBridge } from "../channels/questionnaire-bridge.js";
import {
  LocalChannelPermissionBridge,
  type ChannelPermissionBehavior,
  type ChannelPermissionOrigin,
} from "../channels/permission-bridge.js";
import { createFeishuCardActionHandler } from "./host-feishu-card-action.js";
import {
  LocalTelegramChannelApi,
  LocalTelegramChannelStore,
  telegramClientId,
} from "../channels/telegram.js";
import { TelegramPlatformAdapter } from "../channels/adapters/telegram/telegram-adapter.js";
import { TelegramAttachmentDownloader } from "../channels/adapters/telegram/telegram-attachment-downloader.js";
import { TelegramSender } from "../channels/adapters/telegram/telegram-sender.js";
import {
  LocalWeChatChannelApi,
  LocalWeChatChannelClient,
  LocalWeChatChannelStore,
  isUsableWeChatBinding,
  wechatClientId,
} from "../channels/wechat.js";
import { LocalWeChatChannelAdapter } from "../channels/adapters/wechat/wechat-adapter.js";
import type { WeChatRuntimeSdk } from "../channels/wechat-sdk-contract.js";
import { stubWeChatRuntimeSdk } from "../channels/adapters/wechat/wechat-sdk-stub.js";
import { type ChannelPlatform } from "../channels/route-api.js";
import { listLegacyImCredentialCandidates } from "../channels/legacy-im-migration.js";
import { migrateLegacyImCredentialsOnStartup } from "../channels/legacy-im-migration-startup.js";
import type { LegacyImRoute } from "../channels/im-connection-store-migration.js";
import { PrimaryAgentFamilyReconciler } from "../channels/primary-agent-family-reconciler.js";
import {
  PrimaryAgentRootReconciler,
  type PrimaryFamilyRootSessionPort,
} from "../channels/primary-agent-root-reconciler.js";
import {
  repairPrimaryFamilySessionModels,
  type PrimaryFamilySessionModelPort,
} from "../channels/primary-agent-session-model-repair.js";
import type { LocalRuntimeConfig } from "../config/types.js";
import { createChannelRunner } from "./host-channels-lifecycle.js";
import { restoreInboundLoops } from "./host-channel-restore.js";
import type { ChannelAgentReadScopeResolver } from "./host-channel-family-gate.js";
import type {
  FeishuPendingPermission,
  FeishuPendingQuestionnaire,
} from "./host-channel-pending.js";
import { imLogger, imLogger as logger } from "../common/im-logger.js";
import type { ModuleMetricsReporter } from "../common/metrics.js";
import type { RuntimeConversationChannelView } from "@mavis/conversation-contract";
import { LocalAgentContractError } from "../agent/contract.js";
import { migrateRootlessChannelState } from "../channels/rootless-startup-migration.js";
import type { LocalSessionRecord } from "../sessions/controller.js";
import {
  isCompatibleChannelAgentOwner,
  historicalChannelAgentReadErrorCode,
} from "../channels/agent-owner-compatibility.js";

/** Shorthand for the infra's manual-compaction seam (see `LocalChannelBridgeInfraOptions`). */
type LocalChannelBridgeInfraRequestCompaction = NonNullable<
  LocalChannelBridgeInfraOptions["requestCompaction"]
>;

type LegacyImCredentialAgentResolver = (agentName: string) => Promise<
  | {
      rootSessionId?: string;
      defaultProjectKey?: string;
    }
  | undefined
>;

/** Resolve the per-channel owner store, honouring an optional test override. */
export function resolveChannelOwnerStore(
  dataDir: () => string,
  nowMs: () => number,
  override?: LocalChannelOwnerStore,
): LocalChannelOwnerStore {
  return override ?? new LocalChannelOwnerStore(dataDir, nowMs);
}

/**
 * Resolve the per-channel Access Control store, honouring an optional
 * test override. Sits next to {@link resolveChannelOwnerStore} so the
 * wire layer + tests can stub either store independently. Returns
 * `undefined` when neither `override` nor a default is desired (e.g.
 * the AC feature is opt-out for legacy hosts that still depend on the
 * owner-gate-only behaviour).
 */
export function resolveChannelAccessControlStore(
  dataDir: () => string,
  nowMs: () => number,
  override?: LocalAccessControlStore,
  auditLogger?: AccessControlAuditLogger,
): LocalAccessControlStore {
  return (
    override ??
    new LocalAccessControlStore(
      dataDir,
      nowMs,
      auditLogger ? { logger: auditLogger } : {},
    )
  );
}

const ACCESS_CONTROL_GUIDE_URL =
  "https://vrfi1sk8a0.feishu.cn/docx/Hpx4dmOawomEI9xWqFkcm1kynae";
const ACCESS_CONTROL_DENY_REPLY_ZH = [
  "无权限，无法与该 Agent 对话。请联系 owner 开通权限。",
  `配置指南：${ACCESS_CONTROL_GUIDE_URL}`,
].join("\n");
const ACCESS_CONTROL_DENY_REPLY_EN = [
  "You don't have permission to chat with this Agent. Please contact the owner to grant access.",
  `Configuration guide: ${ACCESS_CONTROL_GUIDE_URL}`,
].join("\n");

function resolveAccessControlDenyLocale(): "zh" | "en" {
  const locale = (
    process.env.NEXT_PUBLIC_LOCALE ?? process.env.MAVIS_ELECTRON_LOCALE
  )
    ?.trim()
    .toLowerCase();
  return /^en(?:[-_]|$)/u.test(locale ?? "") ? "en" : "zh";
}

/**
 * Migration doc §Integration point 7: build a short, non-leaky deny notice for the sender. Never
 * surfaces allowlist contents, the recorded owner, or internal reason codes — the caller (the
 * bridge) appends the `access-control:<reason>` code to its `accessDeniedReason` for ops
 * dashboards, but the user-facing reply uses generic copy so an attacker cannot probe the policy by
 * sending crafted messages.
 */
export function formatAccessControlDenyReply(
  reason: import("../channels/access-control-store.js").AccessControlDenyReason,
  isP2p: boolean,
): string {
  const base =
    resolveAccessControlDenyLocale() === "en"
      ? ACCESS_CONTROL_DENY_REPLY_EN
      : ACCESS_CONTROL_DENY_REPLY_ZH;
  // Reason is logged for ops but never inlined into the user-facing
  // text — keeping the surface generic means the operator can rename
  // a reason later without migrating user-visible copy.
  void reason;
  void isP2p;
  return base;
}

/**
 * Construct the per-platform `LocalChannelBridgeInfra` wired to the host's
 * session/queue/agent-routes and the resolved owner store. The default
 * owner-gate policy is `p => p !== 'wechat'` — see plan D2; Phase 5 may
 * introduce a group allowlist.
 */
export function createChannelBridgeInfra(input: {
  dataDir: () => string;
  nowMs: () => number;
  defaultAgentName: string;
  resolveAgentReadScope?: (requestedName: string) => Promise<{
    canonicalName: string;
    compatibleNames?: readonly string[];
  }>;
  resolveAgentWriteTarget?: (requestedName: string) => Promise<string>;
  resolveDefaultWorkspaceDir: () => string;
  getSessionById: (sessionId: string) => Promise<unknown>;
  listSessions: (
    agentName?: string,
    options?: { includeHidden?: boolean; includePurposePrefix?: string },
  ) => Promise<unknown[]>;
  createSession: (input: Record<string, unknown>) => Promise<unknown>;
  revealMigratedSession?: (sessionId: string) => Promise<void>;
  createRootSession?: (agentName: string) => Promise<unknown>;
  rootlessV2?: LocalChannelBridgeInfraOptions["rootlessV2"];
  /** Exact Agent facts for bounded legacy-credential IM repair in V2 hosts. */
  legacyImCredentialAgent?: LegacyImCredentialAgentResolver;
  /** Enables the V2 IM Connection / Binding / Conversation persistence model. */
  imConversationModel?: boolean;
  enqueueMessage: LocalChannelBridgeInfraOptions["enqueueMessage"];
  abortSession: LocalChannelBridgeInfraOptions["abortSession"];
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
  metrics?: ModuleMetricsReporter;
  /**
   * Optional manual-compaction seam wired to the shared `runLocalCompaction`
   * core. Forwarded verbatim to {@link LocalChannelBridgeInfra} so the
   * `/compact` slash command reuses the exact same compaction path as the HTTP
   * `request-compaction` route.
   */
  requestCompaction?: LocalChannelBridgeInfraRequestCompaction;
  ownerStore: LocalChannelOwnerStore;
  requiresOwnerGate?: (platform: ChannelPlatform) => boolean;
  /**
   * Optional Access Control store. When provided, the bridge runs
   * the AC pipeline before the legacy dedup + owner gate. The CRUD
   * routes under `/mavis/api/channel-bridge/access-control/*` also
   * reach this store through `infra.accessControlStore`.
   */
  accessControlStore?: LocalAccessControlStore;
  override?: LocalChannelBridgeInfra;
}): LocalChannelBridgeInfra {
  if (input.override) return input.override;
  return new LocalChannelBridgeInfra({
    dataDir: input.dataDir,
    defaultAgentName: input.defaultAgentName,
    ...(input.resolveAgentReadScope
      ? { resolveAgentReadScope: input.resolveAgentReadScope }
      : {}),
    ...(input.resolveAgentWriteTarget
      ? { resolveAgentWriteTarget: input.resolveAgentWriteTarget }
      : {}),
    nowMs: input.nowMs,
    resolveDefaultWorkspaceDir: input.resolveDefaultWorkspaceDir,
    getSessionById: input.getSessionById as never,
    listSessions: input.listSessions as never,
    createSession: input.createSession as never,
    ...(input.revealMigratedSession
      ? { revealMigratedSession: input.revealMigratedSession }
      : {}),
    ...(input.createRootSession
      ? { createRootSession: input.createRootSession as never }
      : {}),
    ...(input.rootlessV2 ? { rootlessV2: input.rootlessV2 } : {}),
    ...(input.imConversationModel ? { imConversationModel: true } : {}),
    enqueueMessage: input.enqueueMessage as never,
    abortSession: input.abortSession,
    ...(input.emitBusEvent ? { emitBusEvent: input.emitBusEvent } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(input.requestCompaction
      ? { requestCompaction: input.requestCompaction }
      : {}),
    ownerStore: input.ownerStore,
    requiresOwnerGate:
      input.requiresOwnerGate ?? ((p: ChannelPlatform) => p !== "wechat"),
    ...(input.accessControlStore
      ? { accessControlStore: input.accessControlStore }
      : {}),
  });
}

/**
 * One-shot wire-up of the four channel-owned fields:
 *   - channelOwnerStore (per-clientName mutex)
 *   - channelBridgeInfra (owner-gate + dedup injected)
 *   - channelRunner (lane queue + exact outbound clients)
 *   - channelApis (Feishu / Telegram / WeChat platform APIs)
 */
export function wireChannelSubsystem(input: {
  dataDir: () => string;
  nowMs: () => number;
  agentName: string;
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
  resolveAgentWriteTarget?: (requestedName: string) => Promise<string>;
  makeId: (prefix: string) => string;
  conversation?: RuntimeConversationChannelView;
  resolveDefaultWorkspaceDir: () => string;
  getSessionById: (sessionId: string) => Promise<unknown>;
  listSessions: (
    agentName: string | undefined,
    listOptions:
      | { includeHidden?: boolean; includePurposePrefix?: string }
      | undefined,
  ) => Promise<unknown[]>;
  createSession: (input: Record<string, unknown>) => Promise<unknown>;
  revealMigratedSession?: (sessionId: string) => Promise<void>;
  createRootSession: (agentName: string) => Promise<unknown>;
  rootlessV2?: LocalChannelBridgeInfraOptions["rootlessV2"];
  /** Exact Agent facts for bounded legacy-credential IM repair in V2 hosts. */
  legacyImCredentialAgent?: LegacyImCredentialAgentResolver;
  /** Production V2 composition opts into the three-entity IM model. */
  imConversationModel?: boolean;
  /**
   * Existing Session + Agent capabilities the two family convergence startup
   * steps drive (`primary_agent_root_reconcile`,
   * `primary_agent_session_model_repair`). Absent in test wiring and in hosts
   * booted without Local Runtime V2 — both steps then log a skip instead of
   * inventing a Root or a model.
   */
  primaryFamilyRootSessions?: PrimaryFamilyRootSessionPort;
  primaryFamilySessionModels?: PrimaryFamilySessionModelPort;
  /** Effective runtime config; the model check reads `defaultModel` + provider trees. */
  configGetter?: () => LocalRuntimeConfig;
  enqueueMessage: LocalChannelBridgeInfraOptions["enqueueMessage"];
  abortSession: LocalChannelBridgeInfraOptions["abortSession"];
  emitBusEvent: (type: string, payload: Record<string, unknown>) => void;
  /**
   * Optional manual-compaction seam wired by the host to the shared
   * `runLocalCompaction` core. Threaded into `createChannelBridgeInfra` so the
   * `/compact` slash command reuses the HTTP route's compaction path.
   */
  requestCompaction?: LocalChannelBridgeInfraRequestCompaction;
  runQueuedChannelTurn?: (input: {
    session: unknown;
    queuedMessage: unknown;
  }) => Promise<Response>;
  queueStore?: {
    find: (sessionId: string, queueItemId: string) => Promise<unknown>;
  };
  requiresOwnerGate?: (platform: ChannelPlatform) => boolean;
  ownerStoreOverride?: LocalChannelOwnerStore;
  /**
   * Optional Access Control store override (test-only). Production
   * wires a fresh store rooted at `<dataDir>/access-control.yaml`
   * via {@link resolveChannelAccessControlStore}.
   */
  accessControlStoreOverride?: LocalAccessControlStore;
  bridgeInfraOverride?: LocalChannelBridgeInfra;
  runnerOverride?: LocalChannelRunner;
  fetchImpl?: typeof fetch;
  feishuChannelStoreOverride?: LocalFeishuChannelStore;
  telegramChannelStoreOverride?: LocalTelegramChannelStore;
  wechatChannelStoreOverride?: LocalWeChatChannelStore;
  /** Test-only: stub the Telegram getMe token-verify fetch so bind does no I/O. */
  telegramTokenVerifyFetcher?: typeof fetch;
  /**
   * Test-only: stub the WeChat iLink onboard fetch (`get_bot_qrcode` /
   * `get_qrcode_status`) so `startBind` / `bindStatus` do no I/O. Production
   * leaves this unset and falls back to `globalThis.fetch`.
   */
  wechatOnboardFetcher?: import("../channels/adapters/wechat/wechat-onboard.js").WeChatFetch;
  feishuWsEnabled?: boolean;
  /** Whether cold start may resume transports represented by copied bindings. */
  restoreInboundLoops?: boolean;
  /** Disabled hosts settle readiness without reading, migrating, or restoring Channel state. */
  channelCapabilityPolicy?: "enabled" | "disabled";
  /**
   * True suppresses the construction-time channel startup. Local Runtime V2
   * passes it so the single startup pass runs only after its Session, Agent
   * and Conversation services are ready; the returned `startChannelSubsystem`
   * is then the sole entrypoint. Default false preserves the standalone-V1
   * "start right after construction" behaviour.
   */
  deferChannelStartup?: boolean;
  /**
   * Optional production WeChat SDK. When provided (typically by the Electron
   * main process after `import('./wechat-sdk/index.js')`), the registered
   * `LocalWeChatChannelAdapter` talks to iLink for outbound + attachment
   * downloads. When omitted, the default `stubWeChatRuntimeSdk` is used so
   * unit tests and offline runs keep working without iLink credentials.
   */
  wechatRuntimeSdkOverride?: WeChatRuntimeSdk;
  /**
   * Optional submit callback. Wired by the host to
   * `LocalQuestionnaireService.reply` so a Feishu Card 2.0
   * form-submit decoded by `feishuCardActionHandler` actually resumes
   * the suspended agent turn. Unwired → submits are dropped silently
   * (bridge's no-op default), which is what makes the form "look frozen"
   * after the user taps Submit.
   */
  submitQuestionnaireReply?: (input: {
    agentName: string;
    requestId: string;
    reply: import("@mavis/shared/questionnaire").AskQuestionnaireReplyPayload;
  }) => Promise<QuestionnaireReplyOutcome | void>;
  /**
   * Optional permission reply applier. Wired by the host to
   * `applyPermissionReply(host.permissionRouteContext(), requestId, behavior)`
   * so an IM permission-card click decoded by the channel permission bridge
   * settles the pending request through the existing
   * `replyLocalPermissionRequests` flow (rule persisted + waiter settled +
   * the blocked tool call resumes). Unwired → the runner's permission
   * interception stays inert and callbacks fall through to the legacy
   * plain-message dispatch (pre-MR behaviour).
   */
  applyPermissionReply?: (input: {
    requestId: string;
    behavior: ChannelPermissionBehavior;
  }) => Promise<void>;
  /**
   * Optional turn-origin resolver wired by the host to its per-session
   * channel-turn-origin map. The permission bridge consults it on every
   * `onPermissionAsk` so the card is rendered ONLY to the binding matching
   * the conversation that started the current turn. Unwired (tests) or
   * returning undefined (desktop-initiated turn) → no IM binding renders.
   */
  resolveChannelTurnOrigin?: (
    sessionId: string,
  ) => ChannelPermissionOrigin | undefined;
  /**
   * Optional channel-queue kick callback wired by the host. Forwarded to
   * `createChannelRunner` so the runner delegates inbound dispatch to the
   * host-owned channel-queue drain (mirrors cron's `drainQueuedCronPrompts`).
   */
  kickChannelDrain?: (input: {
    ctx: LocalChannelContext;
    sessionId: string;
    queueItemId: string;
  }) => Promise<void>;
  /** V2-owned receipt policy wrapping the narrow V1 legacy-state action. */
  runLegacyImCredentialMigration?: (
    action: () => Promise<void>,
  ) => Promise<void>;
  /**
   * Optional metrics reporter injected by the host. Forwarded to the channel
   * runner, permission bridge and Feishu card-action handler. Absent → noop.
   */
  metricsReporter?: ModuleMetricsReporter;
}): {
  channelOwnerStore: LocalChannelOwnerStore;
  channelAccessControlStore: LocalAccessControlStore;
  channelBridgeInfra: LocalChannelBridgeInfra;
  channelRunner: LocalChannelRunner;
  channelPermissionBridge: LocalChannelPermissionBridge;
  feishuChannelApi: LocalFeishuChannelApi;
  telegramChannelApi: LocalTelegramChannelApi;
  wechatChannelApi: LocalWeChatChannelApi;
  /**
   * Idempotent channel-subsystem startup: legacy IM credential import →
   * ordered pre-restore steps → exactly one `restoreInboundLoops()`.
   * Concurrent and repeat calls share the first execution.
   */
  startChannelSubsystem: () => Promise<void>;
  channelRestoreReady: Promise<void>;
} {
  const channelOwnerStore = resolveChannelOwnerStore(
    input.dataDir,
    input.nowMs,
    input.ownerStoreOverride,
  );
  const channelAccessControlStore = resolveChannelAccessControlStore(
    input.dataDir,
    input.nowMs,
    input.accessControlStoreOverride,
    bindAccessControlAuditLogger(imLogger),
  );
  const channelBridgeInfra = createChannelBridgeInfra({
    dataDir: input.dataDir,
    defaultAgentName: input.agentName,
    ...(input.resolveAgentReadScope
      ? { resolveAgentReadScope: input.resolveAgentReadScope }
      : {}),
    ...(input.resolveAgentWriteTarget
      ? { resolveAgentWriteTarget: input.resolveAgentWriteTarget }
      : {}),
    nowMs: input.nowMs,
    resolveDefaultWorkspaceDir: input.resolveDefaultWorkspaceDir,
    getSessionById: input.getSessionById,
    listSessions: input.listSessions,
    createSession: input.createSession,
    ...(input.revealMigratedSession
      ? { revealMigratedSession: input.revealMigratedSession }
      : {}),
    createRootSession: input.createRootSession,
    ...(input.rootlessV2 ? { rootlessV2: input.rootlessV2 } : {}),
    ...(input.imConversationModel ? { imConversationModel: true } : {}),
    enqueueMessage: input.enqueueMessage,
    abortSession: input.abortSession,
    emitBusEvent: input.emitBusEvent,
    ...(input.metricsReporter ? { metrics: input.metricsReporter } : {}),
    ...(input.requestCompaction
      ? { requestCompaction: input.requestCompaction }
      : {}),
    ownerStore: channelOwnerStore,
    requiresOwnerGate:
      input.requiresOwnerGate ?? ((p: ChannelPlatform) => p !== "wechat"),
    accessControlStore: channelAccessControlStore,
    ...(input.bridgeInfraOverride
      ? { override: input.bridgeInfraOverride }
      : {}),
  });
  // Construct the questionnaire bridge first so the channel runner can be
  // wired with `tryHandleQuestionnaireReply` interception on dispatchInbound.
  // Bridge `onSubmit` stays no-op: the Feishu card-action handler manually
  // drives `submitQuestionnaireReply` after `bridge.submit` (see below) and
  // we mirror that pattern at the runner level so the existing flow does
  // not break.
  const rawSubmitQuestionnaireReply = input.submitQuestionnaireReply;
  const submitQuestionnaireReply: typeof input.submitQuestionnaireReply =
    rawSubmitQuestionnaireReply
      ? async (replyInput) => {
          const outcome = await rawSubmitQuestionnaireReply(replyInput);
          if (outcome && outcome.status !== "accepted") {
            // Log routing and settlement metadata only; never include the user's
            // reply or answers.
            logger.warn(
              {
                requestId: replyInput.requestId,
                agentName: replyInput.agentName,
                status: outcome.status,
                ...(outcome.code ? { code: outcome.code } : {}),
              },
              "Questionnaire reply returned non-accepted outcome",
            );
          }
          return outcome;
        }
      : undefined;
  const questionnaireBridge = new LocalChannelQuestionnaireBridge();
  // MR-D2: platform-agnostic permission bridge. Shares the same binding
  // store + adapter registry as the questionnaire bridge so a single bound
  // IM conversation can carry both ask_user cards and permission cards.
  // The host wires it into `LocalPermissionRouteContext.channelPermissionOutbound`
  // so the approval service fans the ask out to
  // bound conversations fire-and-forget (the bridge owns its own try/catch).
  // Constructed BEFORE the runner so `dispatchInbound` can consult
  // `tryPermissionReply` on every inbound (inbound wiring, Phase 1).
  const channelPermissionBridge = new LocalChannelPermissionBridge({
    bindingStore: channelBridgeInfra.bindingStore,
    adapterRegistry: channelBridgeInfra.adapterRegistry,
    nowMs: input.nowMs,
    ...(input.resolveChannelTurnOrigin
      ? { resolveOrigin: input.resolveChannelTurnOrigin }
      : {}),
    ...(input.metricsReporter ? { metrics: input.metricsReporter } : {}),
  });
  const applyPermissionReply = input.applyPermissionReply;
  const channelRunner = createChannelRunner({
    infra: channelBridgeInfra,
    dataDir: input.dataDir,
    nowMs: input.nowMs,
    makeId: input.makeId,
    ...(input.conversation ? { conversation: input.conversation } : {}),
    getSessionById: input.getSessionById,
    ...(input.queueStore
      ? {
          getQueuedMessage: (sessionId: string, queueItemId: string) =>
            input.queueStore!.find(sessionId, queueItemId),
        }
      : {}),
    ...(input.runQueuedChannelTurn
      ? { runQueuedTurn: input.runQueuedChannelTurn }
      : {}),
    // Inbound permission interception (Phase 1): resolve the raw platform
    // callback against the bridge's pending map, then settle the pending
    // request through the host's `applyPermissionReply` seam. Only wired
    // when the host provides the applier — otherwise the runner never
    // consults the bridge and callbacks keep the pre-MR fallthrough.
    ...(applyPermissionReply
      ? {
          tryPermissionReply: (ctx: LocalChannelContext, raw: unknown) =>
            channelPermissionBridge.tryPermissionReply(ctx, raw),
          permissionReplyHandler: async ({
            requestId,
            behavior,
          }: {
            ctx: LocalChannelContext;
            requestId: string;
            behavior: ChannelPermissionBehavior;
          }) => {
            await applyPermissionReply({ requestId, behavior });
          },
        }
      : {}),
    questionnaireReplyHandler: async ({
      ctx,
      reply,
    }): Promise<QuestionnaireReplyOutcome> => {
      // Mirror the Feishu card-action handler below: bridge.submit lets
      // the bridge run its own bookkeeping (`submittedAt` defaulting),
      // then we drive the host's reply route so the suspended agent turn
      // actually resumes. Without the second hop the user's answer is
      // accepted server-side but the bot stays silent.
      await questionnaireBridge.submit({ ctx, reply });
      if (submitQuestionnaireReply) {
        const resolved = await submitQuestionnaireReply({
          agentName: agentNameFromClientName(
            ctx.platform,
            ctx.clientName,
            input.agentName,
          ),
          requestId: reply.requestId,
          reply,
        });
        return resolved ?? { status: "accepted" };
      }
      return { status: "accepted" };
    },
    ...(input.runnerOverride ? { override: input.runnerOverride } : {}),
    ...(input.kickChannelDrain
      ? { kickChannelDrain: input.kickChannelDrain }
      : {}),
    ...(input.metricsReporter
      ? { metricsReporter: input.metricsReporter }
      : {}),
  });
  // Migration doc §Integration point 7: deliver a one-line "no permission" notice
  // back to the sender when Access Control denies an inbound. P2p
  // always; group only when the inbound explicitly @-mentioned the
  // bot (avoids bot spam in unrelated group traffic). Delivery always uses
  // the exact platform SDK edge registered for this binding.
  channelBridgeInfra.accessControlDenyReply = async ({ ctx, reason }) => {
    const isP2p = !ctx.chatType || /^(p2p|private|dm)$/iu.test(ctx.chatType);
    if (!isP2p && ctx.hasMention !== true) return "suppressed";
    let client: LocalMultiChannelClient;
    try {
      client = channelRunner.clients.get(ctx);
    } catch {
      return "unavailable";
    }
    const text = formatAccessControlDenyReply(reason, isP2p);
    await client.sendText({ ctx, text });
    return "sent";
  };
  const channelApis = createChannelApis({
    dataDir: input.dataDir,
    nowMs: input.nowMs,
    runner: channelRunner,
    agentName: input.agentName,
    ownerStore: channelOwnerStore,
    accessControlStore: channelAccessControlStore,
    makeId: input.makeId,
    adapterRegistry: channelBridgeInfra.adapterRegistry,
    preflightInbound: (preflightInput) =>
      channelRunner.preflightInbound(preflightInput),
    fetchImpl: input.fetchImpl,
    // Lazy provider so the WS dispatcher can route Feishu `card.action.trigger`
    // events through the same handler that the public webhook uses. The
    // handler is assigned a few lines below (line ~215), and WS only starts
    // after a bind, so by the time it fires the handler is wired.
    cardActionHandlerProvider: () => channelBridgeInfra.feishuCardActionHandler,
    stores: {
      feishu: input.feishuChannelStoreOverride,
      telegram: input.telegramChannelStoreOverride,
      wechat: input.wechatChannelStoreOverride,
    },
    ...(input.telegramTokenVerifyFetcher
      ? { telegramTokenVerifyFetcher: input.telegramTokenVerifyFetcher }
      : {}),
    ...(input.wechatOnboardFetcher
      ? { wechatOnboardFetcher: input.wechatOnboardFetcher }
      : {}),
    ...(input.feishuWsEnabled === false ? { feishuWsEnabled: false } : {}),
    restoreInboundLoops: input.restoreInboundLoops,
    // The startup orchestration below owns the single restore pass for every
    // caller of `wireChannelSubsystem`, deferred or not.
    deferChannelStartup: true,
    ...(input.resolveAgentReadScope
      ? { resolveAgentReadScope: input.resolveAgentReadScope }
      : {}),
    ...(input.wechatRuntimeSdkOverride
      ? { wechatRuntimeSdk: input.wechatRuntimeSdkOverride }
      : {}),
  });
  // MR-C: register the unified FeishuPlatformAdapter against the shared
  // LocalFeishuChannelStore so the legacy LocalFeishuChannelApi and the new
  // adapter agree on a single set of persisted bindings. The questionnaire
  // bridge stays stateless and is shared across all adapters; the
  // `feishuCardActionHandler` decodes Feishu card callbacks into a structured
  // reply payload before handing them to the bridge's submit hook (which the
  // host wires later when the questionnaire store is plumbed in).
  const feishuPlatformAdapter = channelApis.feishuAdapter;
  const feishuPendingQuestionnaires = channelApis.feishuPendingQuestionnaires;
  const feishuPendingPermissions = channelApis.feishuPendingPermissions;
  // Host-supplied submit callback drives reply delivery (→ the questionnaire
  // reply route → resume the suspended agent turn). Without this the form
  // "looks frozen" after the user taps Submit because the bridge submit
  // hook defaults to a no-op.
  // (questionnaireBridge / submitQuestionnaireReply are constructed above
  // so the channel runner can use them for tryHandleQuestionnaireReply.)
  channelBridgeInfra.feishuCardActionHandler = createFeishuCardActionHandler({
    agentName: input.agentName,
    feishuPlatformAdapter,
    feishuPendingQuestionnaires,
    feishuPendingPermissions,
    questionnaireBridge,
    ...(submitQuestionnaireReply ? { submitQuestionnaireReply } : {}),
    // Same host seam MR-1 wired for the runner's Telegram inbound path. Feishu
    // card clicks arrive on the card-action HTTP endpoint (not dispatchInbound),
    // so the permission branch settles them through this applier directly.
    ...(applyPermissionReply ? { applyPermissionReply } : {}),
    getAdapter: (clientName) =>
      channelBridgeInfra.adapterRegistry.get(
        "feishu",
        clientName ?? feishuPlatformAdapter.clientName,
      ) as FeishuPlatformAdapter | undefined,
    ...(input.metricsReporter ? { metrics: input.metricsReporter } : {}),
  });
  // Expose the bridge + adapter via private fields on the infra so tests can
  // reach into them without an extra wiring seam; production callers should
  // go through `channelBridgeInfra.adapterRegistry.get(...)`.
  // (channelPermissionBridge is constructed above, before the runner, so the
  // runner's inbound permission interception can reference it.)
  // One-time forward-compat: migrate legacy per-agent IM credentials
  // (`<dataDir>/credentials/<agent>/{feishu,telegram,wechat}.json`) into the
  // current channel stores + routes. The import writes state only — the single
  // restore pass that `startChannelSubsystem()` runs afterwards is what brings
  // the migrated Telegram/WeChat records online in THIS boot.
  // Plan §5: converge the primary Agent family onto ONE enabled channel owner
  // per platform. Only wired when the host injected an Agent resolver — the
  // family must come from the resolver, never from a hardcoded name list here.
  let suppressPrimaryFamilyTransportStart = false;
  const primaryFamilyReconciler = input.resolveAgentReadScope
    ? new PrimaryAgentFamilyReconciler({
        resolveAgentReadScope: input.resolveAgentReadScope,
        stores: {
          feishu: channelApis.feishuStore,
          telegram: channelApis.telegramStore,
          wechat: channelApis.wechatStore,
        },
        bindingStore: channelBridgeInfra.bindingStore,
        ownerStore: channelOwnerStore,
        accessControlStore: channelAccessControlStore,
        dataDir: input.dataDir,
        nowMs: input.nowMs,
        defaultAgentName: input.agentName,
        teardownTransport: (platform, agentName) =>
          channelApis.teardownPlatformTransport(platform, agentName),
        unregisterTransport: (platform, clientId) => {
          channelRunner.clients.unregister(clientId);
          channelBridgeInfra.adapterRegistry.unregister(platform, clientId);
        },
        startTransport: (platform, agentName) =>
          suppressPrimaryFamilyTransportStart
            ? undefined
            : channelApis.startPlatformTransport(platform, agentName),
      })
    : undefined;
  const installPrimaryFamilyHooks = () => {
    if (!primaryFamilyReconciler) return;
    channelApis.feishuStore.setFamilyMutationHook(
      primaryFamilyReconciler.mutationHook("feishu"),
    );
    channelApis.telegramStore.setFamilyMutationHook(
      primaryFamilyReconciler.mutationHook("telegram"),
    );
    channelApis.wechatStore.setFamilyMutationHook(
      primaryFamilyReconciler.mutationHook("wechat"),
    );
  };
  const primaryRootReconciler =
    !input.rootlessV2 &&
    primaryFamilyReconciler &&
    input.resolveAgentReadScope &&
    input.primaryFamilyRootSessions
      ? new PrimaryAgentRootReconciler({
          resolveAgentReadScope: input.resolveAgentReadScope,
          sessions: input.primaryFamilyRootSessions,
        })
      : undefined;
  let startup: Promise<void> | undefined;
  let settleReady!: (error?: unknown) => void;
  const channelRestoreReady = new Promise<void>((resolve, reject) => {
    settleReady = (error?: unknown) =>
      error === undefined ? resolve() : reject(error);
  });
  void channelRestoreReady.catch(() => undefined);
  const startChannelSubsystem = (): Promise<void> => {
    startup ??= (async () => {
      try {
        if (input.channelCapabilityPolicy === "disabled") {
          settleReady();
          return;
        }
        if (input.runLegacyImCredentialMigration) {
          await input.runLegacyImCredentialMigration(() =>
            migrateLegacyImCredentialsOnStartup({
              dataDir: input.dataDir,
              nowMs: input.nowMs,
              agentName: input.agentName,
              feishuStore: channelApis.feishuStore,
              telegramStore: channelApis.telegramStore,
              wechatStore: channelApis.wechatStore,
              bindingStore: channelBridgeInfra.bindingStore,
              getSessionById: input.getSessionById,
            }),
          );
        }
        if (input.rootlessV2) {
          await migrateRootlessChannelState({
            dataDir: input.dataDir(),
            defaultAgentName: input.agentName,
            nowMs: input.nowMs,
            bindingStore: channelBridgeInfra.bindingStore,
            getSessionById: input.getSessionById,
            rootless: input.rootlessV2,
            ...(input.resolveAgentReadScope
              ? { resolveAgentReadScope: input.resolveAgentReadScope }
              : {}),
          });
          await migrateLegacyImConnectionState({
            dataDir: input.dataDir(),
            bindingStore: channelBridgeInfra.bindingStore,
            imConnectionStore: channelBridgeInfra.imConnectionStore,
            rootless: input.rootlessV2,
            getSessionById: input.getSessionById,
            listSessions: input.listSessions,
            isUsableWeChatRoute: async (route) => {
              const legacyAgentName = route.clientName.startsWith("wechat:")
                ? route.clientName.slice("wechat:".length).trim()
                : "";
              return isUsableWeChatBinding(
                await channelApis.wechatStore.get(
                  legacyAgentName || route.agentName,
                ),
              );
            },
            ...(input.resolveAgentReadScope
              ? { resolveAgentReadScope: input.resolveAgentReadScope }
              : {}),
            ...(input.legacyImCredentialAgent
              ? { legacyImCredentialAgent: input.legacyImCredentialAgent }
              : {}),
          });
        }
        installPrimaryFamilyHooks();
        if (primaryFamilyReconciler) {
          // The startup reconcile converges persisted ownership only. Root /
          // model validation must complete before the sole restore starts live
          // inbound; concurrent family binds stay gated through those checks.
          suppressPrimaryFamilyTransportStart = true;
          try {
            await primaryFamilyReconciler.reconcileAll();
            if (input.conversation && !input.rootlessV2) {
              if (
                !primaryRootReconciler ||
                !input.primaryFamilySessionModels ||
                !input.configGetter
              ) {
                throw new Error("PRIMARY_AGENT_STARTUP_PORT_UNWIRED");
              }
              const { scopedSessionIds } =
                await primaryRootReconciler.reconcile();
              await repairPrimaryFamilySessionModels(
                {
                  config: input.configGetter,
                  sessions: input.primaryFamilySessionModels,
                },
                scopedSessionIds,
              );
            }
          } finally {
            suppressPrimaryFamilyTransportStart = false;
          }
        }
        await channelApis.restartInboundLoops();
        settleReady();
      } catch (err) {
        settleReady(err);
        throw err;
      }
    })();
    return startup;
  };
  if (input.deferChannelStartup !== true) {
    void Promise.resolve()
      .then(startChannelSubsystem)
      .catch((err) =>
        logger.error({ err }, "Channel subsystem startup failed"),
      );
  }
  return {
    channelOwnerStore,
    channelAccessControlStore,
    channelBridgeInfra,
    channelRunner,
    channelPermissionBridge,
    feishuChannelApi: channelApis.feishu,
    telegramChannelApi: channelApis.telegram,
    wechatChannelApi: channelApis.wechat,
    startChannelSubsystem,
    channelRestoreReady,
  };
}

/**
 * One-version bridge from opaque legacy per-chat route rows to the V2 IM
 * Connection/physical Binding-to-Session model. Each historical row is
 * validated independently: ambiguous rows remain unchanged in their legacy storage and
 * cannot prevent an unrelated platform from restoring.
 */
async function migrateLegacyImConnectionState(input: {
  dataDir: string;
  bindingStore: LocalChannelBridgeInfra["bindingStore"];
  imConnectionStore: LocalChannelBridgeInfra["imConnectionStore"];
  rootless: NonNullable<LocalChannelBridgeInfraOptions["rootlessV2"]>;
  getSessionById(sessionId: string): Promise<unknown>;
  listSessions: (
    agentName: string | undefined,
    listOptions:
      | { includeHidden?: boolean; includePurposePrefix?: string }
      | undefined,
  ) => Promise<unknown[]>;
  isUsableWeChatRoute?: (route: LegacyImRoute) => Promise<boolean>;
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
  legacyImCredentialAgent?: LegacyImCredentialAgentResolver;
}): Promise<void> {
  if (!input.imConnectionStore) return;
  const rawBindingRoutes: LegacyImRoute[] = (
    await input.bindingStore.list()
  ).map((binding) => ({
    key: binding.key,
    platform: binding.platform,
    clientName: binding.clientName,
    agentName: binding.agentName,
    projectKey: binding.projectKey,
    sessionId: binding.sessionId,
    strategy: binding.strategy,
    updatedAt: binding.updatedAt,
  }));
  const bindingRoutes = await resolveLegacyImBindingRoutes({
    ...input,
    bindingRoutes: rawBindingRoutes,
  });
  const credentialAgent = input.legacyImCredentialAgent;
  const credentialRoutes = credentialAgent
    ? await legacyCredentialRoutes({
        ...input,
        // A failed root/main resolution still owns this old transport
        // profile. Passing only the resolved rows would let a credential
        // candidate bypass that local safety skip.
        bindingRoutes: rawBindingRoutes,
        legacyImCredentialAgent: credentialAgent,
      })
    : [];
  const legacyRoutes = await filterUnconfirmedLegacyWeChatRoutes(
    [...bindingRoutes, ...credentialRoutes],
    input.isUsableWeChatRoute,
  );
  await input.imConnectionStore.migrateLegacy({
    legacyRoutes,
    isUsableSession: async (candidate) => {
      const keepUnavailableAgentLocal = (error: unknown) => {
        const code = historicalChannelAgentReadErrorCode(error);
        if (!code) throw error;
        logger.warn(
          { code, sessionId: candidate.sessionId },
          "legacy IM Session Agent could not be read; keeping original route",
        );
        return undefined;
      };
      const [session, snapshot, owner, project] = await Promise.all([
        input.getSessionById(candidate.sessionId),
        input.rootless
          .getSessionAgentRoutingSnapshot(candidate.sessionId)
          .catch(keepUnavailableAgentLocal),
        input.rootless
          .getAgentOwnerIdentity(candidate.agentName)
          .catch(keepUnavailableAgentLocal),
        input.rootless.getSessionProjectIdentity(candidate.sessionId),
      ]);
      if (
        !session ||
        typeof session !== "object" ||
        !snapshot ||
        !owner ||
        !project
      )
        return false;
      if (
        !(await isCompatibleChannelAgentOwner({
          persisted: snapshot,
          current: owner,
          ...(input.resolveAgentReadScope
            ? { resolveAgentReadScope: input.resolveAgentReadScope }
            : {}),
        }))
      ) {
        return false;
      }
      return project.projectKey === candidate.projectKey;
    },
    onSkipped: ({ code, keys }) => {
      logger.warn(
        { code, bindingKeys: keys },
        "legacy IM route migration skipped locally",
      );
    },
  });
}

type LegacyImRootResolutionInput = {
  rootless: NonNullable<LocalChannelBridgeInfraOptions["rootlessV2"]>;
  getSessionById(sessionId: string): Promise<unknown>;
  listSessions: (
    agentName: string | undefined,
    listOptions:
      | { includeHidden?: boolean; includePurposePrefix?: string }
      | undefined,
  ) => Promise<unknown[]>;
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
  legacyImCredentialAgent?: LegacyImCredentialAgentResolver;
};

type TrustedLegacyImRoot = {
  readonly agentName: string;
  readonly projectKey: string;
  readonly sessionId: string;
};

type LegacyImRootOwner = {
  readonly exactOwnerName: string;
  readonly ownerKind: "builtin" | "custom";
  readonly ownerInstanceId?: string;
};

function isLegacyRootStrategy(strategy: LegacyImRoute["strategy"]): boolean {
  return strategy === "root" || strategy === "main";
}

/**
 * Legacy `root` / `main` rows cache the cursor that happened to be selected
 * when the row was written. That cursor is not an authority after `/new`.
 * Resolve the current Agent Root read-only, then retain the old cursor only
 * as narrowly scoped receipt-repair evidence.
 */
async function resolveLegacyImBindingRoutes(
  input: LegacyImRootResolutionInput & {
    bindingRoutes: readonly LegacyImRoute[];
  },
): Promise<LegacyImRoute[]> {
  const resolved: LegacyImRoute[] = [];
  for (const route of input.bindingRoutes) {
    if (!isLegacyRootStrategy(route.strategy)) {
      resolved.push(route);
      continue;
    }
    const root = await resolveTrustedLegacyImRoot(input, route);
    if (!root) continue;
    resolved.push({
      ...route,
      agentName: root.agentName,
      projectKey: root.projectKey,
      sessionId: root.sessionId,
      legacyRootSessionId: route.sessionId,
      legacyRootProjectKey: route.projectKey,
      trustedRootSessionId: root.sessionId,
    });
  }
  return resolved;
}

async function resolveTrustedLegacyImRoot(
  input: LegacyImRootResolutionInput,
  route: Pick<LegacyImRoute, "agentName" | "key">,
  hint?: { owner?: LegacyImRootOwner; pointerSessionId?: string },
): Promise<TrustedLegacyImRoot | undefined> {
  let owner = hint?.owner;
  if (!owner) {
    try {
      owner = await input.rootless.getAgentOwnerIdentity(route.agentName);
    } catch (error) {
      const agentReadErrorCode = historicalChannelAgentReadErrorCode(error);
      if (!agentReadErrorCode) throw error;
      reportLegacyImSkip(
        "CHANNEL_IM_LEGACY_ROOT_UNTRUSTED",
        route.key,
        agentReadErrorCode,
      );
      return undefined;
    }
  }

  let pointerSessionId = hint?.pointerSessionId;
  if (pointerSessionId === undefined && input.legacyImCredentialAgent) {
    try {
      pointerSessionId = (
        await input.legacyImCredentialAgent(route.agentName)
      )?.rootSessionId?.trim();
    } catch (error) {
      const agentReadErrorCode = historicalChannelAgentReadErrorCode(error);
      if (!agentReadErrorCode) throw error;
      // The Agent identity above remains sufficient for the bounded, read-only
      // fallback scan below. Do not turn an unavailable pointer into a create.
      reportLegacyImSkip(
        "CHANNEL_IM_LEGACY_ROOT_POINTER_UNAVAILABLE",
        route.key,
        agentReadErrorCode,
      );
    }
  }
  if (pointerSessionId) {
    const root = await trustedLegacyImRootForSession(
      input,
      owner,
      pointerSessionId,
    );
    if (root) return root;
  }

  const candidates: TrustedLegacyImRoot[] = [];
  const seenSessionIds = new Set<string>();
  for (const session of await input.listSessions(owner.exactOwnerName, {
    includeHidden: true,
  })) {
    if (!isActiveLegacyImRoot(session) || seenSessionIds.has(session.sessionId))
      continue;
    seenSessionIds.add(session.sessionId);
    const root = await trustedLegacyImRootForSession(
      input,
      owner,
      session.sessionId,
      session,
    );
    if (root) candidates.push(root);
  }
  if (candidates.length === 1) return candidates[0];
  reportLegacyImSkip(
    candidates.length > 1
      ? "CHANNEL_IM_LEGACY_ROOT_AMBIGUOUS"
      : "CHANNEL_IM_LEGACY_ROOT_UNTRUSTED",
    route.key,
  );
  return undefined;
}

async function trustedLegacyImRootForSession(
  input: LegacyImRootResolutionInput,
  owner: {
    exactOwnerName: string;
    ownerKind: "builtin" | "custom";
    ownerInstanceId?: string;
  },
  sessionId: string,
  listedSession?: LocalSessionRecord,
): Promise<TrustedLegacyImRoot | undefined> {
  let session: unknown = listedSession;
  let snapshot: Awaited<
    ReturnType<typeof input.rootless.getSessionAgentRoutingSnapshot>
  >;
  let project: Awaited<
    ReturnType<typeof input.rootless.getSessionProjectIdentity>
  >;
  try {
    [session, snapshot, project] = await Promise.all([
      session ?? input.getSessionById(sessionId),
      input.rootless.getSessionAgentRoutingSnapshot(sessionId),
      input.rootless.getSessionProjectIdentity(sessionId),
    ]);
  } catch (error) {
    if (
      isMissingSessionError(error) ||
      historicalChannelAgentReadErrorCode(error)
    )
      return undefined;
    throw error;
  }
  if (!isActiveLegacyImRoot(session) || !snapshot || !project) return undefined;
  if (
    !(await isCompatibleChannelAgentOwner({
      persisted: snapshot,
      current: owner,
      ...(input.resolveAgentReadScope
        ? { resolveAgentReadScope: input.resolveAgentReadScope }
        : {}),
    }))
  ) {
    return undefined;
  }
  return {
    agentName: owner.exactOwnerName,
    projectKey: project.projectKey,
    sessionId: session.sessionId,
  };
}

function isActiveLegacyImRoot(session: unknown): session is LocalSessionRecord {
  return (
    Boolean(session) &&
    typeof session === "object" &&
    (session as { runtime?: unknown }).runtime === "pi-agent" &&
    (session as { sessionType?: unknown }).sessionType === "root" &&
    (session as { sessionKind?: unknown }).sessionKind === "conversation" &&
    (session as { archived?: unknown }).archived !== true &&
    typeof (session as { sessionId?: unknown }).sessionId === "string" &&
    (session as { sessionId: string }).sessionId.trim().length > 0
  );
}

async function filterUnconfirmedLegacyWeChatRoutes(
  routes: readonly LegacyImRoute[],
  isUsableWeChatRoute: ((route: LegacyImRoute) => Promise<boolean>) | undefined,
): Promise<LegacyImRoute[]> {
  if (!isUsableWeChatRoute) return [...routes];
  const eligible: LegacyImRoute[] = [];
  for (const route of routes) {
    if (route.platform !== "wechat" || (await isUsableWeChatRoute(route))) {
      eligible.push(route);
      continue;
    }
    reportLegacyImSkip("CHANNEL_IM_LEGACY_WECHAT_UNCONFIRMED", route.key);
  }
  return eligible;
}

async function legacyCredentialRoutes(input: {
  dataDir: string;
  rootless: NonNullable<LocalChannelBridgeInfraOptions["rootlessV2"]>;
  getSessionById(sessionId: string): Promise<unknown>;
  listSessions: (
    agentName: string | undefined,
    listOptions:
      | { includeHidden?: boolean; includePurposePrefix?: string }
      | undefined,
  ) => Promise<unknown[]>;
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
  legacyImCredentialAgent: LegacyImCredentialAgentResolver;
  bindingRoutes: readonly LegacyImRoute[];
}): Promise<LegacyImRoute[]> {
  const routes: LegacyImRoute[] = [];
  for (const candidate of await listLegacyImCredentialCandidates(
    input.dataDir,
  )) {
    let agent;
    try {
      agent = await input.legacyImCredentialAgent(candidate.agentName);
    } catch (error) {
      if (historicalChannelAgentReadErrorCode(error)) {
        reportLegacyCredentialSkip(
          "CHANNEL_IM_LEGACY_CREDENTIAL_AGENT_MISSING",
          candidate.key,
          historicalChannelAgentReadErrorCode(error),
        );
        continue;
      }
      throw error;
    }
    if (!agent) {
      reportLegacyCredentialSkip(
        "CHANNEL_IM_LEGACY_CREDENTIAL_AGENT_MISSING",
        candidate.key,
      );
      continue;
    }
    let owner;
    try {
      owner = await input.rootless.getAgentOwnerIdentity(candidate.agentName);
    } catch (error) {
      if (historicalChannelAgentReadErrorCode(error)) {
        reportLegacyCredentialSkip(
          "CHANNEL_IM_LEGACY_CREDENTIAL_AGENT_MISSING",
          candidate.key,
          historicalChannelAgentReadErrorCode(error),
        );
        continue;
      }
      throw error;
    }
    if (
      hasExactLegacyBindingProfile(
        input.bindingRoutes,
        candidate,
        owner.exactOwnerName,
      )
    )
      continue;
    const rootSessionId = agent.rootSessionId?.trim();
    if (!rootSessionId) {
      const projectKey = agent.defaultProjectKey?.trim();
      if (!projectKey) {
        reportLegacyCredentialSkip(
          "CHANNEL_IM_LEGACY_CREDENTIAL_PROJECT_UNTRUSTED",
          candidate.key,
        );
        continue;
      }
      routes.push({
        ...candidate,
        agentName: owner.exactOwnerName,
        projectKey,
        sessionId: "",
        emptyCursor: true,
        updatedAt: 0,
      });
      continue;
    }
    const root = await resolveTrustedLegacyImRoot(input, candidate, {
      owner,
      pointerSessionId: rootSessionId,
    });
    if (!root) {
      reportLegacyCredentialSkip(
        "CHANNEL_IM_LEGACY_CREDENTIAL_ROOT_UNTRUSTED",
        candidate.key,
      );
      continue;
    }
    routes.push({
      ...candidate,
      agentName: root.agentName,
      projectKey: root.projectKey,
      sessionId: root.sessionId,
      trustedRootSessionId: root.sessionId,
      updatedAt: 0,
    });
  }
  return routes;
}

function hasExactLegacyBindingProfile(
  routes: readonly LegacyImRoute[],
  candidate: Awaited<
    ReturnType<typeof listLegacyImCredentialCandidates>
  >[number],
  exactOwnerName?: string,
): boolean {
  return routes.some(
    (route) =>
      (route.agentName === candidate.agentName ||
        route.agentName === exactOwnerName) &&
      route.platform === candidate.platform &&
      route.clientName === candidate.clientName,
  );
}

function reportLegacyImSkip(
  code: string,
  bindingKey: string,
  agentReadErrorCode?: string,
): void {
  logger.warn(
    { code, bindingKey, ...(agentReadErrorCode ? { agentReadErrorCode } : {}) },
    "legacy IM migration skipped locally",
  );
}

function reportLegacyCredentialSkip(
  code: string,
  bindingKey: string,
  agentReadErrorCode?: string,
): void {
  logger.warn(
    { code, bindingKey, ...(agentReadErrorCode ? { agentReadErrorCode } : {}) },
    "legacy IM credential migration skipped locally",
  );
}

function isMissingSessionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "SESSION_NOT_FOUND"
  );
}

/** Construct the channel runner. */
/** Construct the three platform channel APIs against a shared runner. */
export function createChannelApis(input: {
  dataDir: () => string;
  nowMs: () => number;
  runner: LocalChannelRunner;
  agentName: string;
  ownerStore: LocalChannelOwnerStore;
  /**
   * Access Control store. Forwarded into `restoreInboundLoops` so a
   * desktop restart seeds the default policy for every already-bound
   * clientName. The store itself is also kept alive by the caller so
   * the CRUD routes under `/channel-bridge/access-control/*` can reach
   * it via `infra.accessControlStore`.
   */
  accessControlStore?: LocalAccessControlStore;
  makeId: (prefix: string) => string;
  stores: {
    feishu?: LocalFeishuChannelStore;
    telegram?: LocalTelegramChannelStore;
    wechat?: LocalWeChatChannelStore;
  };
  /**
   * Optional adapter registry. When provided, the new unified-channel
   * `TelegramPlatformAdapter` is registered so the
   * `/channel-bridge/telegram/{bind,unbind,status,inbound}` routes can
   * dispatch through the registry alongside the legacy
   * `LocalTelegramChannelApi` paths. The adapter shares the same backing
   * `LocalTelegramChannelStore` instance to keep a single source of truth
   * for the binding.
   */
  adapterRegistry?: LocalChannelAdapterRegistry;
  /** Access preflight shared with Feishu WS before reaction/card/download I/O. */
  preflightInbound?: (input: {
    ctx: LocalChannelContext;
    text: string;
    eventId?: string;
  }) => Promise<LocalChannelPreflightResult>;
  fetchImpl?: typeof fetch;
  /** Test-only: stub the Telegram getMe token-verify fetch (see API options). */
  telegramTokenVerifyFetcher?: typeof fetch;
  /** Test-only: stub the WeChat iLink onboard fetch (see API options). */
  wechatOnboardFetcher?: import("../channels/adapters/wechat/wechat-onboard.js").WeChatFetch;
  feishuWsEnabled?: boolean;
  /** False restores exact outbound clients but not copied inbound transports. */
  restoreInboundLoops?: boolean;
  /**
   * True leaves every transport untouched at construction: only stores, APIs,
   * runner and registries are built. The caller then owns the single startup
   * pass (`LocalRuntimeApiHost.startChannelSubsystem()`), and
   * `channelRestoreReady` resolves with that pass instead of at construction.
   * Default false keeps standalone V1 hosts starting on construction.
   */
  deferChannelStartup?: boolean;
  /**
   * Agent read-scope resolver forwarded to the restore family gate so two
   * enabled records of one canonical family never start two transports.
   */
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
  /**
   * Optional provider that the WS dispatcher uses to look up the live
   * `feishuCardActionHandler` from the bridge infra. Provider style (vs a
   * fixed handler reference) because the handler is assigned AFTER
   * `createChannelApis` returns — the handler closure needs the
   * `feishuPendingQuestionnaires` map that `createChannelApis` owns. By
   * the time the WS fires its first card-action the handler is wired.
   */
  cardActionHandlerProvider?: () =>
    | ((body: Record<string, unknown>) => Promise<Response>)
    | undefined;
  /**
   * Optional production WeChat SDK. When omitted, the registered
   * `LocalWeChatChannelAdapter` is wired to {@link stubWeChatRuntimeSdk}
   * so unit tests and offline runs never reach iLink. Production Electron
   * main passes a real SDK constructed from `wechat-sdk/index.js`.
   */
  wechatRuntimeSdk?: WeChatRuntimeSdk;
}): {
  feishu: LocalFeishuChannelApi;
  feishuStore: LocalFeishuChannelStore;
  feishuAdapter: FeishuPlatformAdapter;
  feishuPendingQuestionnaires: Map<string, FeishuPendingQuestionnaire>;
  feishuPendingPermissions: Map<string, FeishuPendingPermission>;
  telegram: LocalTelegramChannelApi;
  telegramStore: LocalTelegramChannelStore;
  wechat: LocalWeChatChannelApi;
  wechatStore: LocalWeChatChannelStore;
  /**
   * Re-run the inbound-loop restore pass (Telegram poller / WeChat monitor /
   * Feishu WS + adapter registration). Fired once at construction; also
   * handed to the legacy-IM migration so a first-upgrade boot starts the
   * freshly-migrated platforms' loops without a second manual restart.
   * Idempotent: each adapter's start guards on an already-running loop.
   */
  restartInboundLoops: () => Promise<void>;
  /**
   * Register + start ONE record's transport, honouring the same `enabled` /
   * mode / credential gates the restore pass uses. The primary-family
   * reconciler calls this as its final step (plan §5.5 step 7) so the winner
   * comes up without a second full restore pass.
   */
  startPlatformTransport: (
    platform: ChannelPlatform,
    agentName: string,
  ) => Promise<void>;
  /**
   * Stop ONE agent's live transport on a platform, reusing the existing
   * teardown entrypoints (`invalidateTransport` / `shutdown`). Idempotent and
   * strictly scoped so a sibling agent is never touched.
   */
  teardownPlatformTransport: (
    platform: ChannelPlatform,
    agentName: string,
  ) => Promise<void>;
  channelRestoreReady: Promise<void>;
} {
  const feishuStore =
    input.stores.feishu ??
    new LocalFeishuChannelStore(input.dataDir, input.nowMs);
  const feishuWsEnabled = input.feishuWsEnabled !== false;
  const feishuPendingQuestionnaires = new Map<
    string,
    FeishuPendingQuestionnaire
  >();
  const feishuPendingPermissions = new Map<string, FeishuPendingPermission>();
  // Shared per-chat map of "🤔 Thinking…" cards the WS dispatcher renders so
  // the outbound client can PATCH them into the final green reply card.
  const feishuPendingThinkingCards = new Map<
    string,
    { messageId: string; createdAtMs: number }
  >();
  // Shared per-inbound-message map of 👀 `OnIt` ack reactions the WS
  // dispatcher posts so the outbound side can revoke them once the final
  // reply has been delivered.
  const feishuPendingReactions: FeishuPendingReactionStore = new Map();
  const channelFetch = input.fetchImpl;
  const feishuSenderOptions = channelFetch ? { fetcher: channelFetch } : {};
  const registerFeishuClient = (record?: LocalFeishuBindingRecord) => {
    const agentName = record?.agentName ?? input.agentName;
    const client = new LocalFeishuChannelClient(
      input.runner.outboundStore,
      feishuStore,
      agentName,
      feishuSenderOptions,
      feishuPendingThinkingCards,
      feishuPendingReactions,
      ({ chatId, request, messageId }) => {
        feishuPendingQuestionnaires.set(request.id, {
          request,
          clientName: feishuClientId(agentName),
          chatId,
          messageId,
          createdAtMs: input.nowMs(),
        });
        logger.info(
          { requestId: request.id, messageId, source: "adapter" },
          "Feishu questionnaire rendered",
        );
      },
      feishuClientId(agentName),
    );
    if (!record || !record.enabled || record.mode === "mock") return;
    input.runner.clients.registerExact(client);
  };
  const feishuAdapters = new Map<string, FeishuPlatformAdapter>();
  const unregisterFeishuEdge = (agentName: string): void => {
    const clientId = feishuClientId(agentName);
    feishuAdapters.get(clientId)?.invalidateTransport();
    input.runner.clients.unregister(clientId);
    input.adapterRegistry?.unregister("feishu", clientId);
  };
  const makeFeishuWsInput = () => ({
    dispatchInbound: (message: unknown) =>
      input.runner.dispatchInbound(message as never),
    ...(input.preflightInbound
      ? { preflightInbound: input.preflightInbound }
      : {}),
    // Route Feishu Card 2.0 form submissions (questionnaire) through the same
    // `feishuCardActionHandler` that the public webhook uses.
    onCardAction: async (data: unknown) => {
      const handler = input.cardActionHandlerProvider?.();
      if (!handler) return {};
      const resp = await handler((data ?? {}) as Record<string, unknown>);
      try {
        const body = await resp.json();
        if (body && typeof body === "object" && "toast" in body) return body;
      } catch {
        /* not JSON or already consumed — fall through */
      }
      return {};
    },
  });
  const getOrCreateFeishuAdapter = (
    agentName: string,
    options?: { register?: boolean },
  ): FeishuPlatformAdapter => {
    const clientName = feishuClientId(agentName);
    const register = options?.register !== false;
    const existing = feishuAdapters.get(clientName);
    if (existing) {
      // Re-registering an existing instance is a Map write, so a lazily
      // constructed adapter still lands in the registry the first time an
      // enabled record (restore) or a bind asks for it.
      if (register) input.adapterRegistry?.register(existing);
      return existing;
    }
    const adapter = new FeishuPlatformAdapter(
      { store: feishuStore, agentName },
      {
        wsClientFactory:
          feishuWsEnabled && input.adapterRegistry ? undefined : false,
        pendingThinkingStore: feishuPendingThinkingCards,
        pendingReactionStore: feishuPendingReactions,
        senderOptions: feishuSenderOptions,
        onBindingChanged: (record) => {
          registerFeishuClient(record);
          if (record.mode === "websocket") {
            // Fire-and-forget on purpose (bind must not block on the WS
            // handshake), but never silently: log attempt / outcome so a
            // failed connect is diagnosable instead of "bound but deaf".
            logger.info(
              { agentName: record.agentName, platform: "feishu" },
              "Feishu WS start requested (binding changed)",
            );
            void getOrCreateFeishuAdapter(record.agentName)
              .startWebSocket(makeFeishuWsInput())
              .then((started) => {
                logger.info(
                  { agentName: record.agentName, started, platform: "feishu" },
                  "Feishu WS start finished (binding changed)",
                );
              })
              .catch((err) => {
                logger.error(
                  { err, agentName: record.agentName, platform: "feishu" },
                  "Feishu WS start failed (binding changed)",
                );
              });
          }
        },
        onQuestionnaireRendered: ({ chatId, request, messageId }) => {
          feishuPendingQuestionnaires.set(request.id, {
            request,
            clientName,
            chatId,
            messageId,
            createdAtMs: input.nowMs(),
          });
          logger.info(
            { requestId: request.id, messageId, source: "adapter" },
            "Feishu questionnaire rendered",
          );
        },
        onPermissionRendered: ({ chatId, renderable, messageId }) => {
          feishuPendingPermissions.set(renderable.requestId, {
            renderable,
            clientName,
            chatId,
            messageId,
            createdAtMs: input.nowMs(),
          });
          logger.info(
            { requestId: renderable.requestId, messageId, source: "adapter" },
            "Feishu permission rendered",
          );
        },
      },
    );
    const wsDownloader = adapter.buildAttachmentDownloader(input.dataDir);
    adapter.setWsAttachmentDownloader(wsDownloader);
    feishuAdapters.set(clientName, adapter);
    if (register) input.adapterRegistry?.register(adapter);
    return adapter;
  };
  // Construct the default-agent adapter WITHOUT registering it: §5.6 forbids
  // pre-registering a transport edge for the default agentName when no enabled
  // record has been seen yet. Restore (enabled record) and bind register it.
  const feishuAdapter = getOrCreateFeishuAdapter(input.agentName, {
    register: false,
  });
  const defaultFeishuDownloader = feishuAdapter.buildAttachmentDownloader(
    input.dataDir,
  );
  const feishuWebhookDownloader: import("../channels/feishu.js").FeishuAttachmentDownloader =
    async ({ messageId, fileKey, type, sessionId }) => {
      const a = await defaultFeishuDownloader({
        messageId,
        ref: { type, key: fileKey },
        sessionId,
      });
      return a.filePath;
    };
  const feishuWebhookQuotedMessageResolver: FeishuQuotedMessageResolver =
    async ({ threadId, envelope }) =>
      getOrCreateFeishuAdapter(
        envelope.ctx.clientName || input.agentName,
      ).resolveQuotedMessageByThreadId(threadId);
  const feishuBotNameResolver: FeishuBotNameResolver = async (record) =>
    getOrCreateFeishuAdapter(
      record.agentName || input.agentName,
    ).resolveBotName(record);
  const startFeishuWs = async (
    agentName = input.agentName,
  ): Promise<boolean> => {
    if (!feishuWsEnabled) {
      logger.info(
        { agentName, platform: "feishu" },
        "Feishu WS start skipped: ws disabled",
      );
      return false;
    }
    logger.info({ agentName, platform: "feishu" }, "Feishu WS start requested");
    const started =
      await getOrCreateFeishuAdapter(agentName).startWebSocket(
        makeFeishuWsInput(),
      );
    logger.info(
      { agentName, started, platform: "feishu" },
      "Feishu WS start finished",
    );
    return started;
  };
  const feishu = new LocalFeishuChannelApi(
    feishuStore,
    input.runner,
    input.agentName,
    input.ownerStore,
    feishuWebhookDownloader,
    (record) => {
      // The legacy API owns the bind ingress, while this host owns the
      // concrete SDK/fetch wiring. Re-register the exact edge here so a
      // successful rebind cannot retain the API's unconfigured direct client
      // (and test injection follows the same production path).
      registerFeishuClient(record);
      void startFeishuWs(record.agentName).catch((err: unknown) => {
        const code =
          err && typeof err === "object"
            ? (err as NodeJS.ErrnoException).code
            : undefined;
        logger.error(
          {
            agentName: record.agentName,
            errorName: err instanceof Error ? err.name : typeof err,
            ...(typeof code === "string" ? { code } : {}),
            platform: "feishu",
          },
          "Feishu bind WS start failed",
        );
      });
    },
    feishuPendingThinkingCards,
    ({ chatId, request, messageId, clientName }) => {
      feishuPendingQuestionnaires.set(request.id, {
        request,
        clientName,
        chatId,
        messageId,
        createdAtMs: input.nowMs(),
      });
      logger.info(
        { requestId: request.id, messageId, source: "client" },
        "Feishu questionnaire rendered",
      );
    },
    feishuWebhookQuotedMessageResolver,
    feishuBotNameResolver,
    // Every exact unbind removes its live adapter + exact runner edge. Do not
    // create an adapter here: a missing adapter is already fully unbound.
    unregisterFeishuEdge,
    // Live WS transport status provider — mirrors the teardown hook above:
    // resolved per concrete agentName so status/list can report *this*
    // binding's in-memory `wsStatus` instead of only the persisted record.
    (agentName: string) => getOrCreateFeishuAdapter(agentName).getWsStatus(),
    // Shared pending 👀 ack-reaction store so clients registered by the API
    // itself (bind-time re-registration) also revoke the ack on delivery.
    feishuPendingReactions,
  );
  // NOTE: `feishu.registerClient()` used to run here for the default agentName.
  // §5.6 makes outbound client registration lazy: an enabled persisted record
  // registers its exact client through `restoreInboundLoops`, and a fresh bind
  // registers through `onBindingChanged` / the API's own `registerClient`.
  // Pre-registering for `input.agentName` would keep a client alive for an
  // agent whose credential is disabled (or whose family lost the winner).
  // NOTE: eager `void startFeishuWs()` used to sit here as the primary boot
  // path, hardcoded to `input.agentName` (usually the default agent — e.g.
  // `mavis`). It was made redundant once `restartInboundLoops()` below
  // was introduced: restore now enumerates every persisted binding and
  // dispatches `startFeishuWs(record.agentName)` per record — including
  // agents whose name differs from `input.agentName` (e.g. a user with
  // `agentName: main` on disk). Keeping the eager call around made two
  // things worse:
  //   1. When `input.agentName` didn't match any bound agentName it would
  //      produce a misleading `Feishu WS start skipped {hasRecord:false}`
  //      log line even though the store DID have a valid binding under a
  //      different agentName, muddying diagnostics of "why didn't WS start".
  //   2. When it DID match, restore would re-fire the same request in the
  //      same tick — idempotent (the adapter dedups), but it also created
  //      a phantom `feishu:<input.agentName>` adapter for the mismatched
  //      case, which stays live in the adapter map with no owning binding.
  // Restore is now the sole entrypoint; bind-time uses `onBindingChanged`,
  // desktop-restart uses `restartInboundLoops`. See fix/feishu-store-load-race.
  // MR-B: hoist the Telegram store so the legacy `LocalTelegramChannelApi`
  // and the new unified `TelegramPlatformAdapter` share a single binding
  // source of truth. Reaching into `LocalTelegramChannelApi['store']` is
  // intentionally avoided — `store` is a private field.
  const telegramStore =
    input.stores.telegram ??
    new LocalTelegramChannelStore(input.dataDir, input.nowMs);
  const telegramAdapters = new Map<string, TelegramPlatformAdapter>();
  const unregisterTelegramEdge = (agentName: string): void => {
    const clientId = telegramClientId(agentName);
    telegramAdapters.get(clientId)?.shutdown();
    input.runner.clients.unregister(clientId);
    input.adapterRegistry?.unregister("telegram", clientId);
  };
  let telegramApi: LocalTelegramChannelApi | undefined;
  const createTelegramSender =
    channelFetch === undefined
      ? undefined
      : (botToken: string) =>
          new TelegramSender(botToken, { fetcher: channelFetch });
  const createTelegramDownloader =
    channelFetch === undefined
      ? undefined
      : (downloaderInput: { botToken: string; scopeDirName: string }) =>
          new TelegramAttachmentDownloader({
            botToken: downloaderInput.botToken,
            dataDir: () => telegramStore.getDataDir(),
            scopeDirName: downloaderInput.scopeDirName,
            fetcher: channelFetch,
          });
  const getOrCreateTelegramAdapter = (
    agentName: string,
    options?: { register?: boolean },
  ): TelegramPlatformAdapter => {
    const clientName = telegramClientId(agentName);
    const register = options?.register !== false;
    const existing = telegramAdapters.get(clientName);
    if (existing) {
      if (register) input.adapterRegistry?.register(existing);
      return existing;
    }
    const adapter = new TelegramPlatformAdapter({
      store: telegramStore,
      defaultAgentName: agentName,
      clientName,
      ownerStore: input.ownerStore,
      onUnbind: unregisterTelegramEdge,
      // Bind the runner so bind() can start the Bot API long-poll and
      // every inbound `Update` flows into runner.dispatchInbound. Without
      // this the adapter's `startPollerBestEffort` no-ops on the missing
      // dispatcher and Telegram inbound stays dark in production.
      dispatchInbound: (message) =>
        input.runner.dispatchInbound(message as never),
      onBindingChanged: (record) => telegramApi?.registerClient(record),
      ...(input.telegramTokenVerifyFetcher || channelFetch
        ? {
            tokenVerifyFetcher:
              input.telegramTokenVerifyFetcher ?? channelFetch,
          }
        : {}),
      ...(createTelegramSender ? { senderFactory: createTelegramSender } : {}),
      ...(createTelegramDownloader
        ? { downloaderFactory: createTelegramDownloader }
        : {}),
      ...(channelFetch ? { pollerFetcher: channelFetch } : {}),
    });
    telegramAdapters.set(clientName, adapter);
    if (register) input.adapterRegistry?.register(adapter);
    // First-time creation of a per-agent Telegram adapter — the only place one
    // lands in the shared registry. Covers all three registration paths
    // (startup eager for the default agent, restore of an already-bound agent,
    // and first-bind self-heal via `ensureAdapterForAgent`) so "was this
    // agent's adapter ever registered, and when" is answerable from logs.
    // Fires exactly once per clientName — the cache-hit branch above returns
    // early, so a miss that still leaves the registry short would show up as a
    // single registration line followed by repeated `source:'ensured'` binds.
    logger.info(
      {
        agentName,
        clientName,
        registered: register,
        registeredCount: input.adapterRegistry?.list("telegram").length,
      },
      "Telegram adapter created and registered",
    );
    return adapter;
  };
  // Create the unified adapter FIRST so the legacy outbound client can delegate
  // questionnaire delivery to it. Pending asks are recorded on this instance
  // and the SAME instance is registered in the adapter registry, so outbound
  // questionnaire rendering and inbound callback_query decoding share one
  // `pendingByChat` — mirrors the WeChat adapter wiring. Newer dev also keeps
  // one adapter per bound agent; the legacy client resolves the matching
  // per-agent adapter via `adapterForAgent` below.
  const telegramAdapter = getOrCreateTelegramAdapter(input.agentName, {
    register: false,
  });
  const telegram = new LocalTelegramChannelApi(
    telegramStore,
    input.runner,
    input.agentName,
    input.ownerStore,
    {
      adapter: telegramAdapter,
      adapterForAgent: getOrCreateTelegramAdapter,
      onUnbind: unregisterTelegramEdge,
      ...(input.telegramTokenVerifyFetcher || channelFetch
        ? {
            tokenVerifyFetcher:
              input.telegramTokenVerifyFetcher ?? channelFetch,
          }
        : {}),
      ...(createTelegramSender ? { senderFactory: createTelegramSender } : {}),
      ...(createTelegramDownloader
        ? { downloaderFactory: createTelegramDownloader }
        : {}),
    },
  );
  telegramApi = telegram;
  // §5.6: no construction-time `telegram.registerClient()` for the default
  // agentName. The exact client is registered by restore (enabled record) or
  // by bind (`onBindingChanged`), never speculatively.
  const wechatStore =
    input.stores.wechat ??
    new LocalWeChatChannelStore(input.dataDir, input.nowMs);
  const wechatAdapters = new Map<string, LocalWeChatChannelAdapter>();
  const registerWeChatEdge = (adapter: LocalWeChatChannelAdapter): void => {
    input.adapterRegistry?.register(adapter);
    input.runner.clients.registerExact(
      new LocalWeChatChannelClient(input.runner.outboundStore, adapter),
    );
  };
  const getOrCreateWeChatAdapter = (
    agentName: string,
    options?: { register?: boolean },
  ): LocalWeChatChannelAdapter => {
    const clientName = wechatClientId(agentName);
    const register = options?.register !== false;
    const existing = wechatAdapters.get(clientName);
    if (existing) {
      if (register) registerWeChatEdge(existing);
      return existing;
    }
    const adapter = new LocalWeChatChannelAdapter({
      clientName,
      agentName,
      store: wechatStore,
      runner: input.runner,
      sdk: input.wechatRuntimeSdk ?? stubWeChatRuntimeSdk,
    });
    wechatAdapters.set(clientName, adapter);
    if (register) registerWeChatEdge(adapter);
    return adapter;
  };
  // Constructed lazily per bound agent (§5.6): no default-agent adapter is
  // created or registered at construction time.
  const wechat = new LocalWeChatChannelApi(
    wechatStore,
    input.runner,
    input.agentName,
    input.makeId,
    input.ownerStore,
    input.wechatOnboardFetcher ?? channelFetch,
    // Start the iLink monitor the instant the user finishes scanning. If it
    // cannot start, remove the just-created exact edge and surface the stable
    // 503 contract instead of reporting a bound-but-dark channel.
    async (agentName) => {
      const clientId = wechatClientId(agentName);
      const adapter = getOrCreateWeChatAdapter(agentName);
      try {
        await adapter.ensureMonitorRunning();
      } catch {
        // A real QR credential without a running monitor is not a bound
        // channel. Persist the rollback before removing its runtime edges so
        // a later startBind cannot short-circuit it as confirmed.
        await wechatStore.setEnabled(agentName, false);
        adapter.shutdown();
        input.runner.clients.unregister(clientId);
        input.adapterRegistry?.unregister("wechat", clientId);
        throw new LocalAgentContractError(
          503,
          "Channel transport could not be started",
          "CHANNEL_START_FAILED",
        );
      }
    },
    // Live health probe: status reflects iLink long-poll health, not just binding existence.
    (agentName) =>
      wechatAdapters.get(wechatClientId(agentName))?.monitorHealth(),
    // Tear down the exact runtime edge before deleting its binding. Family
    // cleanup also unregisters its winner/legacy edge, but a regular exact
    // unbind does not go through that reconciler path. Leaving the client in
    // either registry made a same-name rebind look successful while outbound
    // still targeted the stale adapter.
    (agentName) => {
      const clientId = wechatClientId(agentName);
      wechatAdapters.get(clientId)?.shutdown();
      input.runner.clients.unregister(clientId);
      input.adapterRegistry?.unregister("wechat", clientId);
    },
  );
  // §5.6: the default adapter is NOT wired into an outbound client here.
  // `wechat.registerClient(adapter)` used to run at construction for
  // `input.agentName`; a disabled or non-winner record would then keep a live
  // outbound edge. Restore registers the exact client for every enabled record,
  // and `ensureMonitorRunning` does the same right after a successful scan.
  // Restore exact clients for every already-bound agent, then resume inbound
  // loops only when startup execution permits it. A quarantined clone still
  // needs correct per-agent outbound routing, but copied bindings must not
  // restart WS, pollers, or monitors.
  const runRestoreInboundLoops = (): Promise<void> =>
    restoreInboundLoops({
      feishuStore,
      telegramStore,
      wechatStore,
      registerFeishuClient,
      registerTelegramClient: (record) => telegram.registerClient(record),
      startFeishuWs,
      getOrCreateFeishuAdapter,
      getOrCreateTelegramAdapter,
      getOrCreateWeChatAdapter,
      startInboundLoops: input.restoreInboundLoops !== false,
      clientRegistry: input.runner.clients,
      ...(input.adapterRegistry
        ? { adapterRegistry: input.adapterRegistry }
        : {}),
      ...(input.resolveAgentReadScope
        ? { resolveAgentReadScope: input.resolveAgentReadScope }
        : {}),
      ...(input.accessControlStore
        ? { accessControlStore: input.accessControlStore }
        : {}),
    });
  /**
   * Bring ONE record online. Mirrors the per-record gates of the restore pass
   * (`enabled` → mode → connectivity → credentials) so the reconciler's winner
   * and a cold-start restore can never disagree about what may start.
   */
  const startPlatformTransport = async (
    platform: ChannelPlatform,
    agentName: string,
  ): Promise<void> => {
    const startFailed = (): LocalAgentContractError =>
      new LocalAgentContractError(
        503,
        "Channel transport could not be started",
        "CHANNEL_START_FAILED",
      );
    const quarantined = input.restoreInboundLoops === false;
    if (platform === "feishu") {
      const record = await feishuStore.get(agentName);
      if (!record?.enabled) {
        logger.info(
          { agentName, platform },
          "Channel winner start skipped: record disabled",
        );
        return;
      }
      registerFeishuClient(record);
      getOrCreateFeishuAdapter(record.agentName);
      if (quarantined || record.mode !== "websocket" || !record.connected) {
        logger.info(
          { agentName, platform, mode: record.mode },
          "Channel winner inbound not started",
        );
        return;
      }
      try {
        if (!(await startFeishuWs(record.agentName))) throw startFailed();
      } catch {
        throw startFailed();
      }
      return;
    }
    if (platform === "telegram") {
      const record = await telegramStore.get(agentName);
      if (!record?.enabled) {
        logger.info(
          { agentName, platform },
          "Channel winner start skipped: record disabled",
        );
        return;
      }
      telegram.registerClient(record);
      if (
        quarantined ||
        record.mode !== "sdk" ||
        !record.botToken ||
        record.botToken.startsWith("pending:")
      ) {
        logger.info(
          { agentName, platform, mode: record.mode },
          "Channel winner inbound not started",
        );
        return;
      }
      try {
        if (
          !(await getOrCreateTelegramAdapter(record.agentName).startPoller(
            record.botToken,
          ))
        ) {
          throw startFailed();
        }
      } catch {
        throw startFailed();
      }
      return;
    }
    const record = await wechatStore.get(agentName);
    if (
      !record?.enabled ||
      quarantined ||
      record.mode !== "polling" ||
      !record.connected ||
      !record.botToken ||
      record.botToken.startsWith("pending:")
    ) {
      logger.info(
        { agentName, platform, mode: record?.mode },
        "Channel winner inbound not started",
      );
      return;
    }
    // Do not construct/register the adapter until every real credential gate
    // passed. In particular a pending QR must have no exact outbound edge.
    const adapter = getOrCreateWeChatAdapter(record.agentName);
    try {
      if (!(await adapter.startMonitor())) throw startFailed();
    } catch {
      throw startFailed();
    }
  };
  /** Stop ONE agent's transport through the platform's existing teardown. */
  const teardownPlatformTransport = async (
    platform: ChannelPlatform,
    agentName: string,
  ): Promise<void> => {
    // `register: false`: tearing a loser down must not create a registry entry
    // for the very transport edge we are removing.
    if (platform === "feishu") {
      getOrCreateFeishuAdapter(agentName, {
        register: false,
      }).invalidateTransport();
      return;
    }
    if (platform === "telegram") {
      getOrCreateTelegramAdapter(agentName, { register: false }).shutdown();
      return;
    }
    getOrCreateWeChatAdapter(agentName, { register: false }).shutdown();
    return Promise.resolve();
  };
  // With `deferChannelStartup`, construction touches no transport at all and
  // `channelRestoreReady` settles with the FIRST restore the owner runs (the
  // single pass inside `startChannelSubsystem()`), not with a construction-time
  // pass. Standalone V1 keeps starting here.
  let settleRestoreReady: ((error?: unknown) => void) | undefined;
  const restartInboundLoops = async (): Promise<void> => {
    try {
      await runRestoreInboundLoops();
    } catch (err) {
      settleRestoreReady?.(err);
      settleRestoreReady = undefined;
      throw err;
    }
    settleRestoreReady?.();
    settleRestoreReady = undefined;
  };
  const channelRestoreReady = input.deferChannelStartup
    ? new Promise<void>((resolve, reject) => {
        settleRestoreReady = (error?: unknown) =>
          error === undefined ? resolve() : reject(error);
      })
    : restartInboundLoops();
  // The deferred owner observes a startup failure through its own
  // `startChannelSubsystem()` promise; keeping this one marked handled avoids
  // reporting the same failure a second time as an unhandled rejection.
  void channelRestoreReady.catch(() => undefined);

  // C8: defence-in-depth binding gate. `dispatchInbound` consults this before
  // any processing and drops inbound whose `(agentName × platform)` binding is
  // gone. All three stores are the SAME instances the bind/unbind APIs mutate,
  // so a just-unbound agent's next inbound is discarded even if its transport
  // teardown lost a race.
  //
  // The gate only enforces for inbound that arrived under the canonical
  // managed clientName for its platform (what the real WS / poll / monitor /
  // webhook sources always set). Unrecognized client ids remain outside this
  // binding gate; outbound delivery still requires an exact registered client.
  input.runner.hasActiveChannelBinding = async (ctx) => {
    const agentName = agentNameFromClientName(
      ctx.platform,
      ctx.clientName,
      input.agentName,
    );
    switch (ctx.platform) {
      case "feishu":
        if (ctx.clientName !== feishuClientId(agentName)) return true;
        return Boolean((await feishuStore.get(agentName))?.enabled);
      case "telegram":
        if (ctx.clientName !== telegramClientId(agentName)) return true;
        return Boolean((await telegramStore.get(agentName))?.enabled);
      case "wechat":
        if (ctx.clientName !== wechatClientId(agentName)) return true;
        {
          const record = await wechatStore.get(agentName);
          return Boolean(
            record?.enabled &&
              record.connected &&
              record.mode === "polling" &&
              record.botToken &&
              !record.botToken.startsWith("pending:"),
          );
        }
      default:
        return true;
    }
  };
  return {
    feishu,
    feishuStore,
    feishuAdapter,
    feishuPendingQuestionnaires,
    feishuPendingPermissions,
    telegram,
    telegramStore,
    wechat,
    wechatStore,
    restartInboundLoops,
    startPlatformTransport,
    teardownPlatformTransport,
    channelRestoreReady,
  };
}

/**
 * Recover the bare agentName that the per-platform binding stores key on from
 * a runtime `ctx.clientName`. Telegram/WeChat clientNames carry a `telegram:` /
 * `wechat:` prefix (see `telegramClientId` / `wechatClientId`); Feishu uses the
 * bare agentName (`feishuClientId` is effectively identity). The stores re-apply
 * their own `xClientId` internally, so passing the bare agentName is required —
 * passing the prefixed clientName would double-prefix and miss the record.
 */
function agentNameFromClientName(
  platform: "feishu" | "telegram" | "wechat",
  clientName: string,
  fallbackAgentName: string,
): string {
  const prefix =
    platform === "telegram"
      ? "telegram:"
      : platform === "wechat"
        ? "wechat:"
        : "";
  const name =
    prefix && clientName.startsWith(prefix)
      ? clientName.slice(prefix.length)
      : clientName;
  return name.trim() || fallbackAgentName;
}
