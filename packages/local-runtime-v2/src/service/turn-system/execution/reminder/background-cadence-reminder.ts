import type { PiBeforeLlmCallHook } from '@mavis/agent-core/pi-turn-runner';

import type { BackgroundReminderFacts } from '../../agent-host/assembly/local-turn-input-preparation.js';
import type { BackgroundCadenceReminder } from '../../agent-host/execution/contracts.js';
import {
  formatBackgroundCadenceReminderContent,
  type BackgroundCadenceReminderDetails,
} from '../../agent-host/history/canonical-history-validation.js';
import {
  BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
  projectBackgroundHistory,
} from '../../compaction/algorithm/background-cadence.js';
import { TODO_CADENCE_INTERVAL } from '../../compaction/compat.js';
import type { ContextUsageAnchorState } from '../../compaction/execution/usage-anchor.js';
import { readBackgroundTaskOriginMetadata } from '../../agent-host/history/background/host-metadata.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';

export function createBackgroundCadenceReminder(
  usageAnchor: ContextUsageAnchorState,
): BackgroundCadenceReminder {
  return {
    async prepare(input) {
      if (hasAutomaticBackgroundOrigin(input.hookInput.canonicalMessages.at(-1))) {
        return { beforeUserMessages: [], hook: () => undefined };
      }
      const facts = freezeFacts(await input.loadFacts());
      const candidate = createBackgroundCadenceMarker(input.hookInput, facts);
      const marker =
        candidate && fitsReminderInFinalRequest(input.hookInput, candidate, usageAnchor)
          ? candidate
          : undefined;
      return {
        beforeUserMessages: marker ? [marker] : [],
        hook: createPreparedBackgroundCadenceReminderHook({
          facts,
          initialCandidate: candidate,
          usageAnchor,
          hasSuccessfulTaskOutputRead: input.hasSuccessfulTaskOutputRead,
        }),
      };
    },
  };
}

function createPreparedBackgroundCadenceReminderHook(options: {
  readonly facts: BackgroundReminderFacts;
  readonly initialCandidate: BackgroundCadenceMarker | undefined;
  readonly usageAnchor: ContextUsageAnchorState;
  readonly hasSuccessfulTaskOutputRead?: () => boolean;
}): PiBeforeLlmCallHook {
  const {
    facts,
    initialCandidate,
    usageAnchor,
    hasSuccessfulTaskOutputRead = () => false,
  } = options;
  return (input) => {
    if (hasSuccessfulTaskOutputRead()) return undefined;
    if (hasAutomaticBackgroundOrigin(input.canonicalMessages.at(-1))) return undefined;
    const marker =
      input.phase === 'initial' ? initialCandidate : createBackgroundCadenceMarker(input, facts);
    if (
      !marker ||
      (input.phase === 'initial' && hasPreparedMarker(input.canonicalMessages, marker)) ||
      !fitsReminderInFinalRequest(input, marker, usageAnchor)
    ) {
      return undefined;
    }
    return marker
      ? {
          type: 'appendMessage',
          reason: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
          message: marker,
          ...(input.phase === 'initial' ? { placement: 'before-current-user' as const } : {}),
        }
      : undefined;
  };
}

type BackgroundCadenceMarker = NonNullable<ReturnType<typeof createBackgroundCadenceMarker>>;

function createBackgroundCadenceMarker(
  input: Parameters<PiBeforeLlmCallHook>[0],
  facts: BackgroundReminderFacts,
) {
  if (facts.undeliveredTotal === 0 || facts.tasks.length === 0) return undefined;
  const projection = projectBackgroundHistory(input.canonicalMessages);
  const hasNewTerminalTask =
    !projection.hasBackgroundState ||
    (projection.observedTerminalCount !== undefined &&
      facts.terminalTotal > projection.observedTerminalCount);
  if (!hasNewTerminalTask && projection.assistantIterationsSinceReminder < TODO_CADENCE_INTERVAL) {
    return undefined;
  }
  const details: BackgroundCadenceReminderDetails = {
    version: 1,
    tasks: facts.tasks,
    undeliveredTotal: facts.undeliveredTotal,
    queuedTotal: facts.undeliveredTotal - facts.tasks.length,
    terminalTotal: facts.terminalTotal,
    cadence: {
      assistantIterationsBeforeReminder: projection.assistantIterationsSinceReminder,
    },
  };
  const marker = {
    role: 'custom' as const,
    customType: BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE,
    content: formatBackgroundCadenceReminderContent(details),
    display: false as const,
    details,
    timestamp: Date.now(),
  };
  return marker;
}

function freezeFacts(facts: BackgroundReminderFacts): BackgroundReminderFacts {
  return Object.freeze({
    tasks: Object.freeze(facts.tasks.map((task) => Object.freeze({ ...task }))),
    undeliveredTotal: facts.undeliveredTotal,
    terminalTotal: facts.terminalTotal,
  });
}

function hasPreparedMarker(messages: readonly unknown[], marker: BackgroundCadenceMarker): boolean {
  return messages.some(
    (message) =>
      message !== null &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      Reflect.get(message, 'role') === 'custom' &&
      Reflect.get(message, 'customType') === BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE &&
      Reflect.get(message, 'timestamp') === marker.timestamp,
  );
}

function hasAutomaticBackgroundOrigin(message: unknown): boolean {
  return readBackgroundTaskOriginMetadata(message) !== undefined;
}
