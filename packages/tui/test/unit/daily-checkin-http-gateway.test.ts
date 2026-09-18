import { describe, expect, it, vi } from 'vitest';

import {
  SigninClaimResult,
  SigninDayStatus,
  SigninPanelScene,
  type ClaimSigninData,
  type SigninPanel,
} from '@mavis/shared/daily-signin';
import { TuiDailyCheckinHttpGateway } from '../../src/checkin/http-gateway.js';

function panel(status = SigninDayStatus.Claimable): SigninPanel {
  return {
    scene: SigninPanelScene.Active,
    days: Array.from({ length: 7 }, (_, index) => ({
      day_no: index + 1,
      points: (index + 1) * 10,
      status: index === 1 ? status : SigninDayStatus.Upcoming,
      is_today: index === 1,
    })),
  };
}

function claim(): ClaimSigninData {
  return {
    claim_id: 'claim-1',
    claim_result: SigninClaimResult.Claimed,
    day_no: 2,
    points: 20,
    expire_at_ms: 1_800_000_000_000,
    panel: panel(SigninDayStatus.Claimed),
  };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TuiDailyCheckinHttpGateway', () => {
  it('uses the signed public status and claim endpoints', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(panel()))
      .mockResolvedValueOnce(ok(claim()));
    const gateway = new TuiDailyCheckinHttpGateway({
      appVersion: '0.2.4',
      authContextGetter: () => ({ accessToken: 'token-1', realUserID: 'user-1' }),
      fetchImpl,
      origin: 'https://example.test',
      region: () => 'cn',
      nowMs: () => 1_800_000_000_000,
    });

    await gateway.getSigninPanel();
    await gateway.claimSignin();

    const [statusUrl, statusInit] = fetchImpl.mock.calls[0] ?? [];
    expect(String(statusUrl)).toContain('/minimax-cloud/api/v1/signin/status?');
    expect(String(statusUrl)).toContain('user_id=user-1');
    expect(statusInit).toEqual(
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          yy: expect.any(String),
          'x-signature': expect.any(String),
        }),
      }),
    );
    const [claimUrl, claimInit] = fetchImpl.mock.calls[1] ?? [];
    expect(String(claimUrl)).toContain('/minimax-cloud/api/v1/signin/claim?');
    expect(claimInit).toEqual(expect.objectContaining({ method: 'POST', body: '{}' }));
  });

  it('refreshes managed auth once after an HTTP 401', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(ok(panel()));
    const resolver = vi.fn(async () => ({ accessToken: 'token-2', realUserID: 'user-1' }));
    const gateway = new TuiDailyCheckinHttpGateway({
      appVersion: '0.2.4',
      authContextGetter: () => ({ accessToken: 'token-1', realUserID: 'user-1' }),
      authContextResolver: resolver,
      fetchImpl,
      origin: 'https://example.test',
    });

    await expect(gateway.getSigninPanel()).resolves.toEqual(panel());
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ forceRefresh: true, signal: expect.any(AbortSignal) }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses to claim when the account changes after the status request', async () => {
    let realUserID = 'user-1';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok(panel()));
    const gateway = new TuiDailyCheckinHttpGateway({
      appVersion: '0.2.4',
      authContextGetter: () => ({ accessToken: 'token-1', realUserID }),
      fetchImpl,
      origin: 'https://example.test',
    });

    await gateway.getSigninPanel();
    realUserID = 'user-2';

    await expect(gateway.claimSignin()).rejects.toThrow('account changed');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('discards a late status response after the active account changes', async () => {
    let realUserID = 'user-1';
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        await new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const gateway = new TuiDailyCheckinHttpGateway({
      appVersion: '0.2.4',
      authContextGetter: () => ({ accessToken: 'token-1', realUserID }),
      fetchImpl,
      origin: 'https://example.test',
    });

    const request = gateway.getSigninPanel();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    realUserID = 'user-2';
    release(ok(panel()));

    await expect(request).rejects.toThrow('account changed');
  });
  it('preserves the empty claim body when authentication refreshes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(panel()))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(ok(claim()));
    const gateway = new TuiDailyCheckinHttpGateway({
      appVersion: '0.2.4',
      authContextGetter: () => ({ accessToken: 'token-1', realUserID: 'user-1' }),
      authContextResolver: async () => ({ accessToken: 'token-2', realUserID: 'user-1' }),
      fetchImpl,
      origin: 'https://example.test',
    });
    await gateway.getSigninPanel();
    await gateway.claimSignin();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchImpl.mock.calls.slice(1)) {
      expect(init).toMatchObject({
        method: 'POST',
        body: '{}',
      });
    }
  });
});
