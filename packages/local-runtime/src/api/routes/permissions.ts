import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type { LocalRuntimeConfig } from '../../config/types.js';
import type { LocalPermissionService } from '../../permissions/service.js';
import {
  LocalPermissionRuleError,
  LocalPermissionRuleStore,
  serializeLocalPermissionRule,
} from '../../permissions/rules.js';
import type { LocalSessionRecord } from '../../sessions/controller.js';
import {
  buildLocalPermissionRuleContents,
  json,
  localPermissionRuleToolName,
  makeId,
  notFound,
  readFirstString,
  readJsonBody,
  readPermissionDecision,
  readRecord,
  safeJsonStringify,
  type LocalPermissionDecision,
  type LocalPermissionRequest,
  type LocalPermissionRequestWaiter,
} from '../host-helpers.js';
import { readLocalPermissionMode } from '../host-helpers.js';
import type { MetricsClient } from '../../common/metrics.js';
import {
  emitAskReplyMetric,
  emitAskShownMetric,
  emitAskWaitMetric,
  emitPermissionRequestMetric,
} from './permission-metrics.js';
import {
  formatBlockedToolReason,
  snapshotPermissionInput,
  validatePermissionExecutionPlan,
  type ExecutionPlan,
} from '@mavis/permission';
import { logger } from '../../common/logger.js';
import type { ChannelPermissionOutboundPort } from '../../channels/permission-bridge.js';
import type { GlobalEventPublisher } from '../../events/global-events.js';
import type { LocalPermissionApprovalService } from '../local-permission-approval-service.js';
import { applyPermissionExecutionPlan } from './permission-rewrite.js';
import {
  buildPermissionToolDescription,
  type LocalPermissionRequestInput,
} from './permission-request-helpers.js';

export { applyPermissionExecutionPlan } from './permission-rewrite.js';

export interface LocalPermissionRouteContext {
  agentName: string;
  configGetter: () => LocalRuntimeConfig;
  nowMs: () => number;
  permissionRules: LocalPermissionRuleStore;
  permissionService: LocalPermissionService;
  approvalService: LocalPermissionApprovalService;
  publishGlobalEvent: GlobalEventPublisher;
  /**
   * Optional outbound hook that mirrors `permission.ask` to bound IM
   * conversations through the core `LocalChannelPermissionBridge`. Invoked
   * fire-and-forget at registration time: the bridge owns its own try/catch
   * so a platform render failure can never block (or fail) the permission
   * registration / wait flow.
   */
  channelPermissionOutbound?: ChannelPermissionOutboundPort;
  /** Optional metrics sink — see `permission-metrics.ts`. Absent = noop. */
  metricsClient?: MetricsClient;
}

