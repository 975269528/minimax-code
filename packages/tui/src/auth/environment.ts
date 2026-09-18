import { getRuntimeBuildEnv, type MavisBuildEnv, type MavisRegion } from '@mavis/config';
import {
  resolveProductBuildIdentity,
  type ProductBuildIdentity,
} from '@mavis/shared/product-build-identity';

export type TuiBuildEnvironment = 'test' | 'staging' | 'prod';
export type TuiBuildVariant = 'standard' | 'internal';
export type McodeDataEnvironment = TuiBuildEnvironment | 'dev';

declare const __TUI_BUILD_ENV__: TuiBuildEnvironment | undefined;
declare const __TUI_BUILD_VARIANT__: TuiBuildVariant | undefined;

export interface ResolveMcodeAuthEnvironmentOptions {
  readonly embeddedBuildEnvironment?: TuiBuildEnvironment;
  readonly embeddedBuildVariant?: TuiBuildVariant;
  readonly runtimeRegion?: MavisRegion;
  readonly runtimeBuildEnv?: MavisBuildEnv;
}

export interface McodeAuthEnvironment {
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
}

let startupBuildEnvironment: TuiBuildEnvironment | undefined;

export function setMcodeStartupBuildEnvironment(
  environment: TuiBuildEnvironment | undefined,
): void {
  startupBuildEnvironment = environment;
}

export function resolveMcodeBuildIdentity(
  options: ResolveMcodeAuthEnvironmentOptions = {},
): ProductBuildIdentity {
  const embeddedBuildEnvironment =
    options.embeddedBuildEnvironment ?? readEmbeddedBuildEnvironment();
  const embeddedBuildVariant = options.embeddedBuildVariant ?? readEmbeddedBuildVariant();
  const runtimeBuildEnv = options.runtimeBuildEnv ?? getRuntimeBuildEnv();

  return resolveProductBuildIdentity({
    buildEnv: embeddedBuildEnvironment ?? normalizeRuntimeBuildEnvironment(runtimeBuildEnv),
    internalBuild: embeddedBuildVariant === 'internal',
  });
}

export function resolveMcodeAuthEnvironment(
  options: ResolveMcodeAuthEnvironmentOptions = {},
): McodeAuthEnvironment {
  const buildIdentity = resolveMcodeBuildIdentity(options);

  return {
    region: options.runtimeRegion ?? 'cn',
    buildEnv: startupBuildEnvironment ?? buildIdentity.buildEnv ?? 'test',
  };
}

export function resolveMcodeDataEnvironment(
  embeddedBuildEnvironment: TuiBuildEnvironment | undefined = readEmbeddedBuildEnvironment(),
): McodeDataEnvironment {
  return startupBuildEnvironment ?? embeddedBuildEnvironment ?? 'dev';
}

function readEmbeddedBuildEnvironment(): TuiBuildEnvironment | undefined {
  if (typeof __TUI_BUILD_ENV__ === 'undefined') return undefined;
  return __TUI_BUILD_ENV__;
}

function readEmbeddedBuildVariant(): TuiBuildVariant | undefined {
  if (typeof __TUI_BUILD_VARIANT__ === 'undefined') return undefined;
  return __TUI_BUILD_VARIANT__;
}

function normalizeRuntimeBuildEnvironment(environment: MavisBuildEnv): MavisBuildEnv {
  return environment === 'dev' ? 'test' : environment;
}
