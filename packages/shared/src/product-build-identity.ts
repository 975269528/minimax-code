export type ProductBuildEnvironment = 'dev' | 'test' | 'staging' | 'prod';
export type ProductBuildVariant = 'standard' | 'internal' | 'inside';

export interface ProductBuildIdentity {
  readonly buildEnv: ProductBuildEnvironment | undefined;
  readonly variant: ProductBuildVariant;
  readonly isDev: boolean;
  readonly isTest: boolean;
  readonly isStaging: boolean;
  readonly isProd: boolean;
  readonly isInternalBuild: boolean;
  readonly isInsideBuild: boolean;
}

export interface ResolveProductBuildIdentityOptions {
  readonly buildEnv?: string;
  readonly internalBuild?: boolean;
  readonly insideBuild?: boolean;
}

export function resolveProductBuildIdentity(
  options: ResolveProductBuildIdentityOptions = {},
): ProductBuildIdentity {
  const isInternalBuild = options.internalBuild === true;
  const isInsideBuild = options.insideBuild === true;

  if (isInternalBuild && isInsideBuild) {
    throw new Error('A product build cannot be both internal and inside');
  }

  const buildEnv = normalizeProductBuildEnvironment(options.buildEnv);
  const variant: ProductBuildVariant = isInsideBuild
    ? 'inside'
    : isInternalBuild
      ? 'internal'
      : 'standard';

  return {
    buildEnv,
    variant,
    isDev: buildEnv === 'dev',
    isTest: buildEnv === 'test',
    isStaging: buildEnv === 'staging',
    isProd: buildEnv === 'prod',
    isInternalBuild,
    isInsideBuild,
  };
}

export function normalizeProductBuildEnvironment(
  buildEnv: string | undefined,
): ProductBuildEnvironment | undefined {
  if (buildEnv === 'development') return 'dev';
  if (buildEnv === 'production') return 'prod';
  if (buildEnv === 'dev' || buildEnv === 'test' || buildEnv === 'staging' || buildEnv === 'prod') {
    return buildEnv;
  }
  return undefined;
}
