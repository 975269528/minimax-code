import type { LocalBackgroundTaskService } from './service.js';

type HostedBackgroundTaskService = Pick<
  LocalBackgroundTaskService,
  'reminderSnapshot' | 'markDelivered'
>;

export interface HostedBackgroundReminderSession {
  readonly sessionId: string;
  readonly sessionType: 'root' | 'branch';
  readonly parentSessionId?: string | null;
  readonly visibility?: 'visible' | 'hidden';
}

export function createHostedBackgroundReminderCapabilities(
  service: HostedBackgroundTaskService,
) {
  return {
    buildBackground: async (input: { readonly session: HostedBackgroundReminderSession }) => {
      const snapshot = await service.reminderSnapshot(input.session);
      return {
        tasks: snapshot.tasks.map((task) => ({
          taskId: task.taskId,
          status: task.status as 'succeeded' | 'failed' | 'canceled' | 'lost',
          ...(task.endedAt === undefined ? {} : { endedAtMs: task.endedAt }),
        })),
        undeliveredTotal: snapshot.undeliveredTotal,
        terminalTotal: snapshot.terminalTotal,
      };
    },
    confirmBackgroundTaskReads: async (input: {
      readonly sessionId: string;
      readonly taskIds: readonly string[];
    }) =>
      (await service.markDelivered(input.sessionId, [...input.taskIds])).map(
        (task) => task.taskId,
      ),
  };
}
