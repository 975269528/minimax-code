import { execFile } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, delimiter, extname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

export const EVAL_META_INFO_SCHEMA = 'mavis.eval_meta_info.v1' as const;

export type EvalRuntimeKind = 'desktop' | 'cloud';
export type EvalConfigFileKind = 'project';

export interface EvalMetaInfoSystemInput {
  readonly osName: string;
  readonly osVersion: string;
  readonly arch: string;
}

export interface EvalMetaInfoRuntimeVersion {
  readonly name: 'node' | 'python' | 'java';
  readonly version: string;
}

export interface EvalMetaInfoEnvironmentInput {
  readonly timeZone: string;
  readonly locale: string;
  readonly terminal: string;
  readonly shell: string;
  readonly pathCommands: readonly string[];
  readonly pathScanTruncated?: boolean;
  readonly runtimes: readonly EvalMetaInfoRuntimeVersion[];
}

export interface EvalMetaInfoWorkspaceEntry {
  readonly kind: 'directory' | 'file';
  readonly path: string;
  readonly size_bytes?: number;
}

export interface EvalMetaInfoFileType {
  readonly extension: string;
  readonly file_count: number;
  readonly total_bytes: number;
}

export interface EvalMetaInfoConfigFile {
  readonly kind: EvalConfigFileKind;
  readonly path: string;
  readonly size_bytes: number;
  readonly updated_at_ms: number;
}

export interface EvalMetaInfoGit {
  readonly branch?: string;
  readonly remote_branch?: string;
  readonly commit?: string;
}

export interface EvalMetaInfo {
  readonly schema: typeof EVAL_META_INFO_SCHEMA;
  readonly collected_at_ms: number;
  readonly runtime: {
    readonly kind: EvalRuntimeKind;
    readonly version: string;
    readonly node_version: string;
  };
  readonly system: {
    readonly os_name: string;
    readonly os_version: string;
    readonly arch: string;
    readonly timezone: string;
    readonly locale: string;
    readonly terminal: string;
  };
  readonly environment: {
    readonly shell: string;
    readonly path_commands: readonly string[];
    readonly path_scan_truncated: boolean;
    readonly runtimes: readonly EvalMetaInfoRuntimeVersion[];
  };
  readonly workspace: {
    readonly name: string;
    readonly current_directory: '.';
    readonly total_files: number;
    readonly total_bytes: number;
    readonly file_types: readonly EvalMetaInfoFileType[];
    readonly scan_truncated: boolean;
    readonly directory_tree: readonly EvalMetaInfoWorkspaceEntry[];
    readonly tree_truncated: boolean;
    readonly git?: EvalMetaInfoGit;
  };
  readonly config_files: readonly EvalMetaInfoConfigFile[];
}

export interface CollectEvalMetaInfoOptions {
  readonly runtime: EvalRuntimeKind;
  readonly runtimeVersion: string;
  readonly workspaceDir: string;
  readonly maxFiles?: number;
  readonly maxDirectories?: number;
  readonly nowMs?: () => number;
  readonly systemInfo?: EvalMetaInfoSystemInput;
  readonly environmentInfo?: EvalMetaInfoEnvironmentInput;
  readonly runGit?: (args: readonly string[]) => Promise<string | undefined>;
}

interface WorkspaceScan {
  totalFiles: number;
  totalBytes: number;
  fileTypes: EvalMetaInfoFileType[];
  configFiles: EvalMetaInfoConfigFile[];
  directoryTree: EvalMetaInfoWorkspaceEntry[];
  treeTruncated: boolean;
  truncated: boolean;
}

interface FileTypeAccumulator {
  fileCount: number;
  totalBytes: number;
}

interface PathCommandInventory {
  commands: string[];
  truncated: boolean;
}

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_DIRECTORIES = 5_000;
const FILE_STAT_CONCURRENCY = 64;
const MAX_DIRECTORY_TREE_ENTRIES = 2_000;
const MAX_PATH_DIRECTORIES = 128;
const MAX_PATH_COMMANDS = 2_000;
const GIT_TIMEOUT_MS = 1_500;
const GIT_MAX_OUTPUT_BYTES = 64 << 10;
const NO_EXTENSION = '[no_extension]';

