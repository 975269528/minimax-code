import type { TuiConfigurationPort } from '../../../runtime/port.js';
import {
  formatTuiPermissionMode,
  nextTuiPermissionMode,
  type TuiPermissionMode,
} from '../../../application/permission-mode.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

export interface TuiPermissionModeSnapshot {
  readonly mode: TuiPermissionMode | undefined;
  readonly updating: boolean;
}

export interface TuiPermissionModeFlowOptions {
  readonly runtime: TuiConfigurationPort;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  readonly isStopped?: () => boolean;
}

export class TuiPermissionModeFlow {
  private modeValue: TuiPermissionMode | undefined;
  private updatingValue = false;
  private refreshSequence = 0;
  private mutationSequence = 0;
  private stopped = false;

  constructor(private readonly options: TuiPermissionModeFlowOptions) {}

  snapshot(): TuiPermissionModeSnapshot {
    return { mode: this.modeValue, updating: this.updatingValue };
  }

  async refresh(): Promise<void> {
    const refreshSequence = ++this.refreshSequence;
    const mutationSequence = this.mutationSequence;
    const mode = await this.options.runtime.getPermissionMode();
    if (
      this.isStopped() ||
      refreshSequence !== this.refreshSequence ||
      mutationSequence !== this.mutationSequence ||
      this.updatingValue
    ) {
      return;
    }
    this.modeValue = mode;
    this.options.onChanged();
  }

  async cycle(): Promise<void> {
    if (this.isStopped() || this.updatingValue) return;
    if (!this.modeValue) {
      this.options.setHint('Permission mode is managed by Desktop');
      this.options.onChanged();
      return;
    }

    await this.set(nextTuiPermissionMode(this.modeValue));
  }

  async set(nextMode: TuiPermissionMode): Promise<void> {
    if (this.isStopped() || this.updatingValue) return;
    if (!this.modeValue) {
      this.options.setHint('Permission mode is managed by Desktop');
      this.options.onChanged();
      return;
    }
    if (nextMode === this.modeValue) {
      this.options.setHint(`Permission mode · ${formatTuiPermissionMode(nextMode)}`);
      this.options.onChanged();
      return;
    }
    this.updatingValue = true;
    const mutationSequence = ++this.mutationSequence;
    this.refreshSequence += 1;
    this.options.setHint(`Switching to ${formatTuiPermissionMode(nextMode)}…`);
    this.options.onChanged();
    try {
      const mode = await this.options.runtime.setPermissionMode(nextMode);
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.modeValue = mode;
      this.options.setHint(undefined);
    } catch (error) {
      if (this.isStopped() || mutationSequence !== this.mutationSequence) return;
      this.options.append(
        formatTuiActionFailure(error, {
          summary: 'Permission mode was not changed.',
          nextStep: 'Retry /permission or Alt+M.',
        }),
        'warning',
      );
      this.options.setHint('Permission mode unchanged');
    } finally {
      if (!this.isStopped() && mutationSequence === this.mutationSequence) {
        this.updatingValue = false;
        this.options.onChanged();
      }
    }
  }

  showStatus(): void {
    this.options.append(
      this.modeValue
        ? `Permission mode: ${formatTuiPermissionMode(this.modeValue)}.`
        : 'Permission mode is managed by Desktop.',
    );
  }

  stop(): void {
    this.stopped = true;
    this.refreshSequence += 1;
    this.mutationSequence += 1;
    this.updatingValue = false;
  }

  private isStopped(): boolean {
    return this.stopped || Boolean(this.options.isStopped?.());
  }
}
