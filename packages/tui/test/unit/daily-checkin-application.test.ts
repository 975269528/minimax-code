import { describe, expect, it, vi } from 'vitest';

import {
  SigninClaimResult,
  SigninDayStatus,
  SigninPanelScene,
  type ClaimSigninData,
  type SigninPanel,
} from '@mavis/shared/daily-signin';
import {
  TuiDailyCheckinApplication,
  type TuiDailyCheckinGateway,
} from '../../src/checkin/application.js';

function panel(todayStatus: SigninDayStatus, scene = SigninPanelScene.Active): SigninPanel {
  return {
    scene,
    days: Array.from({ length: 7 }, (_, index) => ({
      day_no: index + 1,
      points: (index + 1) * 10,
      status: index === 1 ? todayStatus : SigninDayStatus.Upcoming,
      is_today: index === 1,
    })),
  };
}

function claimData(claimResult: SigninClaimResult = SigninClaimResult.Claimed): ClaimSigninData {
  return {
    claim_id: 'claim-1',
    claim_result: claimResult,
    day_no: 2,
    points: 20,
    expire_at_ms: 1_800_000_000_000,
    panel: panel(SigninDayStatus.Claimed),
  };
}

function gateway(statusPanel: SigninPanel, claim = claimData()): TuiDailyCheckinGateway {
  return {
    getSigninPanel: vi.fn(async () => statusPanel),
    claimSignin: vi.fn(async () => claim),
  };
}

describe('TuiDailyCheckinApplication', () => {
  it('claims a server-provided Claimable day even when the scene is Completed', async () => {
    const adapter = gateway(panel(SigninDayStatus.Claimable, SigninPanelScene.Completed));

    await expect(new TuiDailyCheckinApplication(adapter).run()).resolves.toEqual({
      status: 'claimed',
      dayNo: 2,
      points: 20,
      expireAtMs: 1_800_000_000_000,
      panel: claimData().panel,
    });
    expect(adapter.claimSignin).toHaveBeenCalledOnce();
    expect(adapter.claimSignin).toHaveBeenCalledWith();
  });

  it('does not claim again when the authoritative panel says today is claimed', async () => {
    const statusPanel = panel(SigninDayStatus.Claimed);
    const adapter = gateway(statusPanel);

    await expect(new TuiDailyCheckinApplication(adapter).run()).resolves.toEqual({
      status: 'already-claimed',
      panel: statusPanel,
    });
    expect(adapter.claimSignin).not.toHaveBeenCalled();
  });

  it('prioritizes today claimed when another day is also claimable', async () => {
    const statusPanel = panel(SigninDayStatus.Claimed);
    statusPanel.days[0] = { ...statusPanel.days[0], status: SigninDayStatus.Claimable };
    const adapter = gateway(statusPanel);

    await expect(new TuiDailyCheckinApplication(adapter).run()).resolves.toEqual({
      status: 'already-claimed',
      panel: statusPanel,
    });
    expect(adapter.claimSignin).not.toHaveBeenCalled();
  });

  it('treats a racing AlreadyClaimed response as an idempotent success', async () => {
    const alreadyClaimed = claimData(SigninClaimResult.AlreadyClaimed);
    const adapter = gateway(panel(SigninDayStatus.Claimable), alreadyClaimed);

    await expect(new TuiDailyCheckinApplication(adapter).run()).resolves.toEqual({
      status: 'already-claimed',
      panel: alreadyClaimed.panel,
    });
  });

  it('reports unavailable without claiming when no day is claimable or claimed today', async () => {
    const statusPanel = panel(SigninDayStatus.Disabled);
    const adapter = gateway(statusPanel);

    await expect(new TuiDailyCheckinApplication(adapter).run()).resolves.toEqual({
      status: 'unavailable',
      panel: statusPanel,
    });
    expect(adapter.claimSignin).not.toHaveBeenCalled();
  });

  it('coalesces concurrent invocations into one status and claim request', async () => {
    let release!: (value: ClaimSigninData) => void;
    const claim = new Promise<ClaimSigninData>((resolve) => {
      release = resolve;
    });
    const adapter: TuiDailyCheckinGateway = {
      getSigninPanel: vi.fn(async () => panel(SigninDayStatus.Claimable)),
      claimSignin: vi.fn(() => claim),
    };
    const application = new TuiDailyCheckinApplication(adapter);

    const first = application.run();
    const second = application.run();
    release(claimData());

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(adapter.getSigninPanel).toHaveBeenCalledOnce();
    expect(adapter.claimSignin).toHaveBeenCalledOnce();
  });
});