const EXCLUDED_DIRECTORY_BY_NAME = new Set([
  '.git',
  '.next',
  '.pnpm',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

const PROJECT_CONFIG_FILE_NAMES = new Set([
  '.nvmrc',
  '.python-version',
  '.tool-versions',
  'build.gradle',
  'build.gradle.kts',
  'cargo.lock',
  'cargo.toml',
  'cmakelists.txt',
  'composer.json',
  'docker-compose.yaml',
  'docker-compose.yml',
  'dockerfile',
  'gemfile',
  'go.mod',
  'go.sum',
  'makefile',
  'package.json',
  'pnpm-workspace.yaml',
  'pom.xml',
  'poetry.lock',
  'pyproject.toml',
  'requirements.txt',
  'settings.gradle',
  'tsconfig.json',
  'uv.lock',
]);

const OS_NAME_BY_PLATFORM: Record<string, string | undefined> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

// Automatic collection may inventory PATH filenames but must never execute them.
// Git metadata uses only administrator-owned fixed paths under a minimal environment.
const TRUSTED_GIT_EXECUTABLES_BY_PLATFORM: Readonly<Record<string, readonly string[]>> = {
  darwin: ['/usr/bin/git'],
  linux: ['/usr/bin/git'],
  win32: ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'],
};

const TRUSTED_GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: platform() === 'win32' ? 'NUL' : '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '',
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
};

export async function collectEvalMetaInfo(
  options: CollectEvalMetaInfoOptions,
): Promise<EvalMetaInfo> {
  const collectedAtMs = (options.nowMs ?? Date.now)();
  const maxFiles =
    typeof options.maxFiles === 'number' &&
    Number.isInteger(options.maxFiles) &&
    options.maxFiles > 0
      ? options.maxFiles
      : DEFAULT_MAX_FILES;
  const maxDirectories =
    typeof options.maxDirectories === 'number' &&
    Number.isInteger(options.maxDirectories) &&
    options.maxDirectories > 0
      ? options.maxDirectories
      : DEFAULT_MAX_DIRECTORIES;
  const [workspace, git, environment] = await Promise.all([
    scanWorkspace(options.workspaceDir, maxFiles, maxDirectories),
    collectGitInfo(options.workspaceDir, options.runGit),
    options.environmentInfo ? Promise.resolve(options.environmentInfo) : collectEnvironmentInfo(),
  ]);
  const system = options.systemInfo ?? readSystemInfo();

  return {
    schema: EVAL_META_INFO_SCHEMA,
    collected_at_ms: collectedAtMs,
    runtime: {
      kind: options.runtime,
      version: options.runtimeVersion || 'unknown',
      node_version: process.versions.node ?? 'unknown',
    },
    system: {
      os_name: system.osName,
      os_version: system.osVersion,
      arch: system.arch,
      timezone: environment.timeZone,
      locale: environment.locale,
      terminal: environment.terminal,
    },
    environment: {
      shell: environment.shell,
      path_commands: environment.pathCommands,
      path_scan_truncated: environment.pathScanTruncated ?? false,
      runtimes: environment.runtimes,
    },
    workspace: {
      name: basename(options.workspaceDir) || 'workspace',
      current_directory: '.',
      total_files: workspace.totalFiles,
      total_bytes: workspace.totalBytes,
      file_types: workspace.fileTypes,
      scan_truncated: workspace.truncated,
      directory_tree: workspace.directoryTree,
      tree_truncated: workspace.treeTruncated,
      ...(git ? { git } : {}),
    },
    config_files: workspace.configFiles,
  };
}

async function collectEnvironmentInfo(): Promise<EvalMetaInfoEnvironmentInput> {
  const dateTimeOptions = readDateTimeOptions();
  const pathInventory = await scanPathCommands();
  const runtimes: EvalMetaInfoRuntimeVersion[] = [
    { name: 'node', version: process.versions.node ?? 'unknown' },
  ];

  const shellPath = process.env.SHELL || process.env.ComSpec || process.env.COMSPEC;
  const terminal =
    process.env.TERM_PROGRAM ||
    (process.env.WT_SESSION ? 'Windows Terminal' : undefined) ||
    process.env.TERM;
  return {
    timeZone: dateTimeOptions.timeZone,
    locale: dateTimeOptions.locale,
    terminal: normalizeEnvironmentLabel(terminal),
    shell: normalizeEnvironmentLabel(shellPath ? basename(shellPath) : undefined),
    pathCommands: pathInventory.commands,
    pathScanTruncated: pathInventory.truncated,
    runtimes,
  };
}

function readDateTimeOptions(): { timeZone: string; locale: string } {
  try {
    const options = Intl.DateTimeFormat().resolvedOptions();
    return {
      timeZone: normalizeEnvironmentLabel(options.timeZone, 'UTC'),
      locale: normalizeEnvironmentLabel(options.locale),
    };
  } catch {
    return { timeZone: 'UTC', locale: 'unknown' };
  }
}

async function scanPathCommands(): Promise<PathCommandInventory> {
  const rawDirectories = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0 && isAbsolute(entry));
  const directories = [...new Set(rawDirectories)];
  const commandSet = new Set<string>();
  let truncated = directories.length > MAX_PATH_DIRECTORIES;

  for (const directory of directories.slice(0, MAX_PATH_DIRECTORIES)) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const command = normalizeCommandName(entry.name);
      if (!command) continue;
      commandSet.add(command);
      if (commandSet.size >= MAX_PATH_COMMANDS) {
        truncated = true;
        break;
      }
    }
    if (commandSet.size >= MAX_PATH_COMMANDS) break;
  }

  return {
    commands: [...commandSet].sort((left, right) => left.localeCompare(right)),
    truncated,
  };
}

