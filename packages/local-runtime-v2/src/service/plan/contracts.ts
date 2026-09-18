import type { PiBeforeToolCallHook } from '@mavis/agent-core/pi-turn-runner';
import type { AgentExtension } from '@mavis/agent-runtime';
import type { QuestionnaireOwnedActionHandler } from '@mavis/local-runtime';

import type { AppDb } from '../../infra/db/client.js';
import type { TurnAdmissionPolicy } from '../turn-system/index.js';

type BeforeToolCallContext = Parameters<PiBeforeToolCallHook>[0];

export interface PlanTurnPolicySnapshot {
  readonly active: true;
  readonly canonicalPath: string;
}

export interface PlanPolicyGuard {
  beforeToolCall(input: {
    readonly plan?: PlanTurnPolicySnapshot;
    readonly toolContext: BeforeToolCallContext;
    readonly signal?: AbortSignal;
  }): ReturnType<PiBeforeToolCallHook>;
}

export interface PlanLifecycleAdmissionFence {
  blocksInTransaction(
    db: AppDb,
    candidate: { readonly sessionId: string; readonly excludeRequestId?: string },
  ): boolean;
  blocks(candidate: {
    readonly sessionId: string;
    readonly excludeRequestId?: string;
  }): Promise<boolean>;
}

export type PlanAdmissionPolicy = TurnAdmissionPolicy;

export const PLAN_ADMISSION_POLICY_REJECTIONS = {
  lifecycleActive: 'policy:plan:lifecycle-active',
  questionnaireActive: 'policy:plan:questionnaire-active',
  entryDisabled: 'policy:plan:entry-disabled',
  modeConflict: 'policy:plan:mode-conflict',
} as const;

export type PlanAdmissionPolicyRejection =
  (typeof PLAN_ADMISSION_POLICY_REJECTIONS)[keyof typeof PLAN_ADMISSION_POLICY_REJECTIONS];

export type PlanEntryPreparationResult =
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'plan-lifecycle-active'
        | 'plan-questionnaire-active'
        | 'plan-entry-disabled'
        | 'plan-mode-conflict';
    }
  | {
      readonly status: 'ready';
      readonly canonicalPath: string;
      readonly preparedNewDraft: boolean;
      commit(): Promise<void>;
      restore(options?: { readonly revertMode?: boolean }): Promise<void>;
    };

export function planEntryPreparationPolicyRejection(
  reason: Extract<PlanEntryPreparationResult, { readonly status: 'rejected' }>['reason'],
): PlanAdmissionPolicyRejection {
  if (reason === 'plan-lifecycle-active') {
    return PLAN_ADMISSION_POLICY_REJECTIONS.lifecycleActive;
  }
  if (reason === 'plan-questionnaire-active') {
    return PLAN_ADMISSION_POLICY_REJECTIONS.questionnaireActive;
  }
  if (reason === 'plan-entry-disabled') return PLAN_ADMISSION_POLICY_REJECTIONS.entryDisabled;
  return PLAN_ADMISSION_POLICY_REJECTIONS.modeConflict;
}

export interface PlanApplication {
  preparePlanEntry(sessionId: string): Promise<PlanEntryPreparationResult>;
  enterFromAgent(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly requestId: string }>;
  exitFromAgent(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolCallId?: string;
    readonly assistantMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly requestId: string; readonly planPath: string }>;
  confirmEntry(input: { readonly sessionId: string; readonly requestId: string }): Promise<void>;
  keepDefault(sessionId: string): Promise<void>;
  approve(input: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly markdown: string;
    readonly planPath: string;
  }): Promise<void>;
}

export interface PlanImplementationReceipt {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface PlanService {
  readonly toolGuard: PlanPolicyGuard;
  readonly lifecycleFence: PlanLifecycleAdmissionFence;
  readonly admission: PlanAdmissionPolicy;
  readonly application: PlanApplication;
  readonly extension: AgentExtension;
  readonly questionnaireActionHandler: QuestionnaireOwnedActionHandler;
  readonly lifecycleReconciler: {
    recoverStartup(): Promise<number>;
    schedule(requestId: string): void;
    scheduleQueueWake(sessionId: string): void;
    whenIdle(): Promise<void>;
    close(): Promise<void>;
  };
}
