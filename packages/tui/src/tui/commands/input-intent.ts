import { matchTuiCommandInput, type TuiCommand } from './catalog.js';
import { parseTuiBashInput } from './bash-input.js';

export type TuiComposerInputIntentKind =
  | 'empty'
  | 'prompt'
  | 'bash'
  | 'command'
  | 'command-arguments'
  | 'skill'
  | 'skill-instructions';

export interface TuiComposerInputIntent {
  readonly kind: TuiComposerInputIntentKind;
  readonly token?: string;
}

export function resolveTuiComposerInputIntent(
  input: string,
  commands: readonly TuiCommand[],
): TuiComposerInputIntent {
  if (!input.trim()) return { kind: 'empty' };
  if (parseTuiBashInput(input)) return { kind: 'bash' };
  const match = matchTuiCommandInput(input, commands);
  if (!match) return { kind: 'prompt' };
  const skill = match.source.invocationKind === 'skill';
  return {
    kind: skill
      ? match.args
        ? 'skill-instructions'
        : 'skill'
      : match.args
        ? 'command-arguments'
        : 'command',
    token: match.token,
  };
}
