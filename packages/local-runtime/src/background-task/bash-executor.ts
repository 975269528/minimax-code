import type { LocalBackgroundBashExecutor } from '@mavis/agent-tools/desktop';

export type {
  LocalBackgroundBashExecutor,
  LocalBackgroundBashExecutorResult,
} from '@mavis/agent-tools/desktop';

/**
 * V1 cannot construct product Bash operations: the sandbox-aware operations
 * factory lives in V2. A V1 runtime started WITHOUT the V2 owner therefore has
 * NO working background bash — V1 is not independently usable for this surface.
 *
 * This stub exists to make that dependency explicit and fail loudly at the call
 * site, rather than silently spawning an unsandboxed shell.
 */
export const DEFAULT_LOCAL_BACKGROUND_BASH_EXECUTOR: LocalBackgroundBashExecutor = {
  async execute() {
    throw Object.assign(
      new Error(
        'SANDBOX_UNAVAILABLE: background bash requires the V2 runtime owner to inject an ' +
          'executor (see createDeferredLocalSandboxBashOperationsFactory). A standalone V1 ' +
          'runtime has no background bash.',
      ),
      { code: 'SANDBOX_UNAVAILABLE' },
    );
  },
};
