import type { McodeProviderApplication } from '../../../provider/application.js';
import type {
  McodeCodexOAuthLoginMethod,
  McodeCodexOAuthStatus,
} from '../../../provider/contract.js';
import { getKeybindings, Key, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { wrapTextWithAnsi } from '../../rendering/text.js';
import { panelLayout } from '../../widgets/panel-frame.js';
import { SelectList } from '../../widgets/select-list.js';
import { tuiChalk as chalk, tuiColors as colors, tuiSelectListTheme } from '../../theme/runtime.js';

interface CodexLoginOptions {
  application: Pick<
    McodeProviderApplication,
    'connectCodexOAuth' | 'getCodexOAuthStatus' | 'cancelCodexOAuthLogin'
  >;
  openExternalTarget(url: string): Promise<void>;
  onConnected(): void;
  onClose(): void;
  requestRender(): void;
}

/** Pi's method selector and device-code prompt, projected from the Runtime-owned login. */
export class TuiCodexLogin implements Component {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private readonly methods: SelectList;
  private phase: 'loading' | 'select' | 'starting' | 'waiting' | 'failed' = 'loading';
  private method: McodeCodexOAuthLoginMethod = 'browser';
  private status: McodeCodexOAuthStatus | undefined;
  private error: string | undefined;
  private browserHint: string | undefined;
  private openedUrl: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private cancelling = false;

  constructor(private readonly options: CodexLoginOptions) {
    this.methods = new SelectList(
      [
        {
          value: 'browser',
          label: 'Browser login (default)',
          description: 'Sign in on this computer',
        },
        {
          value: 'device_code',
          label: 'Device code login',
          description: 'SSH / remote development machine',
        },
      ],
      2,
      tuiSelectListTheme,
    );
    this.methods.onSelect = (item) => {
      void this.start(item.value as McodeCodexOAuthLoginMethod);
    };
    this.methods.onCancel = () => {
      void this.cancel();
    };
  }

  async resume(): Promise<void> {
    try {
      const status = await this.options.application.getCodexOAuthStatus();
      if (this.cancelling && status.loginId) {
        await this.options.application.cancelCodexOAuthLogin(status.loginId);
      } else if (!this.disposed) this.update(status);
    } catch (error) {
      this.fail(error);
    }
  }

  handleInput(data: string): void {
    if (this.disposed || this.cancelling) return;
    if (getKeybindings().matches(data, 'tui.select.cancel')) {
      void this.cancel();
    } else if (this.phase === 'select') {
      this.methods.handleInput(data);
      this.options.requestRender();
    } else if (this.phase === 'failed' && matchesKey(data, Key.enter)) {
      void this.start(this.method);
    }
  }

  invalidate(): void {
    this.methods.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  async cancel(): Promise<void> {
    if (this.cancelling) return;
    this.cancelling = true;
    clearTimeout(this.timer);
    try {
      if (this.status?.loginId) {
        await this.options.application.cancelCodexOAuthLogin(this.status.loginId);
      }
      if (!this.disposed) this.options.onClose();
    } catch (error) {
      this.cancelling = false;
      this.fail(error);
    }
  }

  render(width: number): string[] {
    return this.renderViewport(width, 20);
  }

  renderViewport(width: number, height: number): string[] {
    const footer =
      this.phase === 'select'
        ? '↑↓ select · Enter continue · Esc cancel'
        : this.phase === 'failed'
          ? 'Enter retry · Esc cancel'
          : 'Esc cancel';
    const layout = panelLayout(width, height, footer);
    const body =
      this.phase === 'select'
        ? this.methods.renderViewport(layout.contentWidth, layout.bodyHeight)
        : this.body().flatMap((line) => wrapTextWithAnsi(line, layout.contentWidth));
    return layout.render({ title: 'Connect OpenAI Codex', body }, this.error ? 'error' : 'signal');
  }

  private body(): string[] {
    if (this.cancelling) return ['Cancelling sign-in…'];
    if (this.phase === 'loading') return ['Checking Codex sign-in…'];
    if (this.phase === 'starting') return ['Starting Codex sign-in…'];
    if (this.error) return [chalk.hex(colors.error)(this.error)];
    const device = this.status?.deviceCode;
    const url = device?.verificationUri ?? this.status?.authUrl;
    return [
      ...(device
        ? [chalk.bold.hex(colors.signal)(`Enter code: ${sanitizeTerminalText(device.userCode)}`)]
        : []),
      ...(url ? [sanitizeTerminalText(url)] : []),
      device
        ? 'Open this link in a browser on your computer and enter the code.'
        : 'Complete sign-in in your browser.',
      'Waiting for authorization…',
      ...(device
        ? [
            `Code expires in ${Math.max(0, Math.ceil((device.expiresAt - Date.now()) / 60_000))} min.`,
          ]
        : []),
      ...(this.browserHint ? [this.browserHint] : []),
    ];
  }

  private async start(method: McodeCodexOAuthLoginMethod): Promise<void> {
    this.method = method;
    this.phase = 'starting';
    this.error = undefined;
    this.browserHint = undefined;
    this.options.requestRender();
    try {
      const status = await this.options.application.connectCodexOAuth({ method });
      if (this.cancelling && status.loginId) {
        await this.options.application.cancelCodexOAuthLogin(status.loginId);
        return;
      }
      if (!this.disposed) this.update(status);
    } catch (error) {
      if (!this.cancelling) this.fail(error);
    }
  }

  private update(status: McodeCodexOAuthStatus): void {
    if (this.cancelling) return;
    this.status = status;
    this.error = undefined;
    if (status.method) this.method = status.method;
    if (status.state === 'connected') {
      this.options.onConnected();
      return;
    }
    if (status.state === 'pending') {
      this.phase = 'waiting';
      const url = status.deviceCode?.verificationUri ?? status.authUrl;
      if (url && url !== this.openedUrl) {
        this.openedUrl = url;
        void this.openBrowser(url);
      }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.resume();
      }, 1000);
      this.timer.unref?.();
    } else if (status.state === 'failed' || status.state === 'hidden') {
      this.phase = 'failed';
      this.error = sanitizeTerminalText(
        status.error ?? 'Codex sign-in is unavailable in this build.',
      );
    } else {
      this.phase = 'select';
    }
    this.options.requestRender();
  }

  private async openBrowser(url: string): Promise<void> {
    try {
      await this.options.openExternalTarget(url);
    } catch {
      if (this.disposed) return;
      this.browserHint = 'Open the link above manually to continue.';
      this.options.requestRender();
    }
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.phase = 'failed';
    this.error = sanitizeTerminalText(
      error instanceof Error ? error.message : 'Codex sign-in failed. Retry to continue.',
    );
    this.options.requestRender();
  }
}
