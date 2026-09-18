import type { ToolCheckResult } from './engine.js';
import type { PermissionDecision } from './types.js';
import {
  reducePermissionEvaluation,
  type CommandIntent,
  type ExecutionPlan,
  type PermissionEvidence,
  type PermissionEvaluationInput,
  type ShellFamily,
} from './permission-core.js';
import { createPermissionExecutionPlan, inferPermissionCommandIntents } from './execution-plan.js';

export type LegacyParserAdapterResult = {
  intents: CommandIntent[];
  evidence: PermissionEvidence[];
  legacyDecision: PermissionDecision;
  executionPlan?: ExecutionPlan;
};

export type LegacyAdapterInput = Pick<PermissionEvaluationInput, 'toolName' | 'input'> & {
  decision: PermissionDecision;
  checkerResult?: ToolCheckResult;
  shell?: ShellFamily;
  context?: Pick<PermissionEvaluationInput['context'], 'workingDirectory' | 'homeDir'>;
};

export type LegacyEvaluationInput = LegacyAdapterInput &
  Pick<PermissionEvaluationInput, 'mode' | 'context'>;

/**
 * Shared v1/v2 parity seam. Hosts still own their existing approval and
 * execution flow; both can opt into this function without changing the
 * legacy checker or moving side effects into Permission Core.
 */
export function evaluateLegacyPermission(input: LegacyEvaluationInput) {
  const parsed = adaptLegacyPermissionResult(input);
  return {
    parsed,
    evaluation: reducePermissionEvaluation({
      ...input,
      evidence: parsed.evidence,
      executionPlan: parsed.executionPlan,
    }),
  };
}

export function adaptLegacyPermissionResult(input: LegacyAdapterInput): LegacyParserAdapterResult {
  const evidence: PermissionEvidence[] = [decisionEvidence(input.decision)];
  const intents = inferPermissionCommandIntents(input);
  const executionPlan = buildExecutionPlan(input);

  if (input.decision.reason.type === 'safetyCheck') {
    evidence.push(
      input.decision.reason.classifierApprovable === false
        ? { kind: 'classifier-ineligible', reason: input.decision.reason.description }
        : { kind: 'classifier-eligible', reason: input.decision.reason.description },
    );
  }

  if (input.decision.reason.type === 'rmRewrite') {
    evidence.push({ kind: 'legacy-reason', value: input.decision.reason });
  }

  return {
    intents,
    evidence,
    legacyDecision: input.decision,
    ...(executionPlan ? { executionPlan } : {}),
  };
}

function decisionEvidence(decision: PermissionDecision): PermissionEvidence {
  if (decision.behavior === 'deny') {
    if (decision.reason.type === 'safetyCheck')
      return { kind: 'host-deny', reason: decision.reason.description };
    return { kind: 'legacy-deny', reason: describeLegacyDeny(decision.reason) };
  }
  if (decision.behavior === 'allow') {
    if (decision.reason.type === 'rule') {
      return {
        kind: 'user-rule',
        behavior: 'allow',
        ruleContent: decision.reason.rule.ruleValue.ruleContent,
      };
    }
    return { kind: 'built-in-allow', reason: decision.reason.type };
  }
  return {
    kind: 'user-rule',
    behavior: 'ask',
    ruleContent: decision.ruleContents?.[0],
  };
}

function describeLegacyDeny(reason: PermissionDecision['reason']): string {
  if (reason.type === 'safetyCheck') return reason.description;
  if (reason.type === 'rule') return `Matched ${reason.rule.source} deny rule.`;
  return `Legacy permission decision ${reason.type} denied the tool call.`;
}

function buildExecutionPlan(input: LegacyAdapterInput): ExecutionPlan | undefined {
  const rewrittenInput = input.checkerResult?.rewrittenInput ?? input.decision.rewrittenInput;
  if (!rewrittenInput) return undefined;
  return createPermissionExecutionPlan({
    toolName: input.toolName,
    input: input.input,
    rewrittenInput,
    ...(input.shell ? { shell: input.shell } : {}),
    ...(input.context ? { context: input.context } : {}),
  }) as ExecutionPlan;
}