function normalizeCommandName(fileName: string): string | undefined {
  const value =
    platform() === 'win32' ? fileName.replace(/\.(?:bat|cmd|com|exe)$/iu, '') : fileName;
  if (!/^[a-z0-9][a-z0-9._+@-]{0,127}$/iu.test(value)) return undefined;
  return value;
}

function normalizeEnvironmentLabel(value: string | undefined, fallback = 'unknown'): string {
  const normalized = value?.replace(/[\u0000-\u001F\u007F]/gu, ' ').trim();
  return normalized ? normalized.slice(0, 128) : fallback;
}

function readSystemInfo(): EvalMetaInfoSystemInput {
  const currentPlatform = platform();
  return {
    osName: OS_NAME_BY_PLATFORM[currentPlatform] ?? currentPlatform,
    osVersion: release(),
    arch: arch(),
  };
}

async function scanWorkspace(
  root: string,
  maxFiles: number,
  maxDirectories: number,
): Promise<WorkspaceScan> {
  const directories = [root];
  const byExtension = new Map<string, FileTypeAccumulator>();
  const configFiles: EvalMetaInfoConfigFile[] = [];
  const directoryTree: EvalMetaInfoWorkspaceEntry[] = [];
  let totalFiles = 0;
  let totalBytes = 0;
  let truncated = false;
  let treeTruncated = false;
  let directoriesScanned = 0;

  while (directories.length > 0) {
    if (totalFiles >= maxFiles || directoriesScanned >= maxDirectories) {
      truncated = true;
      treeTruncated = true;
      break;
    }
    const directory = directories.pop();
    if (!directory) break;
    directoriesScanned += 1;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    const childDirectories: string[] = [];
    const files: Array<{ name: string; path: string }> = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORY_BY_NAME.has(entry.name.toLowerCase())) continue;
        childDirectories.push(entryPath);
        if (directoryTree.length < MAX_DIRECTORY_TREE_ENTRIES) {
          directoryTree.push({ kind: 'directory', path: workspaceRelativePath(root, entryPath) });
        } else {
          treeTruncated = true;
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (totalFiles + files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push({ name: entry.name, path: entryPath });
    }
    while (childDirectories.length > 0) {
      const childDirectory = childDirectories.pop();
      if (childDirectory !== undefined) directories.push(childDirectory);
    }

    for (let offset = 0; offset < files.length; offset += FILE_STAT_CONCURRENCY) {
      const fileStats = await Promise.all(
        files.slice(offset, offset + FILE_STAT_CONCURRENCY).map(async (file) => {
          try {
            return { file, stats: await lstat(file.path) };
          } catch {
            return undefined;
          }
        }),
      );
      for (const item of fileStats) {
        if (!item?.stats.isFile()) continue;
        totalFiles += 1;
        totalBytes += item.stats.size;
        const extension = extname(item.file.name).toLowerCase() || NO_EXTENSION;
        const aggregate = byExtension.get(extension) ?? { fileCount: 0, totalBytes: 0 };
        aggregate.fileCount += 1;
        aggregate.totalBytes += item.stats.size;
        byExtension.set(extension, aggregate);

        const relativePath = workspaceRelativePath(root, item.file.path);
        if (directoryTree.length < MAX_DIRECTORY_TREE_ENTRIES) {
          directoryTree.push({ kind: 'file', path: relativePath, size_bytes: item.stats.size });
        } else {
          treeTruncated = true;
        }
        if (PROJECT_CONFIG_FILE_NAMES.has(item.file.name.toLowerCase())) {
          configFiles.push({
            kind: 'project',
            path: relativePath,
            size_bytes: item.stats.size,
            updated_at_ms: Math.floor(item.stats.mtimeMs),
          });
        }
      }
    }
  }

  const fileTypes = [...byExtension.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([extension, value]) => ({
      extension,
      file_count: value.fileCount,
      total_bytes: value.totalBytes,
    }));
  configFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    totalFiles,
    totalBytes,
    fileTypes,
    configFiles,
    directoryTree,
    treeTruncated,
    truncated,
  };
}

