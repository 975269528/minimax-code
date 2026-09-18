import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  type MavisBuildEnv,
  type MavisRegion,
} from '@mavis/config';

const MANAGED_MATRIX_BASE_URLS: Record<MavisRegion, Record<MavisBuildEnv, string>> = {
  cn: {
    dev: 'https://matrix-test.example.invalid',
    test: 'https://matrix-test.example.invalid',
    staging: 'https://matrix-pre.example.invalid',
    prod: 'https://agent.minimax.cn',
  },
  en: {
    dev: 'https://matrix-overseas-test.example.invalid',
    test: 'https://matrix-overseas-test.example.invalid',
    staging: 'https://matrix-overseas-pre.example.invalid',
    prod: 'https://agent.minimax.io',
  },
};

const LEGACY_MANAGED_MATRIX_BASE_URLS = new Set(['https://agent.minimaxi.com']);

export interface LocalMatrixEndpoint {
  baseUrl: string;
  managed: boolean;
  explicitToken?: string;
}

const EXPLICIT_MATRIX_TOKEN_ENV_KEYS = ['MATRIX_TOKEN'] as const;

function normalizeRegion(value: string | undefined, env: NodeJS.ProcessEnv): MavisRegion {
  if (value === 'cn' || value === 'en') return value;
  const locale = env.NEXT_PUBLIC_LOCALE;
  if (locale === 'zh') return 'cn';
  if (locale === 'en') return 'en';
  return getRuntimeRegion();
}

function normalizeBuildEnv(value: string | undefined, env: NodeJS.ProcessEnv): MavisBuildEnv {
  if (value === 'dev' || value === 'test' || value === 'prod' || value === 'staging') {
    return value;
  }
  const nextBuildEnv = env.NEXT_PUBLIC_BUILD_ENV;
  if (nextBuildEnv === 'dev' || nextBuildEnv === 'test') return 'test';
  if (nextBuildEnv === 'staging' || nextBuildEnv === 'prod') return nextBuildEnv;
  return getRuntimeBuildEnv();
}

export function normalizeMatrixBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

export function getManagedLocalMatrixBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return MANAGED_MATRIX_BASE_URLS[normalizeRegion(env.MAVIS_REGION, env)][
    normalizeBuildEnv(env.MAVIS_BUILD_ENV, env)
  ];
}

export function getLocalMatrixEndpoint(env: NodeJS.ProcessEnv = process.env): LocalMatrixEndpoint {
  const override = env.MATRIX_BASE_URL?.trim();
  const baseUrl = override ? normalizeMatrixBaseUrl(override) : getManagedLocalMatrixBaseUrl(env);
  const managed = isManagedMatrixBaseUrl(baseUrl);
  const explicitToken = managed ? undefined : getExplicitMatrixToken(env);
  return {
    baseUrl,
    managed,
    ...(explicitToken ? { explicitToken } : {}),
  };
}

export function getLocalMatrixBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return getLocalMatrixEndpoint(env).baseUrl;
}

export function isManagedMatrixBaseUrl(baseUrl: string): boolean {
  const normalized = normalizeMatrixBaseUrl(baseUrl);
  if (LEGACY_MANAGED_MATRIX_BASE_URLS.has(normalized)) return true;
  return Object.values(MANAGED_MATRIX_BASE_URLS).some((byEnv) =>
    Object.values(byEnv).some(
      (managedBaseUrl) => normalizeMatrixBaseUrl(managedBaseUrl) === normalized,
    ),
  );
}

function getExplicitMatrixToken(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of EXPLICIT_MATRIX_TOKEN_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}
