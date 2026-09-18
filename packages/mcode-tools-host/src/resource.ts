import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  validateEmbeddedResourceFiles,
  validateEmbeddedResourceManifest,
} from './resource-manifest.mjs';

import {
  AUTH_LEASE_PROTOCOL_PACKAGE_NAME,
  AUTH_LEASE_PROTOCOL_PACKAGE_VERSION,
  AUTH_LEASE_PROTOCOL_VERSION,
} from '@mavis/oauth-lease-protocol';

export type McodeToolsBuildEnv = 'test' | 'staging' | 'prod';
export type McodeToolsRegion = 'cn' | 'en';

export interface McodeToolsManifest {
  schemaVersion: 3 | 4;
  packageName: string;
  version: string;
  gitSha: string;
  buildEnv: McodeToolsBuildEnv;
  bedrockLane: string;
  nodeRange: string;
  entry: 'cli.mjs';
  auth: {
    mode: 'shared-broker';
    protocol: {
      name: typeof AUTH_LEASE_PROTOCOL_PACKAGE_NAME;
      version: typeof AUTH_LEASE_PROTOCOL_PACKAGE_VERSION;
      wireVersion: typeof AUTH_LEASE_PROTOCOL_VERSION;
    };
  };
  nativePackages: { name: 'registry-js'; version: string; napiVersion: 3 }[];
  resources: [{ path: 'cli.mjs'; sha256: string }, ...{ path: string; sha256: string }[]];
}

export interface ValidatedMcodeToolsResource {
  rootDir: string;
  cliPath: string;
  manifest: McodeToolsManifest;
}

export function validateMcodeToolsResource(options: {
  resourceDir: string;
  expectedBuildEnv: McodeToolsBuildEnv;
}): ValidatedMcodeToolsResource {
  const manifestPath = path.join(options.resourceDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('mcode-tools manifest is missing');

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('mcode-tools manifest is not valid JSON');
  }
  const manifest = parseManifest(value);
  if (manifest.buildEnv !== options.expectedBuildEnv) {
    throw new Error(
      `mcode-tools build environment mismatch: expected ${options.expectedBuildEnv}, received ${manifest.buildEnv}`,
    );
  }
  const expectedPackageName = packageNameForBuildEnv(options.expectedBuildEnv);
  if (manifest.packageName !== expectedPackageName) {
    throw new Error(
      `mcode-tools package mismatch: expected ${expectedPackageName}, received ${manifest.packageName}`,
    );
  }

  const cliPath = path.join(options.resourceDir, manifest.entry);
  if (!existsSync(cliPath)) throw new Error('mcode-tools embedded cli is missing');
  validateEmbeddedResourceFiles(options.resourceDir, manifest);

  return { rootDir: options.resourceDir, cliPath, manifest };
}

export async function installMcodeToolsLauncher(options: {
  resourceDir: string;
  expectedBuildEnv: McodeToolsBuildEnv;
  dataDir: string;
  executable: string;
  platform: NodeJS.Platform;
  region: McodeToolsRegion;
  bedrockLane?: string;
  brokerEndpoint: string;
  brokerCapabilityFile: string;
}): Promise<{
  launcherPath: string;
  regionalLauncherPath: string;
  resource: ValidatedMcodeToolsResource;
}> {
  const resource = validateMcodeToolsResource(options);
  const binDir = path.join(options.dataDir, 'bin');
  const configDir = path.join(options.dataDir, 'integrations', 'mcode-tools', options.region);
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(binDir, 0o700);
  chmodSync(configDir, 0o700);

  const isWindows = options.platform === 'win32';
  const launcherPath = path.join(binDir, isWindows ? 'mcode-tools.cmd' : 'mcode-tools');
  const regionLabel = options.region === 'cn' ? 'cn' : 'global';
  const regionalLauncherPath = path.join(
    binDir,
    isWindows ? `mcode-tools-${regionLabel}.cmd` : `mcode-tools-${regionLabel}`,
  );
  const staleLauncherPaths = isWindows
    ? ['mcode-tools', 'mcode-tools-cn', 'mcode-tools-global']
    : ['mcode-tools.cmd', 'mcode-tools-cn.cmd', 'mcode-tools-global.cmd'];
  const bedrockLane = resolveManagedBedrockLane(options.bedrockLane);
  const contents = isWindows
    ? renderWindowsLauncher({
        executable: options.executable,
        cliPath: resource.cliPath,
        configDir,
        region: options.region,
        ...(bedrockLane ? { bedrockLane } : {}),
        brokerEndpoint: options.brokerEndpoint,
        brokerCapabilityFile: options.brokerCapabilityFile,
      })
    : renderPosixLauncher({
        executable: options.executable,
        cliPath: resource.cliPath,
        configDir,
        region: options.region,
        ...(bedrockLane ? { bedrockLane } : {}),
        brokerEndpoint: options.brokerEndpoint,
        brokerCapabilityFile: options.brokerCapabilityFile,
      });
  const dispatcher = isWindows ? renderWindowsDispatcher() : renderPosixDispatcher();

  writeFileIfChanged(regionalLauncherPath, contents, isWindows ? 0o600 : 0o755);
  writeFileIfChanged(launcherPath, dispatcher, isWindows ? 0o600 : 0o755);
  for (const staleName of staleLauncherPaths) {
    rmSync(path.join(binDir, staleName), { force: true });
  }
  return { launcherPath, regionalLauncherPath, resource };
}

