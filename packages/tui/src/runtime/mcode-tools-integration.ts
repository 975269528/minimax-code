import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MavisBuildEnv, MavisRegion } from '@mavis/config';
import {
  startMcodeToolsAuthLeaseBroker,
  validateMcodeToolsResource,
  type McodeToolsAuthLeaseBroker,
  type McodeToolsBuildEnv,
  type McodeToolsHostAuthSession,
  type McodeToolsHostLogger,
  type ValidatedMcodeToolsResource,
} from '@mavis/mcode-tools-host';

import {
  activateTuiMcodeToolsHostEnvironment,
  type TuiMcodeToolsHostEnvironmentActivation,
} from '../cli/mcode-tools-environment.js';

export type McodeToolsReadinessCategory =
  | 'disabled'
  | 'ready'
  | 'resource_unavailable'
  | 'broker_unavailable'
  | 'host_unavailable';

export interface McodeToolsReadiness {
  readonly requested: boolean;
  readonly ready: boolean;
  readonly category: McodeToolsReadinessCategory;
  readonly buildEnv: McodeToolsBuildEnv;
  readonly version?: string;
  ensureCommandPath(): void;
  dispose(): Promise<void>;
}

export interface PrepareTuiMcodeToolsIntegrationOptions {
  requested: boolean;
  dataDir: string;
  buildEnv: MavisBuildEnv;
  region: MavisRegion;
  session: McodeToolsHostAuthSession;
  entryUrl: string;
  bedrockLane?: string;
  environment?: Record<string, string | undefined>;
  logger?: McodeToolsHostLogger;
}

export interface PrepareTuiMcodeToolsIntegrationDependencies {
  validateResource?: typeof validateMcodeToolsResource;
  startBroker?: typeof startMcodeToolsAuthLeaseBroker;
  createRuntimeDir?: typeof createTuiMcodeToolsRuntimeDir;
  removeRuntimeDir?: typeof removeTuiMcodeToolsRuntimeDir;
  activateEnvironment?: typeof activateTuiMcodeToolsHostEnvironment;
}

const NOOP_DISPOSE = async (): Promise<void> => undefined;
const NOOP = (): void => undefined;

export function resolveBundledMcodeToolsResourceDir(
  entryUrl: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  if (environment.MAVIS_DEV_MCODE_TOOLS_MODE === 'published') {
    const override = environment.MAVIS_DEV_MCODE_TOOLS_RESOURCE_DIR?.trim();
    if (!override || !path.isAbsolute(override)) {
      throw new Error('MAVIS_DEV_MCODE_TOOLS_RESOURCE_DIR must be an absolute path');
    }
    return path.normalize(override);
  }
  return path.join(path.dirname(fileURLToPath(entryUrl)), 'embedded', 'mcode-tools');
}

export function resolveBundledMcodeToolsCommandBinDir(entryUrl: string): string {
  return path.join(path.dirname(fileURLToPath(entryUrl)), 'internal-bin');
}

