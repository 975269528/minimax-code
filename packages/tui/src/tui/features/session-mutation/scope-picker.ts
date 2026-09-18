import { panelLayout } from '../../widgets/panel-frame.js';
import { matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import type { TuiFeatureScreen } from '../../shell/surface-host.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import {
  tuiChalk as chalk,
  tuiColors as colors,
  tuiSelectListTheme as theme,
} from '../../theme/runtime.js';
import { SelectList } from '../../widgets/select-list.js';
import type { TuiRewindScope } from '../../../runtime/port.js';
import { sessionMutationText } from './copy.js';

export interface TuiSessionMutationScopePickerOptions {
  readonly onSelect: (scope: TuiRewindScope) => void;
  readonly onCancel: () => void;
  readonly requestRender?: () => void;
  /** Optional initial scope; defaults to `conversation`. */
  readonly initialScope?: TuiRewindScope;
}

interface ScopeOption {
  readonly scope: TuiRewindScope;
  readonly label: string;
  readonly description: string;
}

function scopeOptions(): readonly ScopeOption[] {
  return [
    {
      scope: 'conversation',
      label: sessionMutationText('sessionMutation.scope.conversation.label'),
      description: sessionMutationText('sessionMutation.scope.conversation.description'),
    },
    {
      scope: 'conversation_and_files',
      label: sessionMutationText('sessionMutation.scope.both.label'),
      description: sessionMutationText('sessionMutation.scope.both.description'),
    },
  ] as const;
}

export class TuiSessionMutationScopePicker implements TuiFeatureScreen, Component, Focusable {
  readonly id = 'session-mutation:scope';
  readonly layoutRoot: Component = this;
  readonly handlesViewportKeys = true;
  private readonly list: SelectList;
  private _focused = false;
  private cancelInvoked = false;
  private selectInvoked = false;
  private busy = false;
  private error: string | undefined;

  constructor(private readonly options: TuiSessionMutationScopePickerOptions) {
    const availableScopes = scopeOptions();
    this.list = new SelectList(
      availableScopes.map((option) => ({
        value: option.scope,
        label: option.label,
        description: option.description,
      })),
      availableScopes.length,
      theme,
      { minPrimaryColumnWidth: 22, maxPrimaryColumnWidth: 36 },
    );
    const initialIndex = availableScopes.findIndex(
      (option) => option.scope === (options.initialScope ?? 'conversation'),
    );
    this.list.setSelectedIndex(initialIndex >= 0 ? initialIndex : 0);
    this.list.onSelect = (item) => this.handleSelect(item.value as TuiRewindScope);
    this.list.onCancel = () => this.handleCancel();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.handleCancel();
      return;
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      const current = this.list.getSelectedItem();
      if (current) this.handleSelect(current.value as TuiRewindScope);
      return;
    }
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    return this.renderViewport(safeWidth, Number.MAX_SAFE_INTEGER);
  }

  renderViewport(width: number, height: number): string[] {
    const layout = panelLayout(
      width,
      height,
      this.busy
        ? 'Preparing rewind confirmation…'
        : sessionMutationText('sessionMutation.scope.hint'),
    );
    const header =
      layout.bodyHeight >= 5
        ? [chalk.hex(colors.muted)(sessionMutationText('sessionMutation.scope.helper'))]
        : [];
    const error = this.error ? [chalk.hex(colors.warning)(sanitizeTerminalText(this.error))] : [];
    return layout.render({
      title: sessionMutationText('sessionMutation.scope.title'),
      body: [
        ...header,
        ...this.list.renderViewport(
          layout.contentWidth,
          Math.max(1, layout.bodyHeight - header.length - error.length),
        ),
        ...error,
      ],
    });
  }

  isClosed(): boolean {
    return this.cancelInvoked;
  }

  resetSelection(): void {
    this.selectInvoked = false;
    this.invalidate();
  }

  setBusy(value: boolean): void {
    this.busy = value;
    this.invalidate();
    this.options.requestRender?.();
  }

  setError(value: string): void {
    this.error = value;
    this.invalidate();
    this.options.requestRender?.();
  }

  private handleSelect(scope: TuiRewindScope): void {
    if (this.selectInvoked || this.cancelInvoked) return;
    if (!isSupportedScope(scope)) return;
    this.selectInvoked = true;
    this.options.onSelect(scope);
  }

  private handleCancel(): void {
    if (this.cancelInvoked) return;
    this.cancelInvoked = true;
    this.options.onCancel();
  }
}

function isSupportedScope(scope: string): scope is TuiRewindScope {
  return scope === 'conversation' || scope === 'conversation_and_files';
}
