import {
  bindRuntimePromptSupport,
  createRuntimePromptLifecycle,
  type RuntimePromptConfigComposition,
  type RuntimePromptSupport,
} from './runtime-prompt-config.js';

export function bindRuntimeServicePromptLifecycle(input: {
  readonly compatibility: Parameters<typeof bindRuntimePromptSupport>[0];
  readonly support: RuntimePromptSupport;
  readonly lifecycle: { ready(): Promise<void>; close(): Promise<void> };
}): { ready(): Promise<void>; close(): Promise<void> } {
  bindRuntimePromptSupport(input.compatibility, input.support);
  return createRuntimePromptLifecycle({
    promptConfig: input.support.promptConfig,
    lifecycle: input.lifecycle,
    bindings: input.compatibility,
    internalTurnPromptReads: input.support.internalTurnPromptReads,
  });
}

type AuthState = 'pending' | 'authenticated' | 'logged_out' | undefined;

export function createRuntimePromptAuthNotifier(
  notifyPlugin: (authState?: AuthState) => void | Promise<void>,
  promptConfig: RuntimePromptConfigComposition | undefined,
): (authState?: AuthState) => Promise<void> {
  return async (authState) => {
    const pluginChange = notifyPlugin(authState);
    promptConfig?.notifyAuthContextChanged();
    await pluginChange;
  };
}
