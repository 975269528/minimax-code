import { matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth } from '../../rendering/text.js';
import {
  tuiChalk as chalk,
  tuiColors as colors,
  renderTuiActionHint,
} from '../../theme/runtime.js';
import type { TuiPausedQueueSendIntent } from '../../../runtime/port.js';

type Decision = TuiPausedQueueSendIntent | 'cancel';
const choices: readonly { value: Decision; label: string }[] = [
  { value: 'paused-queue-keep', label: 'Send this message first, then continue the queue' },
  { value: 'paused-queue-clear', label: 'Clear my queued messages and send this message' },
  { value: 'cancel', label: 'Keep my draft' },
];

export class TuiPausedQueueSendPanel implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;
  private disposed = false;

  constructor(
    private readonly options: {
      readonly pendingCount: number;
      readonly onDecision: (decision: Decision) => void;
      readonly requestRender: () => void;
    },
  ) {}

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.options.onDecision('cancel');
    else if (matchesKey(data, 'enter'))
      this.options.onDecision(choices[this.selectedIndex]?.value ?? 'cancel');
    else if (matchesKey(data, 'up')) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (matchesKey(data, 'down'))
      this.selectedIndex = Math.min(choices.length - 1, this.selectedIndex + 1);
    this.options.requestRender();
  }

  render(width: number): string[] {
    return [
      chalk.bold.hex(colors.warning)(`Queue paused · ${this.options.pendingCount} pending`),
      'How should this message continue the Session?',
      '',
      ...choices.map((choice, index) =>
        index === this.selectedIndex
          ? chalk.hex(colors.accent)(`› ${choice.label}`)
          : `  ${choice.label}`,
      ),
      '',
      renderTuiActionHint('↑↓ select · Enter confirm · Esc keep draft'),
    ].map((line) => truncateToWidth(line, Math.max(0, width)));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.onDecision('cancel');
  }
}