export async function prepareTuiMcodeToolsIntegration(
  options: PrepareTuiMcodeToolsIntegrationOptions,
  dependencies: PrepareTuiMcodeToolsIntegrationDependencies = {},
): Promise<McodeToolsReadiness> {
  const buildEnv = normalizeMcodeToolsHostBuildEnv(options.buildEnv);
  if (!options.requested) return inactiveReadiness(false, 'disabled', buildEnv);

  const logger = options.logger ?? { info: () => undefined, warn: () => undefined };
  const environment = options.environment ?? process.env;
  const removeRuntimeDir = dependencies.removeRuntimeDir ?? removeTuiMcodeToolsRuntimeDir;
  let runtimeDir: string | undefined;
  let broker: McodeToolsAuthLeaseBroker | undefined;
  let activation: TuiMcodeToolsHostEnvironmentActivation | undefined;
  try {
    const resource = (dependencies.validateResource ?? validateMcodeToolsResource)({
      resourceDir: resolveBundledMcodeToolsResourceDir(options.entryUrl, environment),
      expectedBuildEnv: buildEnv,
    });
    runtimeDir = await (dependencies.createRuntimeDir ?? createTuiMcodeToolsRuntimeDir)();
    broker = await (dependencies.startBroker ?? startMcodeToolsAuthLeaseBroker)({
      dataDir: runtimeDir,
      session: options.session,
      logger,
    });
    const configDir = path.join(options.dataDir, 'integrations', 'mcode-tools', options.region);
    await ensurePrivateDirectory(configDir);
    activation = (dependencies.activateEnvironment ?? activateTuiMcodeToolsHostEnvironment)(
      environment,
      {
        runtimeExecutable: process.execPath,
        brokerEndpoint: broker.endpoint,
        brokerCapabilityFile: broker.capabilityFile,
        configDir,
        region: options.region,
        commandBinDir: resolveBundledMcodeToolsCommandBinDir(options.entryUrl),
        ...(options.bedrockLane ? { bedrockLane: options.bedrockLane } : {}),
      },
    );
    const readiness = activeReadiness({
      buildEnv,
      resource,
      broker,
      runtimeDir,
      removeRuntimeDir,
      activation,
    });
    logger.info(
      `mcode-tools readiness category=${readiness.category} buildEnv=${buildEnv} region=${options.region} version=${resource.manifest.version}`,
    );
    return readiness;
  } catch (error) {
    activation?.restore();
    await broker?.dispose().catch(() => undefined);
    if (runtimeDir) await removeRuntimeDir(runtimeDir).catch(() => undefined);
    const category = classifyReadinessFailure(error);
    logger.warn(
      `mcode-tools readiness category=${category} buildEnv=${buildEnv} region=${options.region}`,
    );
    return inactiveReadiness(true, category, buildEnv);
  }
}

export function normalizeMcodeToolsHostBuildEnv(buildEnv: MavisBuildEnv): McodeToolsBuildEnv {
  return buildEnv === 'dev' ? 'test' : buildEnv;
}

export async function createTuiMcodeToolsRuntimeDir(): Promise<string> {
  // macOS Unix-domain sockets have a short path limit. `/tmp` keeps the
  // process-private broker endpoint bounded even when the user's dataDir is long.
  const parent = process.platform === 'win32' ? tmpdir() : '/tmp';
  const runtimeDir = await mkdtemp(path.join(parent, `mcode-tools-tui-${process.pid}-`));
  if (process.platform !== 'win32') await chmod(runtimeDir, 0o700);
  return runtimeDir;
}

export function removeTuiMcodeToolsRuntimeDir(runtimeDir: string): Promise<void> {
  return rm(runtimeDir, { recursive: true, force: true });
}

function activeReadiness(options: {
  buildEnv: McodeToolsBuildEnv;
  resource: ValidatedMcodeToolsResource;
  broker: McodeToolsAuthLeaseBroker;
  runtimeDir: string;
  removeRuntimeDir: (runtimeDir: string) => Promise<void>;
  activation: TuiMcodeToolsHostEnvironmentActivation;
}): McodeToolsReadiness {
  let disposed = false;
  return {
    requested: true,
    ready: true,
    category: 'ready',
    buildEnv: options.buildEnv,
    version: options.resource.manifest.version,
    ensureCommandPath: options.activation.ensureCommandPath,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      options.activation.restore();
      const errors: unknown[] = [];
      try {
        await options.broker.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await options.removeRuntimeDir(options.runtimeDir);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'mcode-tools TUI cleanup failed');
    },
  };
}

function inactiveReadiness(
  requested: boolean,
  category: Exclude<McodeToolsReadinessCategory, 'ready'>,
  buildEnv: McodeToolsBuildEnv,
): McodeToolsReadiness {
  return {
    requested,
    ready: false,
    category,
    buildEnv,
    ensureCommandPath: NOOP,
    dispose: NOOP_DISPOSE,
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

function classifyReadinessFailure(
  error: unknown,
): Exclude<McodeToolsReadinessCategory, 'disabled' | 'ready'> {
  if (isErrorCode(error, 'EADDRINUSE')) return 'broker_unavailable';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    [
      'manifest',
      'resource',
      'sha256',
      'build environment',
      'package mismatch',
      'embedded cli',
    ].some((needle) => message.includes(needle))
  ) {
    return 'resource_unavailable';
  }
  if (message.includes('broker') || message.includes('socket') || message.includes('named pipe')) {
    return 'broker_unavailable';
  }
  return 'host_unavailable';
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code,
  );
}
