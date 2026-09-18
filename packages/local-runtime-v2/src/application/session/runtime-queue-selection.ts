import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
import type { V1ServiceCompatibility } from '../../compat/v1/runtime.js';
import { composeQueuedItemClassifier, type PlanService } from '../../service/plan/index.js';
import type { SessionSystemOwner } from '../../service/session-system/index.js';
import {
  hasPriorityUserQueueItem,
  type InitializeTurnSystemOptions,
} from '../../service/turn-system/index.js';

export function createRuntimeQueueSelection(input: {
  readonly questionnaires: V1ServiceCompatibility['peripherals']['questionnaires'];
  readonly goals: V1ServiceCompatibility['sessionV2']['goals'];
  readonly queue: SessionSystemOwner['queue']['committed'];
  readonly lifecycleFence: PlanService['lifecycleFence'];
  readonly entryEnabled: () => boolean;
}): Pick<InitializeTurnSystemOptions, 'classifyQueuedItem' | 'shouldYieldFifoPosition'> {
  return {
    classifyQueuedItem: composeQueuedItemClassifier({
      existing: async (item) => {
        // A queued ordinary-questionnaire reply is the message that resolves
        // the very questionnaire the admission gates are waiting on, so it
        // must bypass them: after a crash between its enqueue and the
        // injected marker, deferring it would deadlock the whole queue.
        if (isOrdinaryQuestionnaireResponseOrigin(item.message.origin)) return 'ready';
        const pendingQuestionnaire = await input.questionnaires.getPending({
          agentName: item.agentName,
          sessionId: item.sessionId,
        });
        if (pendingQuestionnaire) return 'defer';
        // Goal queue selection reads the Plan fence itself so the wait reason it
        // projects names `plan`. The outer `lifecycleFence` below still runs and
        // stays the authority: it is the same fence, so a Goal item that reaches
        // it has already answered `false` and both agree. Nothing bypasses it —
        // in particular budget-limit continuations, which never consult the
        // dependency gates at all.
        return input.goals.classifyQueuedItem(item, (sessionId) =>
          input.lifecycleFence.blocks({ sessionId }),
        );
      },
      lifecycleFence: input.lifecycleFence,
      entryEnabled: input.entryEnabled,
    }),
    // GOAL-05 yield, applied at queue selection: a blocked Goal item would
    // otherwise hold the FIFO head and stall every message queued behind it.
    // Only the autonomous Goal source yields, so an ordinary user item that a
    // gate defers (an unresolved questionnaire) keeps blocking as before.
    shouldYieldFifoPosition: async (item) =>
      item.source === 'thread-goal' &&
      hasPriorityUserQueueItem(await input.queue.list(item.sessionId)),
  };
}