export function removeMcodeToolsLaunchers(dataDir: string, region?: McodeToolsRegion): void {
  const binDir = path.join(dataDir, 'bin');
  const regionLabels = region ? [region === 'cn' ? 'cn' : 'global'] : ['cn', 'global'];
  for (const name of regionLabels.flatMap((label) => [
    `mcode-tools-${label}`,
    `mcode-tools-${label}.cmd`,
  ])) {
    rmSync(path.join(binDir, name), { force: true });
  }
  const hasRegionalLauncher = ['cn', 'global'].some(
    (label) =>
      existsSync(path.join(binDir, `mcode-tools-${label}`)) ||
      existsSync(path.join(binDir, `mcode-tools-${label}.cmd`)),
  );
  if (!hasRegionalLauncher) {
    rmSync(path.join(binDir, 'mcode-tools'), { force: true });
    rmSync(path.join(binDir, 'mcode-tools.cmd'), { force: true });
  }
}

function renderPosixDispatcher(): string {
  return [
    '#!/bin/sh',
    'mcode_tools_bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    ['mcode_tools_region=$', '{MCODE_REGION:-$', '{MAVIS_REGION:-}}'].join(''),
    'case "$mcode_tools_region" in',
    '  cn) mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-cn" ;;',
    '  en|global) mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-global" ;;',
    '  "")',
    '    if [ -x "$mcode_tools_bin_dir/mcode-tools-cn" ] && [ ! -x "$mcode_tools_bin_dir/mcode-tools-global" ]; then',
    '      mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-cn"',
    '    elif [ -x "$mcode_tools_bin_dir/mcode-tools-global" ] && [ ! -x "$mcode_tools_bin_dir/mcode-tools-cn" ]; then',
    '      mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-global"',
    '    else',
    '      echo "MCODE_REGION must be cn or global when both regional mcode-tools launchers are installed." >&2',
    '      exit 2',
    '    fi',
    '    ;;',
    '  *) echo "Invalid MCODE_REGION; expected cn or global." >&2; exit 2 ;;',
    'esac',
    'exec "$mcode_tools_target" "$@"',
    '',
  ].join('\n');
}

function renderWindowsDispatcher(): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "mcode_tools_region=%MCODE_REGION%"',
    'if not defined mcode_tools_region set "mcode_tools_region=%MAVIS_REGION%"',
    'if /i "%mcode_tools_region%"=="cn" goto mcode_tools_cn',
    'if /i "%mcode_tools_region%"=="en" goto mcode_tools_global',
    'if /i "%mcode_tools_region%"=="global" goto mcode_tools_global',
    'if defined mcode_tools_region goto mcode_tools_invalid',
    'if exist "%~dp0mcode-tools-cn.cmd" if not exist "%~dp0mcode-tools-global.cmd" goto mcode_tools_cn',
    'if exist "%~dp0mcode-tools-global.cmd" if not exist "%~dp0mcode-tools-cn.cmd" goto mcode_tools_global',
    'echo MCODE_REGION must be cn or global when both regional mcode-tools launchers are installed. 1>&2',
    'exit /b 2',
    ':mcode_tools_cn',
    'call "%~dp0mcode-tools-cn.cmd" %*',
    'exit /b %ERRORLEVEL%',
    ':mcode_tools_global',
    'call "%~dp0mcode-tools-global.cmd" %*',
    'exit /b %ERRORLEVEL%',
    ':mcode_tools_invalid',
    'echo Invalid MCODE_REGION; expected cn or global. 1>&2',
    'exit /b 2',
    '',
  ].join('\r\n');
}

