import { describe, expect, it } from 'vitest';
import {
  createRunawayGuard,
  replayRunawayGuardTrajectory,
  type RunawayGuardObservation,
  type RunawayGuardReplayStep,
  type RunawayGuardRunIdentity,
  type RunawayGuardToolPolicy,
} from '../src/index.js';

const ctx: RunawayGuardRunIdentity = {
  sessionId: 'session-a',
  turnId: 'turn-a',
  agentName: 'mavis',
};

function step(index: number, kind: 'action' | 'error' | 'progress' = 'action'): RunawayGuardReplayStep {
  const toolCallId = `call-${index}`;
  return {
    message: {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: toolCallId,
        name: 'write',
        arguments: { attempt: kind === 'progress' ? index : 'same' },
      }],
      api: 'openai-completions',
      provider: 'test',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: 0,
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    toolResults: [{
      role: 'toolResult',
      toolCallId,
      toolName: 'write',
      content: [{ type: 'text', text: `result-${index}` }],
      isError: kind === 'error',
      ...(kind === 'error' ? { details: { errorCode: 'EACCES' } } : {}),
      timestamp: 0,
    }],
    ...(kind === 'progress' ? {
      verifiedProgress: [{
        toolCallId,
        loopKey: ['target.txt'],
        progressKey: 'same-content',
        artifactChanged: false,
      }],
    } : {}),
  };
}

interface TaskOutputCall {
  readonly id: string;
  readonly taskId: string;
  readonly status?: string;
  readonly nextOffset?: unknown;
  readonly resultTaskId?: string;
  readonly trusted?: boolean;
  readonly source?: 'builtin' | 'captured-compatibility';
  readonly isError?: boolean;
  readonly omitResult?: boolean;
  readonly omitDetails?: boolean;
}

