import { applyTuiRenderTheme } from './runtime.js';
import type {
  TuiColorLevel,
  TuiResolvedAppearance,
  TuiThemeDetection,
  TuiThemeSnapshot,
} from './contracts.js';
import { type RgbColor, appearanceFromRgb, resolveEnvironmentAppearance } from './detection.js';
import { MINIMAX_CODE_DARK_THEME, MINIMAX_CODE_LIGHT_THEME } from './palettes.js';
import type { TUI } from '../engine/public.js';

export type TuiThemeUi = Pick<
  TUI,
  | 'onTerminalColorSchemeChange'
  | 'queryTerminalBackgroundColor'
  | 'setTerminalColorSchemeNotifications'
>;

export interface TuiThemeControllerOptions {
  readonly ui: TuiThemeUi;
  readonly colorLevel: TuiColorLevel;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly queryTimeoutMs?: number;
  readonly onDetection?: (detection: TuiThemeSnapshot) => void;
}

export class TuiThemeController {
  private readonly ui: TuiThemeUi;
  private readonly colorLevel: TuiColorLevel;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly queryTimeoutMs: number;
  private readonly onDetection: ((detection: TuiThemeSnapshot) => void) | undefined;
  private state: TuiThemeSnapshot;
  private readonly listeners = new Set<(snapshot: TuiThemeSnapshot) => void>();
  private stopTracking: (() => void) | undefined;
  private refreshSequence = 0;
  private started = false;
  /**
   * Latest appearance pushed by the terminal through DEC 2031. It stays live for the whole
   * Session, so it outranks `COLORFGBG`, which is only a process-start snapshot.
   */
  private reportedAppearance: TuiResolvedAppearance | undefined;

  constructor(options: TuiThemeControllerOptions) {
    this.ui = options.ui;
    this.colorLevel = options.colorLevel;
    this.env = options.env ?? process.env;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 250;
    this.onDetection = options.onDetection;
    this.state = {
      ...resolveEnvironmentAppearance(this.env),
      colorLevel: this.colorLevel,
    };
    this.onDetection?.(this.snapshot());
    this.applyRenderTheme();
  }

  snapshot(): TuiThemeSnapshot {
    return { ...this.state };
  }

  onChange(listener: (snapshot: TuiThemeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.ui.setTerminalColorSchemeNotifications(true);
      this.bindTerminalColorSchemeListener();
    }
    await this.refresh();
  }

  rebindUi(): void {
    if (!this.started) return;
    this.refreshSequence += 1;
    this.stopTracking?.();
    this.bindTerminalColorSchemeListener();
    this.ui.setTerminalColorSchemeNotifications(true);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.colorLevel === 0) return;
    const sequence = ++this.refreshSequence;
    const background = await this.ui
      .queryTerminalBackgroundColor({ timeoutMs: this.queryTimeoutMs })
      .catch(() => undefined);
    if (sequence !== this.refreshSequence) return;
    this.applyDetection(this.resolveDetection(background));
  }

  /**
   * Terminal evidence is ranked by how recently it was observed. OSC 11 is the most precise
   * because it reports the live background, the DEC 2031 report is the terminal's own live
   * signal, and `COLORFGBG` is last because it can only ever restate the appearance captured
   * when the process started.
   */
  private resolveDetection(background: RgbColor | undefined): TuiThemeDetection {
    if (background) {
      return {
        appearance: appearanceFromRgb(background),
        source: 'osc11',
        detail: `OSC 11 background rgb(${background.r}, ${background.g}, ${background.b})`,
      };
    }
    if (this.reportedAppearance) {
      return {
        appearance: this.reportedAppearance,
        source: 'terminal-report',
        detail: `DEC 2031 color scheme report ${this.reportedAppearance}`,
      };
    }
    return resolveEnvironmentAppearance(this.env);
  }

  dispose(): void {
    this.started = false;
    this.refreshSequence += 1;
    this.stopTracking?.();
    this.stopTracking = undefined;
    this.ui.setTerminalColorSchemeNotifications(false);
    this.listeners.clear();
  }

  private applyDetection(detection: TuiThemeDetection): void {
    const next: TuiThemeSnapshot = {
      ...detection,
      colorLevel: this.colorLevel,
    };
    const renderingChanged =
      next.appearance !== this.state.appearance || next.colorLevel !== this.state.colorLevel;
    this.state = next;
    this.onDetection?.(this.snapshot());
    if (!renderingChanged) return;
    this.applyRenderTheme();
    this.emit();
  }

  private applyRenderTheme(): void {
    applyTuiRenderTheme(
      this.state.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME,
      this.state.colorLevel,
    );
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private bindTerminalColorSchemeListener(): void {
    this.stopTracking = this.ui.onTerminalColorSchemeChange((scheme) => {
      this.reportedAppearance = scheme;
      void this.refresh();
    });
  }
}