export function renderPosixLauncher(options: {
  executable: string;
  cliPath: string;
  configDir: string;
  region: McodeToolsRegion;
  bedrockLane?: string;
  brokerEndpoint: string;
  brokerCapabilityFile: string;
}): string {
  const lines = [
    '#!/bin/sh',
    'unset MAVIS_ACCESS_TOKEN MAVIS_DATA_DIR MINIMAX_DATA_DIR MAVIS_PORT MAVIS_PROFILE IS_SANDBOX MCODE_API_BASE_URL MCODE_AUTH_BASE_URL MCODE_CLIENT_ID MCODE_SCOPE MCODE_AUTH_PROVIDER MCODE_AUTH_BROKER_ENDPOINT MCODE_AUTH_BROKER_CAPABILITY_FILE MCODE_EXTRA_HEADERS',
    "for mcode_tools_name in $(env | sed -n 's/^\\([^=]*\\)=.*$/\\1/p'); do",
    '  case "$mcode_tools_name" in',
    '    __MAVIS_PARENT_*|__MAVIS_RUNTIME_*|AGENTARCHON_*|AGENT_ARCHON_*) unset "$mcode_tools_name" ;;',
    '  esac',
    'done',
    'unset mcode_tools_name',
    'export ELECTRON_RUN_AS_NODE=1',
    `export MCODE_REGION=${quotePosix(options.region)}`,
    `export MCODE_CONFIG_DIR=${quotePosix(options.configDir)}`,
  ];
  lines.push(
    'export MCODE_AUTH_PROVIDER=shared-broker',
    `export MCODE_AUTH_BROKER_ENDPOINT=${quotePosix(options.brokerEndpoint)}`,
    `export MCODE_AUTH_BROKER_CAPABILITY_FILE=${quotePosix(options.brokerCapabilityFile)}`,
  );
  if (options.bedrockLane) {
    lines.push(
      `export MCODE_EXTRA_HEADERS=${quotePosix(`bedrock_lane:${options.bedrockLane},bedrock-lane:${options.bedrockLane}`)}`,
    );
  }
  lines.push(`exec ${quotePosix(options.executable)} ${quotePosix(options.cliPath)} "$@"`, '');
  return lines.join('\n');
}

