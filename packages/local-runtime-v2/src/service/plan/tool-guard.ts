import { isSameResolvedPath } from '@mavis/permission';

import type { PlanPolicyGuard, PlanTurnPolicySnapshot } from './contracts.js';

const FILE_MUTATION_TOOLS = new Set([
  'write',
  'edit',
  'append',
  'apply_patch',
  'multiedit',
  'notebook_edit',
]);

class LocalPlanPolicyGuard implements PlanPolicyGuard {
  constructor(private readonly platform: NodeJS.Platform) {}

  async beforeToolCall(input: Parameters<PlanPolicyGuard['beforeToolCall']>[0]) {
    const plan = input.plan;
    if (!plan) return undefined;
    const toolName = input.toolContext.toolCall.name;
    const args = readRecord(input.toolContext.args);
    const denial = planPolicyDenial(plan, toolName, args, this.platform);
    return denial ? blocked(toolName, denial) : undefined;
  }
}

export function createPlanPolicyGuard(
  options: { readonly platform?: NodeJS.Platform } = {},
): PlanPolicyGuard {
  return new LocalPlanPolicyGuard(options.platform ?? process.platform);
}

function exactPlanWriteAllowed(
  plan: PlanTurnPolicySnapshot,
  toolName: 'write' | 'edit',
  args: Readonly<Record<string, unknown>>,
  platform: NodeJS.Platform,
): boolean {
  const target = toolName === 'write' ? args.path : args.file_path;
  return (
    typeof target === 'string' &&
    target.length > 0 &&
    isSameResolvedPath(target, plan.canonicalPath, platform)
  );
}

function planPolicyDenial(
  plan: PlanTurnPolicySnapshot,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  platform: NodeJS.Platform,
): string | undefined {
  if (FILE_MUTATION_TOOLS.has(toolName)) {
    const canonicalPlanWriteTool = toolName === 'write' || toolName === 'edit';
    if (canonicalPlanWriteTool && exactPlanWriteAllowed(plan, toolName, args, platform)) {
      return undefined;
    }
    return canonicalPlanWriteTool
      ? `the only writable file in Plan Mode is the canonical Plan file at ${plan.canonicalPath}. Retry targeting exactly that path, or continue investigating`
      : `this tool cannot be limited to the canonical Plan file. Use write or edit on exactly ${plan.canonicalPath} instead`;
  }
  if (toolName === 'EnterPlanMode') {
    return 'Plan Mode is already active. Continue planning and call ExitPlanMode when the canonical Plan file is ready for review';
  }
  return undefined;
}

function blocked(
  toolName: string,
  detail: string,
): { readonly block: true; readonly reason: string } {
  return {
    block: true,
    reason: `Plan Mode policy denied ${toolName}: ${detail}.`,
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
