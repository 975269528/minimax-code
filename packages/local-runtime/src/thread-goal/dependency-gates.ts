export interface GoalDependencyGateCallbacks {
  readonly isSessionBusy: (sessionId: string) => boolean;
  readonly hasPendingQuestionnaire: (
    sessionId: string,
    expectedGoalId?: string,
  ) => Promise<boolean> | boolean;
  readonly hasPendingPermission: (sessionId: string) => Promise<boolean> | boolean;
  readonly hasAutomationOwnerConflict: (sessionId: string) => Promise<boolean> | boolean;
  readonly hasRequiredBackgroundWork: (sessionId: string) => Promise<boolean> | boolean;
}

interface GoalDependencyGateFailures {
  readonly report: (sessionId: string, message: string) => void;
  readonly format: (error: unknown) => string;
}

/**
 * Normalizes every external Goal dependency gate behind fail-closed reads.
 * Callbacks are required so a missing host wire can never become permission
 * to continue; test harnesses must opt into an explicit false result.
 */
export class GoalDependencyGates {
  constructor(
    private readonly callbacks: GoalDependencyGateCallbacks,
    private readonly failures: GoalDependencyGateFailures,
  ) {}

  isSessionBusy(sessionId: string): boolean {
    return this.callbacks.isSessionBusy(sessionId);
  }

  async hasPendingQuestionnaire(sessionId: string, expectedGoalId?: string): Promise<boolean> {
    try {
      return await this.callbacks.hasPendingQuestionnaire(sessionId, expectedGoalId);
    } catch (error) {
      this.report(sessionId, 'thread_goal_questionnaire_guard_failed', error);
      return true;
    }
  }

  async hasPendingPermission(sessionId: string): Promise<boolean> {
    try {
      return await this.callbacks.hasPendingPermission(sessionId);
    } catch (error) {
      this.report(sessionId, 'thread_goal_permission_guard_failed', error);
      return true;
    }
  }

  async hasAutomationOwnerConflict(sessionId: string): Promise<boolean> {
    try {
      return await this.callbacks.hasAutomationOwnerConflict(sessionId);
    } catch (error) {
      this.report(sessionId, 'thread_goal_automation_owner_guard_failed', error);
      return true;
    }
  }

  async hasRequiredBackgroundWork(sessionId: string): Promise<boolean> {
    try {
      return await this.callbacks.hasRequiredBackgroundWork(sessionId);
    } catch (error) {
      this.report(sessionId, 'thread_goal_background_guard_failed', error);
      return true;
    }
  }

  private report(sessionId: string, failureCode: string, error: unknown): void {
    this.failures.report(sessionId, `${failureCode}:${this.failures.format(error)}`);
  }
}