export function renderWindowsLauncher(options: {
  executable: string;
  cliPath: string;
  configDir: string;
  region: McodeToolsRegion;
  bedrockLane?: string;
  brokerEndpoint: string;
  brokerCapabilityFile: string;
}): string {
  const lines = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "MAVIS_ACCESS_TOKEN="',
    'set "MAVIS_DATA_DIR="',
    'set "MINIMAX_DATA_DIR="',
    'set "MAVIS_PORT="',
    'set "MAVIS_PROFILE="',
    'set "IS_SANDBOX="',
    'set "MCODE_API_BASE_URL="',
    'set "MCODE_AUTH_BASE_URL="',
    'set "MCODE_CLIENT_ID="',
    'set "MCODE_SCOPE="',
    'set "MCODE_AUTH_PROVIDER="',
    'set "MCODE_AUTH_BROKER_ENDPOINT="',
    'set "MCODE_AUTH_BROKER_CAPABILITY_FILE="',
    'set "MCODE_EXTRA_HEADERS="',
    'for /f "tokens=1 delims==" %%V in (\'set __MAVIS_PARENT_ 2^>nul\') do set "%%V="',
    'for /f "tokens=1 delims==" %%V in (\'set __MAVIS_RUNTIME_ 2^>nul\') do set "%%V="',
    'for /f "tokens=1 delims==" %%V in (\'set AGENTARCHON_ 2^>nul\') do set "%%V="',
    'for /f "tokens=1 delims==" %%V in (\'set AGENT_ARCHON_ 2^>nul\') do set "%%V="',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `set "MCODE_REGION=${escapeWindowsBatchValue(options.region)}"`,
    `set "MCODE_CONFIG_DIR=${escapeWindowsBatchValue(options.configDir)}"`,
  ];
  lines.push(
    'set "MCODE_AUTH_PROVIDER=shared-broker"',
    `set "MCODE_AUTH_BROKER_ENDPOINT=${escapeWindowsBatchValue(options.brokerEndpoint)}"`,
    `set "MCODE_AUTH_BROKER_CAPABILITY_FILE=${escapeWindowsBatchValue(options.brokerCapabilityFile)}"`,
  );
  if (options.bedrockLane) {
    lines.push(
      `set "MCODE_EXTRA_HEADERS=${escapeWindowsBatchValue(`bedrock_lane:${options.bedrockLane},bedrock-lane:${options.bedrockLane}`)}"`,
    );
  }
  lines.push(
    `"${escapeWindowsBatchValue(options.executable)}" "${escapeWindowsBatchValue(options.cliPath)}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  );
  return lines.join('\r\n');
}

function parseManifest(value: unknown): McodeToolsManifest {
  if (!value || typeof value !== 'object') throw new Error('mcode-tools manifest is invalid');
  const input = value as Record<string, unknown>;
  const buildEnv = input.buildEnv;
  if (buildEnv !== 'test' && buildEnv !== 'staging' && buildEnv !== 'prod') {
    throw new Error('mcode-tools manifest buildEnv is invalid');
  }
  if (input.entry !== 'cli.mjs') throw new Error('mcode-tools manifest entry is invalid');
  for (const key of ['packageName', 'version', 'gitSha', 'nodeRange'] as const) {
    if (typeof input[key] !== 'string' || input[key].trim().length === 0) {
      throw new Error(`mcode-tools manifest ${key} is invalid`);
    }
  }
  if (typeof input.bedrockLane !== 'string') {
    throw new Error('mcode-tools manifest bedrockLane is invalid');
  }
  if (buildEnv !== 'test' && input.bedrockLane.trim().length > 0) {
    throw new Error('mcode-tools non-test manifest must not select a Bedrock lane');
  }

  const auth = input.auth as Record<string, unknown> | undefined;
  const protocol = auth?.protocol as Record<string, unknown> | undefined;
  if (
    (input.schemaVersion !== 3 && input.schemaVersion !== 4) ||
    auth?.mode !== 'shared-broker' ||
    protocol?.name !== AUTH_LEASE_PROTOCOL_PACKAGE_NAME ||
    protocol?.version !== AUTH_LEASE_PROTOCOL_PACKAGE_VERSION ||
    protocol?.wireVersion !== AUTH_LEASE_PROTOCOL_VERSION
  ) {
    throw new Error('mcode-tools shared-broker lease protocol manifest is incompatible');
  }
  if (hasOwn(input, 'sharedLocal') || hasOwn(input, 'platform') || hasOwn(input, 'arch')) {
    throw new Error(
      'mcode-tools shared-broker manifest must not contain shared-local platform metadata',
    );
  }
  validateEmbeddedResourceManifest(input);
  return input as unknown as McodeToolsManifest;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveManagedBedrockLane(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const lane = value.trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(lane)) {
    throw new Error('mcode-tools Bedrock lane is invalid');
  }
  return lane;
}

function packageNameForBuildEnv(buildEnv: McodeToolsBuildEnv): string {
  if (buildEnv === 'test') return '@minimax/mcode-tools-test';
  if (buildEnv === 'staging') return '@minimax/mcode-tools-staging';
  return '@minimax/mcode-tools';
}

function quotePosix(value: string): string {
  if (/\r|\n|\0/u.test(value)) throw new Error('mcode-tools launcher path contains control data');
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function escapeWindowsBatchValue(value: string): string {
  if (/\r|\n|\0|"/u.test(value)) {
    throw new Error('mcode-tools launcher path contains unsupported characters');
  }
  return value.replace(/%/gu, '%%');
}

function writeFileIfChanged(file: string, contents: string, mode: number): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === contents) {
    chmodSync(file, mode);
    return;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, contents, { mode });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  chmodSync(file, mode);
}
