import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

import type { PluginHookCommandHandler, PluginHookSourceFormat } from './contracts.js';

export interface HookCommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export interface HookCommandInvocationInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly shell?: PluginHookCommandHandler['shell'];
  readonly sourceFormat: PluginHookSourceFormat;
}

export interface HookCommandInvocationDependencies {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly pathExists?: (candidate: string) => boolean;
  readonly findExecutable?: (name: string) => string | undefined;
}

/** Resolves compatible shell-form commands without relying on cmd.exe on Windows. */
export function resolveHookCommandInvocation(
  input: HookCommandInvocationInput,
  dependencies: HookCommandInvocationDependencies = {},
): HookCommandInvocation {
  if (input.args) return { command: input.command, args: input.args, shell: false };
  const platform = dependencies.platform ?? process.platform;
  if (input.sourceFormat !== 'CLAUDE') {
    if (input.shell === 'bash')
      return { command: 'bash', args: ['-c', input.command], shell: false };
    if (input.shell === 'powershell') {
      return powershellInvocation(input.command, platform, dependencies);
    }
    return { command: input.command, args: [], shell: true };
  }

  if (platform !== 'win32') {
    if (input.shell === 'powershell')
      return powershellInvocation(input.command, platform, dependencies);
    return {
      command: input.shell === 'bash' ? 'bash' : 'sh',
      args: ['-c', input.command],
      shell: false,
    };
  }

  if (input.shell === 'powershell')
    return powershellInvocation(input.command, platform, dependencies);
  const gitBash = findWindowsGitBash(dependencies);
  if (gitBash) return { command: gitBash, args: ['-c', input.command], shell: false };
  if (input.shell === 'bash') {
    throw new Error('Compatible Hook requested Git Bash, but Git Bash is unavailable');
  }
  return powershellInvocation(input.command, platform, dependencies);
}

function powershellInvocation(
  command: string,
  platform: NodeJS.Platform,
  dependencies: HookCommandInvocationDependencies,
): HookCommandInvocation {
  const executable =
    platform === 'win32'
      ? (findExecutable(dependencies, 'pwsh.exe', platform) ?? 'powershell.exe')
      : (findExecutable(dependencies, 'pwsh', platform) ?? 'pwsh');
  return {
    command: executable,
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
    shell: false,
  };
}

function findWindowsGitBash(dependencies: HookCommandInvocationDependencies): string | undefined {
  const environment = dependencies.environment ?? process.env;
  const pathExists = dependencies.pathExists ?? existsSync;
  const gitBashEnvironmentKey = ['CLA', 'UDE_CODE_GIT_BASH_PATH'].join('');
  const configured = environment[gitBashEnvironmentKey]?.trim();
  const candidates = [
    configured,
    environment.ProgramFiles && win32.join(environment.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    environment.ProgramW6432 && win32.join(environment.ProgramW6432, 'Git', 'bin', 'bash.exe'),
    environment['ProgramFiles(x86)'] &&
      win32.join(environment['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    environment.LOCALAPPDATA &&
      win32.join(environment.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate && pathExists(candidate)) return candidate;
  }

  const git = findExecutable(dependencies, 'git.exe', 'win32');
  if (git) {
    const gitDirectory = win32.dirname(git);
    const derived =
      win32.basename(gitDirectory).toLowerCase() === 'cmd'
        ? win32.join(win32.dirname(gitDirectory), 'bin', 'bash.exe')
        : win32.join(gitDirectory, 'bash.exe');
    if (pathExists(derived)) return derived;
  }
  const bash = findExecutable(dependencies, 'bash.exe', 'win32');
  if (bash && /[\\/]Git[\\/]/iu.test(bash) && pathExists(bash)) return bash;
  return undefined;
}

function findExecutable(
  dependencies: HookCommandInvocationDependencies,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (dependencies.findExecutable) return dependencies.findExecutable(name);
  const finder = platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, [name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 1_000,
  });
  if (result.status !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}
