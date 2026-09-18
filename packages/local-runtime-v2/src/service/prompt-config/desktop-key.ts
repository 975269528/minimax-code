import { PromptConfigError } from './errors.js';

/** Validates the key reconstructed and injected by Electron main. */
export function readPromptConfigDesktopKey(injected: Uint8Array | undefined): Uint8Array {
  if (!injected) {
    throw new PromptConfigError(
      'PROMPT_DESKTOP_KEY_MISSING',
      'Desktop Prompt config key is unavailable',
    );
  }
  if (injected.length !== 32) {
    throw new PromptConfigError('PROMPT_KEY_INVALID', 'Desktop Prompt config key is invalid');
  }
  return Uint8Array.from(injected);
}
