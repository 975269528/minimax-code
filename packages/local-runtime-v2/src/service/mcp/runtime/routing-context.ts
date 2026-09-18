import type { MavisBuildEnv } from '@mavis/config';

/** Read the managed-routing gate without a config fallback. */
export function getRawRuntimeBuildEnv(): MavisBuildEnv | undefined {
  const value = process.env.MAVIS_BUILD_ENV;
  return value === 'dev' || value === 'test' || value === 'staging' || value === 'prod'
    ? value
    : undefined;
}
