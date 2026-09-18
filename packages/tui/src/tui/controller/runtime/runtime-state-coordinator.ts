import type {
  TuiActiveRunControlPort,
  TuiInteractionPort,
  TuiQueuePort,
  TuiRuntimeEvent,
} from '../../../runtime/port.js';
import { createActiveQuestionnaire } from '../../interaction/questionnaire.js';
import { selectSessionView } from '../../state/selectors.js';
import type { TuiAction, TuiEffect } from '../../state/actions.js';
import type { TuiStateStore } from '../../state/store.js';

export interface TuiRuntimeStateCoordinatorOptions {
  readonly runtime: TuiQueuePort & TuiInteractionPort & TuiActiveRunControlPort;
  readonly stateStore: TuiStateStore;
  readonly defaultAgentName: string;
  readonly resolveSessionAgentName?: (sessionId: string) => string | undefined;
  readonly permissionSessionScope?: (sessionId: string) => ReadonlySet<string>;
  readonly queueEnabled: boolean;
}

export class TuiRuntimeStateCoordinator {
  constructor(private readonly options: TuiRuntimeStateCoordinatorOptions) {}

  project(event: TuiRuntimeEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    if (event.type === 'permission.ask') {
      this.options.stateStore.dispatch({
        type: 'interaction/permissionReceived',
        sessionId,
        permission: event.request,
      });
      return;
    }
    if (event.type === 'permission.resolved') {
      this.options.stateStore.dispatch({
        type: 'interaction/permissionResolved',
        sessionId,
        requestId: event.requestId,
      });
      return;
    }
    if (event.type === 'questionnaire.ask') {
      this.options.stateStore.dispatch({
        type: 'interaction/questionnaireReceived',
        sessionId,
        questionnaire: createActiveQuestionnaire(event.request, sessionId, event.agentName),
      });
      return;
    }
    if (event.type === 'questionnaire.dismiss' || event.type === 'questionnaire.superseded') {
      this.options.stateStore.dispatch({
        type: 'interaction/questionnaireResolved',
        sessionId,
        requestId: event.requestId,
      });
      return;
    }
    if (event.type === 'session.queue.updated' && event.itemId && event.status) {
      if (!this.options.queueEnabled) return;
      this.options.stateStore.dispatch({
        type: 'execution/queueObserved',
        sessionId,
        item: {
          itemId: event.itemId,
          status: event.status,
        },
      });
      return;
    }
    if (
      event.type === 'session.start' ||
      event.type === 'session.finish' ||
      event.type === 'session.error' ||
      event.type === 'session.abort'
    ) {
      this.options.stateStore.dispatch({
        type: 'execution/runObserved',
        sessionId,
        run: {
          runId: event.turnId ?? `session:${sessionId}`,
          turnId: event.turnId,
          status: event.type === 'session.start' ? 'running' : 'terminal',
        },
      });
    }
  }

  async reconcile(effect: TuiEffect): Promise<readonly TuiAction[]> {
    const sessionId = effect.sessionId;
    const initialView = selectSessionView(this.options.stateStore.snapshot(), sessionId);
    const expectedRunRevision = initialView?.runRevision ?? 0;
    const expectedQueueRevision = initialView?.queueRevision ?? 0;
    const expectedPermissionRevision = initialView?.permissionRevision ?? 0;
    const expectedQuestionnaireRevision = initialView?.questionnaireRevision ?? 0;
    const agentName =
      this.options.resolveSessionAgentName?.(sessionId) ?? this.options.defaultAgentName;
    const [activeRunResult, queueResult, permissionsResult, questionnaireResult] =
      await Promise.allSettled([
        this.options.runtime.getActiveRun(sessionId),
        this.options.queueEnabled
          ? this.options.runtime.listQueuedMessages(sessionId)
          : Promise.resolve(undefined),
        this.options.runtime.listPendingPermissions(),
        this.options.runtime.getPendingQuestionnaire(agentName, sessionId),
      ]);
    const failures = [activeRunResult, queueResult, permissionsResult, questionnaireResult].flatMap(
      (result) => (result.status === 'rejected' ? [result.reason] : []),
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Unable to reconcile Runtime state for session ${sessionId}.`,
      );
    }

    const actions: TuiAction[] = [];
    if (activeRunResult.status === 'fulfilled') {
      const activeRun = activeRunResult.value;
      const isActive = activeRun.state === 'running' || activeRun.state === 'decision-blocked';
      const turnId = activeRun.turnId ?? `session:${sessionId}`;
      actions.push({
        type: 'execution/runsReconciled',
        sessionId,
        expectedRunRevision,
        runs: isActive
          ? [
              {
                runId: turnId,
                turnId: activeRun.turnId,
                status: activeRun.state === 'decision-blocked' ? 'blocked' : 'running',
              },
            ]
          : [],
      });
    }
    if (queueResult.status === 'fulfilled' && queueResult.value !== undefined) {
      actions.push({
        type: 'execution/queueReplaced',
        sessionId,
        expectedQueueRevision,
        items: queueResult.value.map((item) => ({
          itemId: item.itemId,
          status: item.status ?? 'queued',
          content: item.content,
          runtimeItem: item,
        })),
      });
    }

    const interaction: Extract<TuiAction, { type: 'interaction/snapshotReconciled' }> = {
      type: 'interaction/snapshotReconciled',
      sessionId,
      expectedPermissionRevision,
      expectedQuestionnaireRevision,
    };
    if (permissionsResult.status === 'fulfilled') {
      const permissionScope = new Set(this.options.permissionSessionScope?.(sessionId) ?? []);
      permissionScope.add(sessionId);
      interaction.permission =
        permissionsResult.value.find(
          (item) => item.sessionId !== undefined && permissionScope.has(item.sessionId),
        ) ?? null;
    }
    if (questionnaireResult.status === 'fulfilled') {
      const questionnaire = questionnaireResult.value;
      interaction.questionnaire = questionnaire
        ? createActiveQuestionnaire(
            questionnaire,
            sessionId,
            questionnaire.requester?.agentName ?? agentName,
          )
        : null;
    }
    if ('permission' in interaction || 'questionnaire' in interaction) {
      actions.push(interaction);
    }
    actions.push({ type: 'connection/sessionReconciled', sessionId });
    return actions;
  }
}
