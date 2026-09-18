import {
  SigninClaimResult,
  isSigninPanelClaimable,
  isSigninPanelClaimedToday,
  validateClaimSigninData,
  validateSigninPanel,
  type ClaimSigninData,
  type SigninPanel,
} from '@mavis/shared/daily-signin';

export interface TuiDailyCheckinGateway {
  getSigninPanel(): Promise<SigninPanel>;
  claimSignin(): Promise<ClaimSigninData>;
}

export type TuiDailyCheckinOutcome =
  | {
      readonly status: 'claimed';
      readonly dayNo: number;
      readonly points: number;
      readonly expireAtMs: number;
      readonly panel: SigninPanel;
    }
  | {
      readonly status: 'already-claimed' | 'unavailable';
      readonly panel: SigninPanel;
    };

export class TuiDailyCheckinApplication {
  private pending: Promise<TuiDailyCheckinOutcome> | undefined;

  constructor(private readonly gateway: TuiDailyCheckinGateway) {}

  run(): Promise<TuiDailyCheckinOutcome> {
    if (this.pending) return this.pending;
    const operation = this.runOnce().finally(() => {
      if (this.pending === operation) this.pending = undefined;
    });
    this.pending = operation;
    return operation;
  }

  private async runOnce(): Promise<TuiDailyCheckinOutcome> {
    const panel = validateSigninPanel(await this.gateway.getSigninPanel());
    if (isSigninPanelClaimedToday(panel)) {
      return { status: 'already-claimed', panel };
    }
    if (!isSigninPanelClaimable(panel)) {
      return {
        status: 'unavailable',
        panel,
      };
    }

    const claim = validateClaimSigninData(await this.gateway.claimSignin());
    if (claim.claim_result === SigninClaimResult.AlreadyClaimed) {
      return { status: 'already-claimed', panel: claim.panel };
    }
    return {
      status: 'claimed',
      dayNo: claim.day_no,
      points: claim.points,
      expireAtMs: claim.expire_at_ms,
      panel: claim.panel,
    };
  }
}
