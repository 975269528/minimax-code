import type {
  LocalAskUserAdapter,
  LocalAskUserBeginResult,
  LocalRuntimeToolContext,
} from '@mavis/agent-tools/desktop';
import type { AskUserToolInput } from '@mavis/shared/questionnaire';

import {
  LocalQuestionnaireService,
  type LocalQuestionnaireServiceDeps,
} from '../questionnaire/service.js';

export function buildLocalAskUserAdapter(
  ctx: LocalQuestionnaireServiceDeps | undefined,
): LocalAskUserAdapter | undefined {
  if (!ctx || ctx.configGetter().askUser?.enabled === false) return undefined;
  return {
    begin: async (toolCtx, toolInput, signal) =>
      beginLocalAskUserQuestionnaire(ctx, toolCtx, toolInput, signal),
  };
}

async function beginLocalAskUserQuestionnaire(
  ctx: LocalQuestionnaireServiceDeps,
  toolCtx: LocalRuntimeToolContext,
  toolInput: AskUserToolInput,
  signal?: AbortSignal,
): Promise<LocalAskUserBeginResult> {
  if (signal?.aborted) throw new Error('Operation aborted');
  const mode = toolInput.mode ?? 'questionnaire';
  if (mode === 'questionnaire' && (await hasPendingUserSteering(ctx, toolCtx.sessionId))) {
    // Decision v3: suppress before any record or event exists so the UI has
    // nothing to render and no dangling questionnaire can wedge the session.
    // Consent prompts (feature-enable) and owned modes are never suppressed.
    return { suppressed: true, reason: 'user-steering-pending' };
  }
  try {
    const result = await new LocalQuestionnaireService(ctx).begin({
      sessionId: toolCtx.sessionId,
      agentName: toolCtx.agentName,
      runId: toolCtx.turnId,
      callId: toolCtx.toolCallId,
      ...(toolCtx.channelContext ? { originChannelContext: toolCtx.channelContext } : {}),
      toolInput,
    });
    return {
      requestId: result.requestId,
      schemaVersion: result.schemaVersion,
      stepCount: result.stepCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ask_user failed: ${message}`);
  }
}

async function hasPendingUserSteering(
  ctx: LocalQuestionnaireServiceDeps,
  sessionId: string,
): Promise<boolean> {
  const probe = ctx.hasPendingUserSteering;
  if (!probe) return false;
  try {
    return (await probe(sessionId)) === true;
  } catch {
    // Fail-open: a broken probe must never swallow a question aimed at the user.
    return false;
  }
}