export async function routeLocalPermissionApi(
  ctx: LocalPermissionRouteContext,
  method: string,
  request: Request,
  parts: string[],
  url: URL,
): Promise<Response> {
  try {
    if (method === 'GET' && parts[1] === 'rules') {
      const rules = await ctx.permissionRules.listRules({
        source: url.searchParams.get('source'),
        agentName: url.searchParams.get('agentName'),
        sessionId: url.searchParams.get('sessionId'),
      });
      return json({
        rules: rules.map(serializeLocalPermissionRule),
        mode: readLocalPermissionMode(ctx.configGetter().permissionMode),
      });
    }
    if (method === 'POST' && parts[1] === 'check') {
      const body = await readJsonBody(request);
      const toolName = readFirstString(body, ['tool_name', 'toolName']);
      if (!toolName) return json({ error: 'Missing tool_name' }, { status: 400 });
      const input = readRecord(body.input);
      const sessionId = readFirstString(body, ['session_id', 'sessionId']);
      const agentName = readFirstString(body, ['agent_name', 'agentName']);
      const permissionMode = readLocalPermissionMode(ctx.configGetter().permissionMode);
      // Decision brain: ported agent-core PermissionService.
      const decision = await ctx.permissionService.checkPermission({
        toolName,
        input,
        agentName,
        sessionId,
        permissionModeOverride: permissionMode,
      });
      if (decision.behavior === 'deny') {
        return json({ behavior: 'deny', reason: decision.reason });
      }
      if (decision.behavior === 'allow') {
        return json({ behavior: 'allow', reason: decision.reason });
      }
      // ask: register a local pending request (local ask-UI owns the flow).
      if (decision.behavior === 'ask' && sessionId) {
        const pending = ctx.approvalService.begin({
          sessionId,
          agentName: agentName ?? ctx.agentName,
          turnId: readFirstString(body, ['turn_id', 'turnId']) ?? makeId('turn'),
          toolName,
          toolInput: safeJsonStringify(input),
          toolDescription: buildPermissionToolDescription(input),
          ruleContents: decision.ruleContents ?? buildLocalPermissionRuleContents(toolName, input),
          persistWholeToolRuleOnReply: true,
          reason: decision.reason,
        });
        return json({
          behavior: 'ask',
          reason: decision.reason,
          requestId: pending.requestId,
          request_id: pending.requestId,
        });
      }
      return json({ behavior: decision.behavior, reason: decision.reason });
    }
    if (method === 'POST' && parts[1] === 'update') {
      await ctx.permissionRules.applyUpdate(await readJsonBody(request));
      return json({ success: true });
    }
  } catch (err) {
    if (err instanceof LocalPermissionRuleError) {
      return json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  if (method === 'GET' && parts[1] === 'requests') {
    return json({
      requests: ctx.approvalService.listPending(),
    });
  }
  if (method === 'DELETE' && parts[1] === 'requests' && parts[2]) {
    ctx.approvalService.dismiss(parts[2]);
    return json({ success: true });
  }
  if (method === 'POST' && parts[1] === 'batch-reply') {
    const body = await readJsonBody(request);
    const decision = readPermissionDecision(body);
    if (!decision) {
      return json(
        { error: 'Invalid permission decision; expected allowAlways, allowOnce, or deny.' },
        { status: 400 },
      );
    }
    const requestIds = Array.isArray(body.requestIds) ? body.requestIds.filter(isString) : [];
    // Per-item permission.processed / permission.skipped logs are emitted inside
    // replyLocalPermissionRequests below (higher fidelity than a summary line).
    const { processed, skipped } = await replyLocalPermissionRequests(ctx, requestIds, decision);
    return json({ processed, skipped });
  }
  return notFound(`/permission/${parts.slice(1).join('/')}`);
}

export async function replyLocalPermissionRequests(
  ctx: LocalPermissionRouteContext,
  requestIds: string[],
  decision: LocalPermissionDecision,
): Promise<{ processed: string[]; skipped: string[] }> {
  return ctx.approvalService.reply(requestIds, decision);
}

export async function beforeLocalToolCall(
  ctx: LocalPermissionRouteContext,
  session: LocalSessionRecord,
  turnId: string,
  toolContext: BeforeToolCallContext,
  signal?: AbortSignal,
): Promise<{ block: true; reason: string } | undefined> {
  const toolName = toolContext.toolCall.name;
  const toolArgs = snapshotPermissionInput(readRecord(toolContext.args));
  const permissionMode = readLocalPermissionMode(ctx.configGetter().permissionMode);
  if (isBuiltinMcpToolSource(toolContext.toolCall)) return undefined;

  // Decision brain: ported agent-core PermissionService (deterministic HARD/
  // SOFT regex + engine + auto-mode cloud classifier). The local-runtime keeps
  // owning the ask-UI flow below.
  const decision = await ctx.permissionService.checkPermission({
    toolName,
    input: toolArgs,
    agentName: session.agentName,
    sessionId: session.sessionId,
    permissionModeOverride: permissionMode,
  });
  const executionPlan = readDecisionExecutionPlan(decision, toolArgs);
  if (permissionMode !== 'off') {
    emitPermissionRequestMetric(ctx.metricsClient, permissionMode, decision.behavior);
  }
  if (decision.behavior === 'deny') {
    logPermissionEnforcement(session.sessionId, turnId, toolContext, toolName, {
      policy_behavior: 'deny',
      gate_result: 'blocked',
      decision_source: 'policy',
      rewrite_applied: false,
    });
    return {
      block: true,
      reason: formatBlockedToolReason({
        source: decision.denySource ?? 'safety',
        toolName,
        detail: decision.reason,
      }),
    };
  }
  if (decision.behavior === 'allow') {
    // The validated plan is the only execution-input source. In particular,
    // recoverable deletes must apply its mavis-trash effective input rather
    // than falling back to the original rm command.
    applyPermissionExecutionPlan(toolContext, executionPlan);
    logPermissionEnforcement(session.sessionId, turnId, toolContext, toolName, {
      policy_behavior: 'allow',
      gate_result: 'proceed',
      decision_source: 'policy',
      rewrite_applied: Boolean(executionPlan?.transforms.length),
      execution_plan_present: Boolean(executionPlan),
      transform_count: executionPlan?.transforms.length ?? 0,
    });
    return undefined;
  }

  const userDecision = await ctx.approvalService.begin(
    {
      sessionId: session.sessionId,
      agentName: session.agentName,
      turnId,
      toolName,
      toolInput: safeJsonStringify(toolArgs),
      toolDescription: buildPermissionToolDescription(toolArgs),
      ruleContents: decision.ruleContents ?? buildLocalPermissionRuleContents(toolName, toolArgs),
      ...(decision.ruleMatchers ? { ruleMatchers: decision.ruleMatchers } : {}),
      persistWholeToolRuleOnReply: true,
      reason: decision.reason,
    },
    signal,
  ).promise;
  if (userDecision === 'allowOnce' || userDecision === 'allowAlways') {
    // Approval changes only whether execution may continue; it must not
    // replace or recompute the decision-time execution plan.
    applyPermissionExecutionPlan(toolContext, executionPlan);
    logPermissionEnforcement(session.sessionId, turnId, toolContext, toolName, {
      policy_behavior: 'ask',
      gate_result: 'proceed',
      decision_source: 'user_reply',
      approval_decision: userDecision,
      rewrite_applied: Boolean(executionPlan?.transforms.length),
      execution_plan_present: Boolean(executionPlan),
      transform_count: executionPlan?.transforms.length ?? 0,
    });
    return undefined;
  }
  logPermissionEnforcement(session.sessionId, turnId, toolContext, toolName, {
    policy_behavior: 'ask',
    gate_result: 'blocked',
    decision_source: 'approval_or_abort',
    approval_decision: userDecision,
    rewrite_applied: false,
  });
  return {
    block: true,
    reason: formatBlockedToolReason({
      source: 'user',
      toolName,
      // `decision.reason` is the (localized) reason the confirmation was
      // raised — original safety text, or the auto-classifier's cloud verdict
      // in auto mode. Carry it so the model knows what the user vetoed.
      trigger: decision.reason,
    }),
  };
}

function readDecisionExecutionPlan(
  decision: Awaited<ReturnType<LocalPermissionService['checkPermission']>>,
  originalInput: Readonly<Record<string, unknown>>,
): Readonly<ExecutionPlan> | undefined {
  if (decision.behavior === 'deny') return undefined;
  if (!decision.executionPlan) {
    if (decision.rewrittenInput) {
      throw new TypeError('Permission decision rewrite is missing its execution plan.');
    }
    return undefined;
  }
  return validatePermissionExecutionPlan(decision.executionPlan, originalInput);
}

function logPermissionEnforcement(
  sessionId: string,
  turnId: string,
  toolContext: BeforeToolCallContext,
  toolName: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  const toolCallId =
    toolContext.toolCall && typeof toolContext.toolCall === 'object'
      ? Reflect.get(toolContext.toolCall, 'id')
      : undefined;
  logger.info(
    {
      session_id: sessionId,
      turn_id: turnId,
      ...(typeof toolCallId === 'string' && toolCallId ? { tool_call_id: toolCallId } : {}),
      tool_name: toolName,
      ...fields,
    },
    'permission.enforcement',
  );
}

function isBuiltinMcpToolSource(toolCall: unknown): boolean {
  if (!toolCall || typeof toolCall !== 'object') return false;
  const source = (toolCall as { source?: unknown }).source;
  return source === 'builtin' || source === 'builtin-matrix';
}

export function abortLocalPermissionRequests(
  ctx: LocalPermissionRouteContext,
  sessionId: string,
): void {
  ctx.approvalService.abortSession(sessionId);
}

/** Hosted-v2 approval port over the shared local approval service. */
export function requestLocalPermissionApproval(
  ctx: LocalPermissionRouteContext,
  input: LocalPermissionRequestInput,
  signal?: AbortSignal,
): Promise<LocalPermissionDecision> {
  return ctx.approvalService.begin(input, signal).promise;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
