import type {
  TuiConfigurationPort,
  TuiModel,
  TuiModelSelection,
  TuiSessionPort,
} from '../../../runtime/port.js';

/**
 * `getSession` is optional so headless and test doubles can keep providing a
 * model-only runtime; without it the picker simply falls back to the
 * configured default effort.
 */
type ModelRuntime = Pick<TuiConfigurationPort, 'listModels' | 'selectModel'> &
  Partial<Pick<TuiSessionPort, 'getSession'>>;

type TuiModelSelectionInput = TuiModelSelection & Partial<Omit<TuiModel, keyof TuiModelSelection>>;

export type TuiModelSelectionResult =
  | { readonly status: 'selected'; readonly model: TuiModel }
  | { readonly status: 'rejected' | 'stale' | 'superseded' };

export interface TuiModelStateOptions {
  readonly runtime: ModelRuntime;
  readonly currentSessionId: () => string | undefined;
  readonly onChanged: () => void;
  readonly isStopped?: () => boolean;
}

export class TuiModelState {
  private selectedValue: TuiModel | undefined;
  private selectedEffortValue: string | undefined;
  private generation = 0;
  private hydrationSequence = 0;
  private mutationSequence = 0;
  private pendingSelections = 0;
  private selectionTail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: TuiModelStateOptions) {}

  selected(): TuiModel | undefined {
    return this.selectedValue;
  }

  /** Saved global effort on welcome, or the current Session's effort. */
  selectedEffort(): string | undefined {
    return this.selectedEffortValue;
  }

  reset(): void {
    this.generation += 1;
    this.hydrationSequence += 1;
    this.mutationSequence += 1;
    this.selectedValue = undefined;
    this.selectedEffortValue = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.reset();
  }

  async refresh(sessionId = this.options.currentSessionId()): Promise<TuiModel | undefined> {
    if (this.isStopped()) return this.selectedValue;
    const generation = this.generation;
    const hydrationSequence = ++this.hydrationSequence;
    const mutationSequence = this.mutationSequence;
    let models: TuiModel[];
    let sessionEffort: string | undefined;
    try {
      // Runtime projects the saved global selection onto the welcome roster.
      // An active Session still uses its own authoritative echo.
      models = await this.options.runtime.listModels(sessionId);
      sessionEffort = await this.readSessionEffort(
        sessionId,
        models.find((model) => model.selected),
      );
    } catch {
      return this.selectedValue;
    }
    if (
      !this.isCurrent(sessionId, generation) ||
      hydrationSequence !== this.hydrationSequence ||
      mutationSequence !== this.mutationSequence ||
      this.pendingSelections > 0
    ) {
      return this.selectedValue;
    }
    this.selectedValue = models.find((model) => model.selected);
    this.selectedEffortValue = this.selectedValue ? sessionEffort : undefined;
    this.options.onChanged();
    return this.selectedValue;
  }

  async select(
    model: TuiModelSelectionInput,
    sessionId = this.options.currentSessionId(),
  ): Promise<TuiModelSelectionResult> {
    if (!this.isCurrent(sessionId, this.generation)) return { status: 'stale' };
    const generation = this.generation;
    const mutationSequence = ++this.mutationSequence;
    this.hydrationSequence += 1;
    this.pendingSelections += 1;

    const selection = this.selectionTail.then(() =>
      this.applySelection(model, sessionId, generation, mutationSequence),
    );
    this.selectionTail = selection.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await selection;
    } finally {
      this.pendingSelections = Math.max(0, this.pendingSelections - 1);
    }
  }

  private async applySelection(
    model: TuiModelSelectionInput,
    sessionId: string | undefined,
    generation: number,
    mutationSequence: number,
  ): Promise<TuiModelSelectionResult> {
    if (!this.isCurrent(sessionId, generation)) return { status: 'stale' };
    let success: boolean;
    try {
      success = await this.options.runtime.selectModel(model, sessionId);
    } catch (error) {
      if (!this.isCurrent(sessionId, generation)) return { status: 'stale' };
      if (mutationSequence !== this.mutationSequence) return { status: 'superseded' };
      this.mutationSequence += 1;
      this.hydrationSequence += 1;
      throw error;
    }
    if (!this.isCurrent(sessionId, generation)) return { status: 'stale' };
    if (mutationSequence !== this.mutationSequence) return { status: 'superseded' };

    this.mutationSequence += 1;
    this.hydrationSequence += 1;
    if (!success) return { status: 'rejected' };

    const { thinking, ...selectedModel } = model;
    this.selectedValue = { ...selectedModel, selected: true };
    this.selectedEffortValue = thinking?.effort?.trim() || undefined;
    this.options.onChanged();
    return { status: 'selected', model: this.selectedValue };
  }

  private async readSessionEffort(
    sessionId: string | undefined,
    selected?: TuiModel,
  ): Promise<string | undefined> {
    const getSession = this.options.runtime.getSession;
    if (!sessionId || !getSession) return selected?.thinking?.effort?.trim() || undefined;
    try {
      const session = await getSession.call(this.options.runtime, sessionId);
      if (
        selected &&
        session.model?.providerId &&
        session.model.modelId &&
        (session.model.providerId !== selected.providerId ||
          session.model.modelId !== selected.modelId)
      )
        return undefined;
      return session.model?.thinking?.effort?.trim() || undefined;
    } catch {
      // The echo only restores a label; a failing read must not drop the
      // roster refresh or the value already on screen.
      return this.selectedEffortValue;
    }
  }

  private isCurrent(sessionId: string | undefined, generation: number): boolean {
    return (
      !this.isStopped() &&
      generation === this.generation &&
      this.options.currentSessionId() === sessionId
    );
  }

  private isStopped(): boolean {
    return this.stopped || Boolean(this.options.isStopped?.());
  }
}
