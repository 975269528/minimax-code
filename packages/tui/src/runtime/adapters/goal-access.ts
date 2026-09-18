import type { GlobalThreadGoal } from '@mavis/shared/global-events';
import type { TuiAttachment } from '../../types/invocation.js';
import type { TuiRuntimeAccessContext } from './access-context.js';

export class TuiGoalAccess {
  constructor(private readonly context: TuiRuntimeAccessContext) {}

  isEnabled(): boolean {
    return this.context.service('goal.enabled').isGoalEnabled();
  }

  get(sessionId: string): Promise<GlobalThreadGoal | undefined> {
    return this.context.service('goal.read').getGoal(sessionId);
  }

  create(input: {
    readonly sessionId: string;
    readonly objective: string;
    readonly tokenBudget?: number | null;
    readonly attachments?: readonly TuiAttachment[];
  }): Promise<GlobalThreadGoal> {
    return this.context.service('goal.create').createGoal({
      sessionId: input.sessionId,
      objective: input.objective,
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      ...(input.attachments?.length
        ? {
            kickoffAttachments: input.attachments.map((attachment) => ({
              type: attachment.type,
              filePath: attachment.filePath,
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
            })),
          }
        : {}),
    });
  }

  patch(
    sessionId: string,
    patch: {
      readonly status?: GlobalThreadGoal['status'];
      readonly objective?: string;
      readonly tokenBudget?: number | null;
    },
  ): Promise<GlobalThreadGoal> {
    return this.context.service('goal.patch').patchGoal(sessionId, patch);
  }

  clear(sessionId: string): Promise<boolean> {
    return this.context.service('goal.clear').clearGoal(sessionId);
  }
}
