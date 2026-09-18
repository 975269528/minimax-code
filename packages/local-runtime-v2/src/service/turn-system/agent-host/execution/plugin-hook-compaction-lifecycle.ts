import type {
  PiBeforeLlmCallAppendMessage,
  PiBeforeLlmCallHook,
} from '@mavis/agent-core/pi-turn-runner';

import {
  emitLocalPluginHookWarnings,
  localPluginHookCoordinator as pluginHookCoordinator,
} from '../assembly/local-turn-plugin-hooks.js';
import type { LocalTurnExecutionInput } from '../runner/contracts.js';

export function withPluginAutomaticCompactionLifecycle(
  hook: PiBeforeLlmCallHook,
  input: LocalTurnExecutionInput,
): PiBeforeLlmCallHook {
  return async (hookInput) => {
    const decision = await hook(hookInput);
    if (
      decision?.type !== 'replaceMessages' ||
      !input.pluginHooks?.length ||
      !('compactionAttemptId' in decision.metadata)
    ) {
      return decision;
    }
    return {
      ...decision,
      afterCommit: () => finishAutomaticPluginCompaction(input, decision.metadata.summary),
    };
  };
}

async function finishAutomaticPluginCompaction(
  input: LocalTurnExecutionInput,
  summary: string,
): Promise<PiBeforeLlmCallAppendMessage | undefined> {
  pluginHookCoordinator.completeAutomaticCompaction(input.lease.sessionId);
  const postCompact = await runAutomaticPluginCompactionEvent(input, 'PostCompact', {
    trigger: 'auto',
    compact_summary: summary,
  });
  if (!postCompact) return undefined;
  if (hasAbortedHook(postCompact)) {
    markAutomaticCompactionForRetry(input);
    return undefined;
  }
  if (postCompact.decision.continue === false) {
    markAutomaticCompactionForRetry(input);
    throw new PluginHookStopRequestedError(
      postCompact.decision.stopReason ?? 'Turn stopped by PostCompact Plugin Hook.',
    );
  }
  const resumed = await runAutomaticPluginCompactionEvent(input, 'SessionStart', {
    source: 'compact',
  });
  if (!resumed) return undefined;
  if (hasAbortedHook(resumed)) {
    markAutomaticCompactionForRetry(input);
    return undefined;
  }
  if (resumed.decision.continue === false) {
    throw new PluginHookStopRequestedError(
      resumed.decision.stopReason ?? 'Turn stopped by SessionStart Plugin Hook.',
    );
  }
  const context = resumed.decision.additionalContext?.trim();
  return context
    ? {
        role: 'custom',
        customType: 'plugin_hook_context',
        content: `<plugin-hook-context>\n${context}\n</plugin-hook-context>`,
        display: false,
        timestamp: Date.now(),
      }
    : undefined;
}

async function runAutomaticPluginCompactionEvent(
  input: LocalTurnExecutionInput,
  event: 'PostCompact' | 'SessionStart',
  payload: Readonly<Record<string, unknown>>,
) {
  try {
    const result = await pluginHookCoordinator.runEvent(
      input.pluginHooks ?? [],
      {
        event,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        cwd: input.session.workspaceDir,
        ...input.pluginHookRuntimeContext,
        matcherValue: event === 'SessionStart' ? 'compact' : 'auto',
        payload,
      },
      input.lease.signal,
    );
    await emitLocalPluginHookWarnings({
      reporter: input.pluginHookEventReporter,
      sessionId: input.lease.sessionId,
      turnId: input.lease.turnId,
      event,
      result,
    });
    return result;
  } catch {
    markAutomaticCompactionForRetry(input);
    return undefined;
  }
}

function hasAbortedHook(
  result: Awaited<ReturnType<typeof pluginHookCoordinator.runEvent>>,
): boolean {
  const aborted = result.diagnostics.some((item) => item.code === 'HOOK_ABORTED');
  if (aborted) return true;
  return false;
}

function markAutomaticCompactionForRetry(input: LocalTurnExecutionInput): void {
  pluginHookCoordinator.markCompacted(input.lease.sessionId, input.pluginHooks ?? []);
}

class PluginHookStopRequestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginHookStopRequestedError';
  }
}
