import { createHash } from 'node:crypto';

import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  type MavisBuildEnv,
  type MavisRegion,
} from '@mavis/config';

const PUBLIC_GATEWAY_ORIGINS: Readonly<
  Record<MavisRegion, Readonly<Record<MavisBuildEnv, string>>>
> = {
  cn: {
    dev: 'https://matrix-test.example.invalid',
    test: 'https://matrix-test.example.invalid',
    staging: 'https://matrix-pre.example.invalid',
    prod: 'https://agent.minimaxi.com',
  },
  en: {
    dev: 'https://matrix-overseas-test.example.invalid',
    test: 'https://matrix-overseas-test.example.invalid',
    staging: 'https://matrix-overseas-pre.example.invalid',
    prod: 'https://agent.minimax.io',
  },
};

export function publicGatewayOrigin(input: {
  readonly region?: () => MavisRegion;
  readonly buildEnv?: () => MavisBuildEnv;
}): string {
  const region = (input.region ?? getRuntimeRegion)();
  const buildEnv = (input.buildEnv ?? getRuntimeBuildEnv)();
  return PUBLIC_GATEWAY_ORIGINS[region][buildEnv];
}

export function createPublicGatewayRequest(input: {
  readonly endpoint: string;
  readonly token: string;
  readonly realUserID: string;
  readonly appVersion: string;
  readonly region: MavisRegion;
  readonly nowMs: number;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: string;
}): { readonly url: URL; readonly headers: Record<string, string>; readonly body?: string } {
  const url = new URL(input.endpoint);
  const language = input.region === 'cn' ? 'zh' : 'en';
  url.search = new URLSearchParams({
    ...input.query,
    device_platform: 'web',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    is_desktop: '1',
    desktop_version: input.appVersion.trim(),
    unix: String(input.nowMs),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: language,
    lang: language,
    device_id: '0',
    os_name: process.platform,
    browser_name: 'mcode',
    user_id: input.realUserID.trim(),
    client: 'mcode',
  }).toString();
  // `yy` / `x-timestamp` / `x-signature` below are client attribution headers built
  // from two inline literals. Those literals tag a request as coming from a
  // first-party MiniMax client. They are shared across clients and are not
  // credentials or a security boundary: request authorization is the
  // `Authorization: Bearer` token sent on the same request.
  //
  // Changing either value requires a coordinated server-side rollout, so treat them
  // as wire-protocol constants.
  const signatureBody = input.body ?? '';
  const yyBody = input.body ?? '{}';
  const second = Math.floor(input.nowMs / 1_000);
  const pathWithSearch = `${url.pathname}${url.search}`;
  return {
    url,
    ...(input.body === undefined ? {} : { body: input.body }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'MiniMaxCode',
      Authorization: `Bearer ${input.token}`,
      yy: md5(`${encodeURIComponent(pathWithSearch)}_${yyBody}${md5(String(input.nowMs))}ooui`),
      'x-timestamp': String(second),
      'x-signature': md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2${signatureBody}`),
    },
  };
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}
