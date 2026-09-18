import { stripTerminalSequences } from '../../engine/public.js';

export function normalizeComposerPasteText(pastedText: string): string {
  return stripTerminalSequences(pastedText);
}
