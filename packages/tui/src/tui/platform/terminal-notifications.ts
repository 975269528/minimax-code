import { execFile } from 'node:child_process';
import type { Terminal } from '../engine/public.js';
import { detectTerminalMultiplexer } from './terminal-capabilities.js';

const ESC = '\u001B';
const BEL = '\u0007';
const ST = `${ESC}\\`;
const MAX_DEDUPE_KEYS = 256;

export interface TuiNotificationSettings {
  readonly when?: 'unfocused' | 'always' | 'never';
  readonly method?: 'auto' | 'osc9' | 'osc777' | 'bel';
}

export type TuiTerminalNotificationKind =
  | 'turn-complete'
  | 'permission-required'
  | 'question-required'
  | 'turn-failed';

const NOTIFICATIONS: Readonly<
  Record<TuiTerminalNotificationKind, { title: string; body: string }>
> = {
  'turn-complete': { title: 'MCode', body: 'Response complete' },
  'permission-required': { title: 'MCode', body: 'Permission needs your input' },
  'question-required': { title: 'MCode', body: 'Question needs your input' },
  'turn-failed': { title: 'MCode', body: 'Response stopped with an error' },
};

type ExecuteNotificationFile = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null) => void,
) => unknown;

export class TuiTerminalNotifications {
  private readonly dedupe = new Set<string>();
  private readonly dedupeOrder: string[] = [];
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly executeFile: ExecuteNotificationFile;

  constructor(
    private readonly terminal: Pick<Terminal, 'write' | 'focused'>,
    options: {
      readonly environment?: Readonly<Record<string, string | undefined>>;
      readonly executeFile?: ExecuteNotificationFile;
      readonly settings?: TuiNotificationSettings;
    } = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.settings = options.settings ?? {};
    this.executeFile =
      options.executeFile ?? ((file, args, callback) => execFile(file, [...args], callback));
  }

  private readonly settings: TuiNotificationSettings;

  notifyOnce(kind: TuiTerminalNotificationKind, key: string): boolean {
    if (this.dedupe.has(key)) return false;
    this.remember(key);
    if (this.settings.when === 'never') return false;
    // cmux owns notification suppression; its CSI focus is not a reliable surface-focus signal.
    const hostOwnsFocus =
      this.environment.TERM_PROGRAM === 'cmux' || Boolean(this.environment.CMUX_SOCKET_PATH);
    if (this.settings.when !== 'always' && !hostOwnsFocus && this.terminal.focused === true)
      return false;
    const notification = NOTIFICATIONS[kind];
    const method = this.settings.method ?? 'auto';
    if (method === 'auto' && this.environment.WT_SESSION) {
      this.executeFile(
        'powershell.exe',
        ['-NoProfile', '-Command', windowsToastScript(notification.title, notification.body)],
        (error) => {
          if (error) this.terminal.write(BEL);
        },
      );
      return true;
    }
    for (const sequence of buildTuiTerminalNotificationSequences(
      notification,
      this.environment,
      method,
    )) {
      this.terminal.write(sequence);
    }
    return true;
  }

  private remember(key: string): void {
    this.dedupe.add(key);
    this.dedupeOrder.push(key);
    if (this.dedupeOrder.length <= MAX_DEDUPE_KEYS) return;
    const expired = this.dedupeOrder.shift();
    if (expired) this.dedupe.delete(expired);
  }
}

export function shouldNotifyMcodeTurnComplete(input: {
  readonly queuedCount: number;
  readonly hasActiveRun: boolean;
}): boolean {
  return input.queuedCount === 0 && !input.hasActiveRun;
}

export function buildTuiTerminalNotificationSequences(
  notification: { readonly title: string; readonly body: string },
  environment: Readonly<Record<string, string | undefined>> = process.env,
  method: NonNullable<TuiNotificationSettings['method']> = 'auto',
): readonly string[] {
  if (method === 'auto' && environment.WT_SESSION) return [];
  const cmux = environment.TERM_PROGRAM === 'cmux' || Boolean(environment.CMUX_SOCKET_PATH);
  const useOsc9 =
    method === 'osc9' ||
    (method === 'auto' &&
      !cmux &&
      ['ghostty', 'iTerm.app', 'WezTerm', 'WarpTerminal'].includes(environment.TERM_PROGRAM ?? ''));
  const useOsc777 = method === 'osc777' || (method === 'auto' && cmux);
  if (
    method === 'bel' ||
    (method === 'auto' && !useOsc9 && !useOsc777 && !environment.KITTY_WINDOW_ID)
  )
    return [BEL];
  const sequences =
    method === 'auto' && !cmux && environment.KITTY_WINDOW_ID
      ? [
          `${ESC}]99;i=1:d=0;${notification.title}${ST}`,
          `${ESC}]99;i=1:p=body;${notification.body}${ST}`,
        ]
      : useOsc9
        ? [`${ESC}]9;${notification.title}: ${notification.body}${BEL}`]
        : [`${ESC}]777;notify;${notification.title};${notification.body}${BEL}`];
  if (detectTerminalMultiplexer(environment) !== 'tmux') return sequences;
  return sequences.map(wrapForTmuxPassthrough);
}

function wrapForTmuxPassthrough(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`;
}

function windowsToastScript(title: string, body: string): string {
  const type = 'Windows.UI.Notifications';
  const manager = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${manager} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
  ].join('; ');
}
