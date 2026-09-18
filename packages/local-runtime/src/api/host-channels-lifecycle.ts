import type { LocalChannelBridgeInfra, LocalChannelContext } from '../channels/infra.js';
import { LocalChannelRunner } from '../channels/runner.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';
import type { QuestionnaireReplyOutcome } from '../questionnaire/reply-outcome.js';
import type { RuntimeConversationChannelView } from '@mavis/conversation-contract';

export function createChannelRunner(input: {
  infra: LocalChannelBridgeInfra;
  dataDir: () => string;
  nowMs: () => number;
  makeId: (prefix: string) => string;
  conversation?: Pick<RuntimeConversationChannelView, 'ingress'>;
  getSessionById: (sessionId: string) => Promise<unknown>;
  getQueuedMessage?: (sessionId: string, queueItemId: string) => Promise<unknown>;
  runQueuedTurn?: (input: { session: unknown; queuedMessage: unknown }) => Promise<Response>;
  override?: LocalChannelRunner;
  /**
   * Optional questionnaire reply forwarder — runner calls this before the
   * normal inbound flow when an adapter's `tryHandleQuestionnaireReply`
   * matches the inbound to a pending ask. Hot path for WeChat
   * numbered-text replies and Telegram callback_query questionnaire
   * answers.
   */
  questionnaireReplyHandler?: (input: {
    ctx: LocalChannelContext;
    reply: import('@mavis/shared/questionnaire').AskQuestionnaireReplyPayload;
  }) => Promise<QuestionnaireReplyOutcome | void>;
  /**
   * Optional permission reply resolver — runner asks this BEFORE the
   * questionnaire interception whether the raw inbound event resolves a
   * pending permission ask. Wired to
   * `LocalChannelPermissionBridge.tryPermissionReply` (consume-once).
   */
  tryPermissionReply?: (
    ctx: LocalChannelContext,
    raw: unknown,
  ) => Promise<import('../channels/permission-bridge.js').ChannelPermissionReplyMatch | null>;
  /**
   * Optional permission reply forwarder — runner calls this on a
   * `tryPermissionReply` hit so the decoded IM decision settles the pending
   * request through `applyPermissionReply` → `replyLocalPermissionRequests`.
   */
  permissionReplyHandler?: (input: {
    ctx: LocalChannelContext;
    requestId: string;
    behavior: import('../channels/permission-bridge.js').ChannelPermissionBehavior;
  }) => Promise<void>;
  /**
   * Optional channel-queue kick callback. When set, the runner replaces
   * its legacy "dispatch immediately" path with this callback for inbound
   * items that produced a `queueItemId`. See `LocalChannelRunnerOptions`
   * for the rationale.
   */
  kickChannelDrain?: (input: {
    ctx: LocalChannelContext;
    sessionId: string;
    queueItemId: string;
  }) => Promise<void>;
  /** Optional metrics reporter injected by the host. Absent → noop. */
  metricsReporter?: ModuleMetricsReporter;
}): LocalChannelRunner {
  if (input.override) return input.override;
  const opts: import('../channels/runner.js').LocalChannelRunnerOptions = {
    infra: input.infra,
    dataDir: input.dataDir,
    nowMs: input.nowMs,
    makeId: input.makeId,
    getSessionById: input.getSessionById as never,
    ...(input.conversation ? { conversation: input.conversation } : {}),
    ...(input.getQueuedMessage ? { getQueuedMessage: input.getQueuedMessage as never } : {}),
    ...(input.runQueuedTurn ? { runQueuedTurn: input.runQueuedTurn as never } : {}),
  };
  if (input.questionnaireReplyHandler)
    opts.questionnaireReplyHandler = input.questionnaireReplyHandler;
  if (input.tryPermissionReply) opts.tryPermissionReply = input.tryPermissionReply;
  if (input.permissionReplyHandler) opts.permissionReplyHandler = input.permissionReplyHandler;
  if (input.kickChannelDrain) opts.kickChannelDrain = input.kickChannelDrain;
  if (input.metricsReporter) opts.metrics = input.metricsReporter;
  return new LocalChannelRunner(opts);
}