function workspaceRelativePath(root: string, path: string): string {
  const value = relative(root, path);
  return sep === '/' ? value : value.split(sep).join('/');
}

async function collectGitInfo(
  workspaceDir: string,
  injectedRunGit?: (args: readonly string[]) => Promise<string | undefined>,
): Promise<EvalMetaInfoGit | undefined> {
  const runGit = injectedRunGit ?? ((args) => runGitCommand(workspaceDir, args));
  const root = await safelyRunGit(runGit, ['rev-parse', '--show-toplevel']);
  if (!root) return undefined;

  const [branch, remoteBranch, commit] = await Promise.all([
    safelyRunGit(runGit, ['branch', '--show-current']),
    safelyRunGit(runGit, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    safelyRunGit(runGit, ['rev-parse', 'HEAD']),
  ]);
  if (!branch && !remoteBranch && !commit) return undefined;
  return {
    ...(branch ? { branch } : {}),
    ...(remoteBranch ? { remote_branch: remoteBranch } : {}),
    ...(commit ? { commit } : {}),
  };
}

async function safelyRunGit(
  runGit: (args: readonly string[]) => Promise<string | undefined>,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const value = await runGit(args);
    const trimmed = value?.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

async function runGitCommand(
  workspaceDir: string,
  args: readonly string[],
): Promise<string | undefined> {
  const executables = TRUSTED_GIT_EXECUTABLES_BY_PLATFORM[platform()] ?? [];
  for (const executable of executables) {
    try {
      const { stdout } = await execFileAsync(executable, ['-C', workspaceDir, ...args], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: TRUSTED_GIT_ENVIRONMENT,
      });
      const value = stdout.trim();
      return value || undefined;
    } catch {
      // Try the next trusted installation path, then fail open.
    }
  }
  return undefined;
}
