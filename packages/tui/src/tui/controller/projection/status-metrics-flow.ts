import type {
  TuiAccountStatus,
  TuiConfigurationPort,
  TuiInspectionPort,
  TuiSessionUsageSummary,
  TuiContextSnapshotResponse,
} from '../../../runtime/port.js';

type StatusMetricsRuntime = Partial<Pick<TuiConfigurationPort, 'getAccountStatus'>> &
  Partial<Pick<TuiInspectionPort, 'getSessionUsageSummary' | 'getContextSnapshot'>>;

export interface TuiStatusMetricsFlowOptions {
  readonly runtime: StatusMetricsRuntime;
  readonly currentSessionId: () => string | undefined;
  readonly currentAccount: () => TuiAccountStatus | undefined;
  readonly apply: (patch: {
    account?: TuiAccountStatus;
    sessionUsage?: TuiSessionUsageSummary;
    contextSnapshot?: TuiContextSnapshotResponse;
  }) => void;
}

export class TuiStatusMetricsFlow {
  private accountRefreshSequence = 0;
  private usageRefreshSequence = 0;
  private contextRefreshSequence = 0;

  constructor(private readonly options: TuiStatusMetricsFlowOptions) {}

  async refresh(sessionId: string): Promise<void> {
    await Promise.all([
      this.refreshAccount(sessionId),
      this.refreshSessionUsage(sessionId),
      this.refreshContext(sessionId),
    ]);
  }

  async refreshSessionUsage(sessionId: string): Promise<void> {
    const getSessionUsageSummary = this.options.runtime.getSessionUsageSummary;
    if (!getSessionUsageSummary) return;
    const refreshSequence = ++this.usageRefreshSequence;
    const summary = await getSessionUsageSummary
      .call(this.options.runtime, sessionId)
      .catch(() => undefined);
    if (refreshSequence !== this.usageRefreshSequence) return;
    if (this.options.currentSessionId() !== sessionId) return;
    this.options.apply({ sessionUsage: summary });
  }

  async refreshContext(sessionId: string): Promise<void> {
    const getContextSnapshot = this.options.runtime.getContextSnapshot;
    if (!getContextSnapshot) return;
    const sequence = ++this.contextRefreshSequence;
    const contextSnapshot = await Promise.resolve()
      .then(() => getContextSnapshot.call(this.options.runtime, sessionId))
      .catch(() => undefined);
    if (sequence !== this.contextRefreshSequence || this.options.currentSessionId() !== sessionId)
      return;
    this.options.apply({ contextSnapshot });
  }

  async refreshAccount(sessionId?: string): Promise<void> {
    const getAccountStatus = this.options.runtime.getAccountStatus;
    if (!getAccountStatus) return;
    const refreshSequence = ++this.accountRefreshSequence;
    await Promise.resolve()
      .then(() =>
        getAccountStatus.call(this.options.runtime, sessionId, { includeMembership: false }),
      )
      .then(
        (account) => {
          if (!account || refreshSequence !== this.accountRefreshSequence) return;
          if (sessionId && this.options.currentSessionId() !== sessionId) return;
          this.options.apply({ account });

          if (account.modelSource === 'token-plan' && account.managedTokenPresent === true) {
            void this.refreshMembership(sessionId, refreshSequence);
          }
        },
        () => {
          if (refreshSequence !== this.accountRefreshSequence || this.options.currentAccount())
            return;
          if (sessionId && this.options.currentSessionId() !== sessionId) return;
          this.options.apply({ account: { status: 'unknown', warnings: [] } });
        },
      );
  }

  private async refreshMembership(sessionId: string | undefined, refreshSequence: number) {
    const getAccountStatus = this.options.runtime.getAccountStatus;
    if (!getAccountStatus) return;
    const account = await getAccountStatus
      .call(this.options.runtime, sessionId, { includeMembership: true })
      .catch(() => undefined);
    if (!account || refreshSequence !== this.accountRefreshSequence) return;
    if (sessionId && this.options.currentSessionId() !== sessionId) return;
    this.options.apply({ account });
  }

  refreshCurrent(): void {
    const sessionId = this.options.currentSessionId();
    if (!sessionId) {
      void this.refreshAccount();
      return;
    }
    void this.refresh(sessionId);
  }
}
