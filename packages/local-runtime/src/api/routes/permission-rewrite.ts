import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type { ExecutionPlan } from '@mavis/permission';

/**
 * Apply a complete effective-input snapshot onto the live `toolContext.args`
 * object so the executor sees the decision-time safe form.
 *
 * The permission facade records a checker rewrite such as
 * `rm <path>` → `mavis-trash <path>` in `ExecutionPlan.effectiveInput`.
 * The pi-agent-core
 * `beforeToolCallHook` contract has no explicit rewrite channel — the runner
 * just forwards the same `toolContext.args` reference to the tool executor —
 * so this helper mutates that object in place instead of returning a new one.
 *
 * Split into its own module so unit tests can import it without dragging the
 * rest of the permission-route surface (and its undici-fetching neighbours)
 * into the test-collection graph.
 */
export function applyPermissionExecutionPlan(
  toolContext: BeforeToolCallContext,
  plan: Readonly<ExecutionPlan> | undefined,
): void {
  if (!plan) return;
  const effectiveInput = plan.effectiveInput;
  if (
    toolContext.args &&
    typeof toolContext.args === 'object' &&
    !Array.isArray(toolContext.args)
  ) {
    const target = toolContext.args as Record<string, unknown>;
    if (target === effectiveInput) return;
    for (const key of Reflect.ownKeys(target)) {
      if (!Reflect.deleteProperty(target, key)) {
        throw new TypeError('Permission gate could not replace the execution input.');
      }
    }
    Object.assign(target, effectiveInput);
    return;
  }
  (toolContext as { args?: Record<string, unknown> }).args = { ...effectiveInput };
}