function taskOutputStep(
  calls: readonly TaskOutputCall[],
  options: {
    readonly blockedToolCallIds?: readonly string[];
    readonly reverseResults?: boolean;
    readonly verifiedProgressCallIds?: readonly string[];
    readonly otherCalls?: readonly { readonly id: string; readonly name: string; readonly arguments?: unknown }[];
  } = {},
): RunawayGuardReplayStep {
  const results = calls.flatMap((call) => {
    if (call.omitResult) return [];
    return [{
      role: 'toolResult' as const,
      toolCallId: call.id,
      toolName: 'task_output',
      content: [],
      isError: call.isError ?? false,
      ...(call.omitDetails
        ? {}
        : {
            details: {
              task_id: call.resultTaskId ?? call.taskId,
              status: call.status ?? 'running',
              next_offset: call.nextOffset ?? 0,
            },
          }),
      timestamp: 0,
    }];
  });
  return {
    message: {
      role: 'assistant',
      content: [
        ...calls.map((call) => ({
          type: 'toolCall' as const,
          id: call.id,
          name: 'task_output',
          arguments: { task_id: call.taskId },
        })),
        ...(options.otherCalls ?? []).map((call) => ({
          type: 'toolCall' as const,
          id: call.id,
          name: call.name,
          arguments: call.arguments ?? {},
        })),
      ],
      api: 'openai-completions',
      provider: 'test',
      model: 'test',
      stopReason: 'toolUse',
      timestamp: 0,
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as never,
    toolResults: (options.reverseResults ? results.reverse() : results) as never,
    ...(calls.some((call) => call.trusted !== false)
      ? {
          trustedToolProvenance: calls.flatMap((call) =>
            call.trusted === false
              ? []
              : [{
                  toolCallId: call.id,
                  toolName: 'task_output',
                  source: call.source ?? 'builtin',
                }],
          ),
        }
      : {}),
    ...(options.blockedToolCallIds
      ? {
          blockedToolCalls: options.blockedToolCallIds.map((toolCallId) => ({
            toolCallId,
            blockedBy: 'permission' as const,
          })),
        }
      : {}),
    ...(options.verifiedProgressCallIds
      ? {
          verifiedProgress: options.verifiedProgressCallIds.map((toolCallId) => ({
            toolCallId,
            loopKey: ['host', toolCallId],
            progressKey: 'changed',
            artifactChanged: true,
          })),
        }
      : {}),
  };
}

const taskOutputPollingPolicy: RunawayGuardToolPolicy = {
  kind: 'polling',
  projectProgress(input) {
    const argumentsValue = input.arguments as { task_id?: unknown };
    const taskId = typeof argumentsValue.task_id === 'string' ? argumentsValue.task_id : undefined;
    if (!taskId) return undefined;
    const reset = () => ({
      loopKey: { taskId },
      progressKey: 'reset',
      polling: { mode: 'reset' as const },
    });
    const details = input.result?.details as Record<string, unknown> | undefined;
    if (!input.trustedToolProvenance) {
      return details && typeof details.status === 'string'
        ? {
            loopKey: { taskId },
            progressKey: { status: details.status, nextOffset: details.next_offset ?? null },
          }
        : undefined;
    }
    if (!input.result) return reset();
    if (input.result.toolName !== 'task_output') return undefined;
    if (typeof details?.task_id === 'string' && details.task_id !== taskId) return undefined;
    if (input.result.isError) return reset();
    if (
      !details ||
      details.task_id !== taskId ||
      (details.status !== 'queued' && details.status !== 'running') ||
      typeof details.next_offset !== 'number' ||
      !Number.isSafeInteger(details.next_offset) ||
      details.next_offset < 0
    ) {
      return reset();
    }
    return {
      loopKey: { taskId },
      progressKey: { status: details.status, nextOffset: details.next_offset },
      polling: { mode: 'continuous' as const, reminderEligible: true },
    };
  },
};

function taskOutputGuard(onSignal?: (value: RunawayGuardObservation) => void) {
  return createRunawayGuard({
    remindAfterOccurrences: 3,
    toolPolicies: { task_output: taskOutputPollingPolicy },
    ...(onSignal ? { onSignal } : {}),
  });
}

describe('Runaway Guard domain module', () => {
  it.each(['action', 'error', 'progress'] as const)(
    'excludes permission-blocked %s attempts and resets their streak without spending a reminder',
    (kind) => {
      const guard = createRunawayGuard({ remindAfterOccurrences: 3 });
      for (let index = 1; index <= 2; index += 1) {
        expect(guard.observe(ctx, step(index, kind), true)).toBeUndefined();
      }
      for (let index = 3; index <= 6; index += 1) {
        expect(
          guard.observe(
            ctx,
            {
              ...step(index, kind),
              blockedToolCalls: [{ toolCallId: `call-${index}`, blockedBy: 'permission' }],
            },
            true,
          ),
        ).toBeUndefined();
      }
      for (let index = 7; index <= 8; index += 1) {
        expect(guard.observe(ctx, step(index, kind), true)).toBeUndefined();
      }
      expect(guard.observe(ctx, step(9, kind), true)).toBeDefined();
      expect(guard.finishTurn(ctx)?.stepCount).toBe(9);
    },
  );

  it('filters only intercepted calls in a mixed batch, even with identical arguments', () => {
    const guard = createRunawayGuard({ remindAfterOccurrences: 3 });
    for (let index = 1; index <= 3; index += 1) {
      const blocked = step(index * 2, 'error');
      const executed = step(index * 2 + 1, 'error');
      if (blocked.message.role !== 'assistant' || executed.message.role !== 'assistant') {
        throw new Error('expected assistant fixture');
      }
      const reminder = guard.observe(
        ctx,
        {
          message: {
            ...executed.message,
            content: [...blocked.message.content, ...executed.message.content],
          },
          toolResults: [...blocked.toolResults, ...executed.toolResults],
          blockedToolCalls: [{ toolCallId: `call-${index * 2}`, blockedBy: 'permission' }],
        },
        true,
      );
      if (index < 3) expect(reminder).toBeUndefined();
      else expect(reminder?.observation.signalKind).toBe('same_error_family');
    }
  });

  it('does not trust tool output to declare a permission interception', () => {
    const guard = createRunawayGuard({ remindAfterOccurrences: 3 });
    for (let index = 1; index <= 3; index += 1) {
      const value = step(index, 'error');
      const reminder = guard.observe(
        ctx,
        {
          ...value,
          toolResults: value.toolResults.map((result) => ({
            ...result,
            content: [{ type: 'text', text: 'Permission denied by user for write: denied' }],
            details: {
              blockedBy: 'permission',
              blockedToolCalls: [{ toolCallId: result.toolCallId, blockedBy: 'permission' }],
            },
          })),
        },
        true,
      );
      if (index < 3) expect(reminder).toBeUndefined();
      else expect(reminder?.observation.signalKind).toBe('same_error_family');
    }
  });

  it('replays trusted permission facts without inferring them from historical error text', () => {
    const steps: RunawayGuardReplayStep[] = [1, 2, 3].map((index) => ({
      ...step(index, 'error'),
      blockedToolCalls: [{ toolCallId: `call-${index}`, blockedBy: 'permission' }],
    }));
    expect(replayRunawayGuardTrajectory({ ...ctx, steps }).observations).toEqual([]);
    expect(
      replayRunawayGuardTrajectory({
        ...ctx,
        steps: steps.map(({ blockedToolCalls: _blocked, ...value }) => value),
      }).observations.length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ['action', 'exact_action_repeat'],
    ['error', 'same_error_family'],
    ['progress', 'unchanged_progress_repeat'],
  ] as const)('returns a Turn-scoped, non-memory reminder for %s', (kind, signalKind) => {
    const observations: RunawayGuardObservation[] = [];
    const guard = createRunawayGuard({
      remindAfterOccurrences: 3,
      onSignal: (value) => { observations.push(value); },
    });
    expect(guard.observe(ctx, step(1, kind), true)).toBeUndefined();
    expect(guard.observe(ctx, step(2, kind), true)).toBeUndefined();
    const reminder = guard.observe(ctx, step(3, kind), true);
    expect(reminder?.observation).toMatchObject({
      ...ctx, signalKind, occurrences: 3, stepIndex: 3, action: 'steer',
    });
    expect(reminder?.content).toContain('temporary runtime reminder for the current Turn only');
    expect(reminder?.content).toContain('not a user preference or a durable rule');
    expect(reminder?.content).toContain('do not save this reminder or generalize it into Memory, Skills');
    expect(observations).toContainEqual(expect.objectContaining({
      signalKind, occurrences: 2, stepIndex: 2,
    }));
    guard.markReminderInjected(ctx);
    expect(guard.observe(ctx, step(4, kind), true)).toBeUndefined();
    expect(guard.finishTurn(ctx)?.reminderInjected).toBe(true);
  });

  it('reserves the one-shot before delivery and does not report an unacknowledged reminder as injected', () => {
    const guard = createRunawayGuard({ remindAfterOccurrences: 3 });
    for (let index = 1; index <= 2; index += 1) guard.observe(ctx, step(index), true);
    expect(guard.observe(ctx, step(3), true)).toBeDefined();
    guard.clearDetectionStreaks(ctx);
    for (let index = 4; index <= 6; index += 1) {
      expect(guard.observe(ctx, step(index), true)).toBeUndefined();
    }
    expect(guard.finishTurn(ctx)?.reminderInjected).toBe(false);
  });

  it('isolates sessions and Turns and releases state on finish', () => {
    const guard = createRunawayGuard({ remindAfterOccurrences: 3 });
    const otherSession = { ...ctx, sessionId: 'session-b' };
    const otherTurn = { ...ctx, turnId: 'turn-b' };
    for (let index = 1; index <= 2; index += 1) guard.observe(ctx, step(index), true);
    expect(guard.observe(otherSession, step(3), true)).toBeUndefined();
    expect(guard.observe(otherTurn, step(3), true)).toBeUndefined();
    expect(guard.observe(ctx, step(3), true)).toBeDefined();
    expect(guard.finishTurn(ctx)?.stepCount).toBe(3);
    expect(guard.finishTurn(ctx)).toBeUndefined();
    expect(guard.observe(ctx, step(4), true)).toBeUndefined();
    expect(guard.finishTurn(otherSession)?.stepCount).toBe(1);
    expect(guard.finishTurn(otherTurn)?.stepCount).toBe(1);
  });

  it('uses the same projection and observations for live Shadow and offline replay', () => {
    const observations: RunawayGuardObservation[] = [];
    const guard = createRunawayGuard({ onSignal: (value) => { observations.push(value); } });
    const steps = [step(1, 'error'), step(2, 'error'), step(3, 'error')];
    for (const value of steps) expect(guard.observe(ctx, value, true)).toBeUndefined();
    const replay = replayRunawayGuardTrajectory({ ...ctx, steps });
    expect(observations).toEqual(replay.observations);
    expect(guard.finishTurn(ctx)).toEqual(replay.summary);
  });

  it('does not let malformed progress suppress mechanical observations', () => {
    const observations: RunawayGuardObservation[] = [];
    const guard = createRunawayGuard({ onSignal: (value) => { observations.push(value); } });
    for (let index = 1; index <= 2; index += 1) {
      guard.observe(ctx, { ...step(index), verifiedProgress: {} as never }, false);
    }
    expect(observations).toContainEqual(expect.objectContaining({
      signalKind: 'exact_action_repeat', occurrences: 2,
    }));
  });
});

describe('trusted task_output polling in the shared Guard', () => {
  it('counts same-task reads across interleaved tasks and pairs reverse-order results by call id', () => {
    const guard = taskOutputGuard();
    const readBoth = (batch: number) => guard.observe(
      ctx,
      taskOutputStep([
        { id: `a-${batch}`, taskId: 'task-a' },
        { id: `b-${batch}`, taskId: 'task-b' },
      ], { reverseResults: true }),
      true,
    );

    expect(readBoth(1)).toBeUndefined();
    expect(readBoth(2)).toBeUndefined();
    const reminder = readBoth(3);

    expect(reminder?.observation).toMatchObject({ signalKind: 'polling_repeat', occurrences: 3 });
    expect(reminder?.content).toBe(`<system-reminder>
Three task_output reads for the same task have returned an unchanged status and output cursor. Avoid repeated polling; you will be notified automatically and this conversation will resume when the background task completes.
This reminder applies only to the current Turn. Do not save or generalize it into Memory, Skills, or other persistent instructions.
</system-reminder>`);
  });

  it('updates one task at a time inside a batch and rebuilds its baseline after changed output facts', () => {
    const guard = taskOutputGuard();

    expect(guard.observe(ctx, taskOutputStep([
      { id: 'same-1', taskId: 'task-a' },
      { id: 'same-2', taskId: 'task-a' },
      { id: 'same-3', taskId: 'task-a' },
    ], { reverseResults: true }), true)?.observation.signalKind).toBe('polling_repeat');

    const cursorGuard = taskOutputGuard();
    expect(cursorGuard.observe(ctx, taskOutputStep([{ id: 'cursor-1', taskId: 'task-a', nextOffset: 10 }]), true)).toBeUndefined();
    expect(cursorGuard.observe(ctx, taskOutputStep([{ id: 'cursor-2', taskId: 'task-a', nextOffset: 20 }]), true)).toBeUndefined();
    expect(cursorGuard.observe(ctx, taskOutputStep([{ id: 'cursor-3', taskId: 'task-a', nextOffset: 20 }]), true)).toBeUndefined();
    expect(cursorGuard.observe(ctx, taskOutputStep([{ id: 'cursor-4', taskId: 'task-a', nextOffset: 20 }]), true)?.observation.signalKind).toBe('polling_repeat');
  });

  it('keeps a qualified task through a text-only step', () => {
    const guard = taskOutputGuard();
    expect(guard.observe(ctx, taskOutputStep([{ id: 'text-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(guard.observe(ctx, {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will wait for the task.' }],
        api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'stop', timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } as never,
      toolResults: [],
    }, true)).toBeUndefined();
    expect(guard.observe(ctx, taskOutputStep([{ id: 'text-2', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(guard.observe(ctx, taskOutputStep([{ id: 'text-3', taskId: 'task-a' }]), true)?.observation.signalKind).toBe('polling_repeat');
  });

  it('does not qualify distinct tasks or observations without trusted execution provenance', () => {
    const distinct = taskOutputGuard();
    for (const taskId of ['task-a', 'task-b', 'task-c']) {
      expect(distinct.observe(ctx, taskOutputStep([{ id: `${taskId}-first`, taskId }]), true)).toBeUndefined();
    }

    const untrusted = taskOutputGuard();
    for (let index = 1; index <= 3; index += 1) {
      expect(untrusted.observe(ctx, taskOutputStep([
        { id: `untrusted-${index}`, taskId: 'task-a', trusted: false },
      ]), true)).toBeUndefined();
    }
  });

  it('starts a new native baseline after an untrusted same-task observation interrupts the segment', () => {
    const guard = taskOutputGuard();
    expect(guard.observe(ctx, taskOutputStep([{ id: 'trusted-a-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(guard.observe(ctx, taskOutputStep([
      { id: 'untrusted-a-2', taskId: 'task-a', trusted: false },
      { id: 'trusted-a-3', taskId: 'task-a' },
    ]), true)).toBeUndefined();
    expect(guard.observe(ctx, taskOutputStep([{ id: 'trusted-a-4', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(guard.observe(ctx, taskOutputStep([{ id: 'trusted-a-5', taskId: 'task-a' }]), true)?.observation.signalKind).toBe('polling_repeat');
  });

  it('withdraws only the reset task candidate and retains another task candidate', () => {
    const sameTaskReset = taskOutputGuard();
    expect(sameTaskReset.observe(ctx, taskOutputStep([{ id: 'reset-a-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(sameTaskReset.observe(ctx, taskOutputStep([{ id: 'reset-a-2', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(sameTaskReset.observe(ctx, taskOutputStep([
      { id: 'reset-a-3', taskId: 'task-a' },
      { id: 'reset-a-terminal', taskId: 'task-a', status: 'completed' },
    ]), true)).toBeUndefined();
    expect(sameTaskReset.observe(ctx, taskOutputStep([{ id: 'reset-a-4', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(sameTaskReset.observe(ctx, taskOutputStep([{ id: 'reset-a-5', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(sameTaskReset.observe(ctx, taskOutputStep([{ id: 'reset-a-6', taskId: 'task-a' }]), true)?.observation.signalKind).toBe('polling_repeat');

    const otherTaskReset = taskOutputGuard();
    expect(otherTaskReset.observe(ctx, taskOutputStep([{ id: 'other-a-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(otherTaskReset.observe(ctx, taskOutputStep([{ id: 'other-a-2', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(otherTaskReset.observe(ctx, taskOutputStep([
      { id: 'other-a-3', taskId: 'task-a' },
      { id: 'other-b-stopping', taskId: 'task-b', status: 'stopping' },
    ]), true)?.observation.signalKind).toBe('polling_repeat');
  });

  it('withdraws a same-task candidate after new output but keeps it through another task’s output', () => {
    const sameTaskProgress = taskOutputGuard();
    expect(sameTaskProgress.observe(ctx, taskOutputStep([{ id: 'progress-a-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(sameTaskProgress.observe(ctx, taskOutputStep([{ id: 'progress-a-2', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(sameTaskProgress.observe(ctx, taskOutputStep([
      { id: 'progress-a-3', taskId: 'task-a' },
      { id: 'progress-a-4', taskId: 'task-a', nextOffset: 10 },
    ]), true)).toBeUndefined();
    expect(sameTaskProgress.observe(ctx, taskOutputStep([{ id: 'progress-a-5', taskId: 'task-a', nextOffset: 10 }]), true)).toBeUndefined();
    expect(sameTaskProgress.observe(ctx, taskOutputStep([{ id: 'progress-a-6', taskId: 'task-a', nextOffset: 10 }]), true)?.observation.signalKind).toBe('polling_repeat');

    const otherTaskProgress = taskOutputGuard();
    for (const batch of [1, 2]) {
      expect(otherTaskProgress.observe(ctx, taskOutputStep([
        { id: `other-progress-a-${batch}`, taskId: 'task-a' },
        { id: `other-progress-b-${batch}`, taskId: 'task-b' },
      ]), true)).toBeUndefined();
    }
    expect(otherTaskProgress.observe(ctx, taskOutputStep([
      { id: 'other-progress-a-3', taskId: 'task-a' },
      { id: 'other-progress-b-3', taskId: 'task-b', nextOffset: 10 },
    ]), true)?.observation.signalKind).toBe('polling_repeat');
  });

  it('lets a known error without a receipt reset only its own task', () => {
    const guard = taskOutputGuard();
    expect(guard.observe(ctx, taskOutputStep([{ id: 'error-a-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(guard.observe(ctx, taskOutputStep([{ id: 'error-a-2', taskId: 'task-a' }]), true)).toBeUndefined();

    expect(guard.observe(ctx, taskOutputStep([
      { id: 'error-a-3', taskId: 'task-a' },
      { id: 'error-b', taskId: 'task-b', isError: true, omitDetails: true },
    ]), true)?.observation.signalKind).toBe('polling_repeat');

    const conflict = taskOutputGuard();
    expect(conflict.observe(ctx, taskOutputStep([{ id: 'conflict-a-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(conflict.observe(ctx, taskOutputStep([{ id: 'conflict-a-2', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(conflict.observe(ctx, taskOutputStep([
      { id: 'conflict-a-3', taskId: 'task-a' },
      { id: 'conflict-b-error', taskId: 'task-b', isError: true, resultTaskId: 'foreign-task' },
    ]), true)).toBeUndefined();
    expect(conflict.observe(ctx, taskOutputStep([{ id: 'conflict-a-4', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(conflict.observe(ctx, taskOutputStep([{ id: 'conflict-a-5', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(conflict.observe(ctx, taskOutputStep([{ id: 'conflict-a-6', taskId: 'task-a' }]), true)?.observation.signalKind).toBe('polling_repeat');
  });

  it('breaks a qualified segment for another tool and resets a permission-blocked native call', () => {
    const interrupted = taskOutputGuard();
    expect(interrupted.observe(ctx, taskOutputStep([{ id: 'interrupt-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(interrupted.observe(ctx, taskOutputStep([{ id: 'interrupt-2', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(interrupted.observe(ctx, taskOutputStep(
      [{ id: 'interrupt-3', taskId: 'task-a' }],
      { otherCalls: [{ id: 'bash', name: 'bash', arguments: { command: 'date' } }] },
    ), true)).toBeUndefined();
    expect(interrupted.observe(ctx, taskOutputStep([{ id: 'interrupt-4', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(interrupted.observe(ctx, taskOutputStep([{ id: 'interrupt-5', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(interrupted.observe(ctx, taskOutputStep([{ id: 'interrupt-6', taskId: 'task-a' }]), true)?.observation.signalKind).toBe('polling_repeat');

    const blocked = taskOutputGuard();
    expect(blocked.observe(ctx, taskOutputStep([{ id: 'blocked-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(blocked.observe(ctx, taskOutputStep([{ id: 'blocked-2', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(blocked.observe(ctx, taskOutputStep(
      [{ id: 'blocked-3', taskId: 'task-a' }],
      { blockedToolCallIds: ['blocked-3'] },
    ), true)).toBeUndefined();
    expect(blocked.observe(ctx, taskOutputStep([{ id: 'blocked-4', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(blocked.observe(ctx, taskOutputStep([{ id: 'blocked-5', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(blocked.observe(ctx, taskOutputStep([{ id: 'blocked-6', taskId: 'task-a' }]), true)?.observation.signalKind).toBe('polling_repeat');
  });

  it('applies positive host progress only to the matching trusted task and preserves old detect progress', () => {
    const vetoed = taskOutputGuard();
    expect(vetoed.observe(ctx, taskOutputStep([{ id: 'veto-a-1', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(vetoed.observe(ctx, taskOutputStep([{ id: 'veto-a-2', taskId: 'task-a' }]), true)).toBeUndefined();
    expect(vetoed.observe(ctx, taskOutputStep(
      [{ id: 'veto-a-3', taskId: 'task-a' }],
      { verifiedProgressCallIds: ['veto-a-3'] },
    ), true)).toBeUndefined();

    const observations: RunawayGuardObservation[] = [];
    const mixed = createRunawayGuard({
      onSignal: (value) => { observations.push(value); },
      toolPolicies: {
        task_output: taskOutputPollingPolicy,
        inspect: {
          kind: 'detect',
          projectProgress: () => ({ loopKey: 'workspace', progressKey: 'unchanged' }),
        },
        watch: { kind: 'exempt' },
      },
    });
    const inspectStep = (id: string, includePolling: boolean) => ({
      message: {
        role: 'assistant' as const,
        content: [
          { type: 'toolCall' as const, id, name: 'inspect', arguments: { revision: 1 } },
          ...(includePolling
            ? [{ type: 'toolCall' as const, id: `${id}-poll`, name: 'task_output', arguments: { task_id: 'task-a' } }]
            : []),
          { type: 'toolCall' as const, id: `${id}-watch`, name: 'watch', arguments: {} },
        ],
        api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } as never,
      toolResults: [],
      ...(includePolling ? {
        trustedToolProvenance: [{ toolCallId: `${id}-poll`, toolName: 'task_output', source: 'builtin' as const }],
      } : {}),
    });
    mixed.observe(ctx, inspectStep('inspect-1', false), false);
    mixed.observe(ctx, inspectStep('inspect-2', true), false);
    expect(observations).toContainEqual(expect.objectContaining({
      signalKind: 'unchanged_progress_repeat', occurrences: 2,
    }));
  });

  it('uses the existing detector priority and one-shot when both signals qualify in one batch', () => {
    const guard = createRunawayGuard({
      remindAfterOccurrences: 3,
      toolPolicies: {
        inspect: {
          kind: 'detect',
          projectProgress: () => ({ loopKey: 'workspace', progressKey: 'unchanged' }),
        },
        task_output: taskOutputPollingPolicy,
      },
    });
    const inspectStep = (id: string) => ({
      message: {
        role: 'assistant' as const,
        content: [{ type: 'toolCall' as const, id, name: 'inspect', arguments: { target: 'workspace' } }],
        api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } as never,
      toolResults: [],
    });
    expect(guard.observe(ctx, inspectStep('inspect-1'), true)).toBeUndefined();
    expect(guard.observe(ctx, inspectStep('inspect-2'), true)).toBeUndefined();
    const calls = [
      { type: 'toolCall' as const, id: 'inspect-3', name: 'inspect', arguments: { target: 'workspace' } },
      ...['poll-1', 'poll-2', 'poll-3'].map((id) => ({
        type: 'toolCall' as const, id, name: 'task_output', arguments: { task_id: 'task-a' },
      })),
    ];
    const reminder = guard.observe(ctx, {
      message: {
        role: 'assistant',
        content: calls,
        api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } as never,
      toolResults: ['poll-1', 'poll-2', 'poll-3'].map((id) => ({
        role: 'toolResult' as const,
        toolCallId: id,
        toolName: 'task_output',
        content: [],
        details: { task_id: 'task-a', status: 'running', next_offset: 0 },
        isError: false,
        timestamp: 0,
      })) as never,
      trustedToolProvenance: ['poll-1', 'poll-2', 'poll-3'].map((toolCallId) => ({
        toolCallId, toolName: 'task_output', source: 'builtin' as const,
      })),
    }, true);
    expect(reminder?.observation.signalKind).toBe('unchanged_progress_repeat');
    expect(guard.observe(ctx, taskOutputStep([{ id: 'after-priority', taskId: 'task-a' }]), true)).toBeUndefined();
  });

  it('does not let host-verified polling fields opt into a task_output reminder', () => {
    const guard = createRunawayGuard({
      remindAfterOccurrences: 3,
      toolPolicies: { task_output: { kind: 'polling' } },
    });
    for (const id of ['host-1', 'host-2', 'host-3']) {
      const value = taskOutputStep([{ id, taskId: 'task-a', trusted: false }]);
      expect(guard.observe(ctx, {
        ...value,
        verifiedProgress: [{
          toolCallId: id,
          loopKey: { taskId: 'task-a' },
          progressKey: { status: 'running', nextOffset: 0 },
          polling: { mode: 'continuous', reminderEligible: true },
        }],
      }, true)).toBeUndefined();
    }
    expect(guard.finishTurn(ctx)?.signals.polling_repeat.maxOccurrences).toBe(3);
  });
});
