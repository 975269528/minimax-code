import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ShellCompletion {
  readonly value: string;
  readonly directory: boolean;
}

const POSIX_BUILTINS = [
  'alias',
  'bg',
  'cd',
  'command',
  'echo',
  'eval',
  'exec',
  'exit',
  'export',
  'fg',
  'jobs',
  'printf',
  'pwd',
  'read',
  'set',
  'source',
  'test',
  'type',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
];
const POWERSHELL_COMMANDS = [
  'cd',
  'clear',
  'echo',
  'exit',
  'Get-ChildItem',
  'Get-Command',
  'Get-Content',
  'Get-Location',
  'Get-Process',
  'ls',
  'mkdir',
  'pwd',
  'Set-Location',
  'Write-Output',
];

/** Reads candidates without evaluating the draft or sourcing shell startup scripts. */
export class ShellCompletionSource {
  private cachedCommands: { key: string; expires: number; names: string[] } | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    readonly windows = process.platform === 'win32',
  ) {}

  async complete(
    query: string,
    cwd: string,
    command: boolean,
    directoriesOnly: boolean,
    signal: AbortSignal,
  ): Promise<ShellCompletion[]> {
    if (signal.aborted) return [];
    const pathLike = /[/\\]/u.test(query) || query.startsWith('.') || query.startsWith('~');
    if (command && !pathLike) {
      const names = await this.commandNames(cwd, signal);
      return names
        .filter((name) => this.matches(name, query))
        .slice(0, 100)
        .map((value) => ({ value, directory: false }));
    }
    const normalized = this.windows ? query.replaceAll('\\', '/') : query;
    const slash = normalized.lastIndexOf('/');
    const parent = slash < 0 ? '' : normalized.slice(0, slash + 1);
    const namePrefix = normalized.slice(slash + 1);
    const expanded = parent.startsWith('~/') ? path.join(os.homedir(), parent.slice(2)) : parent;
    const directory = path.resolve(cwd, expanded || '.');
    const completionParent = parent.startsWith('~/') ? `${directory}/` : parent;
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const candidates: ShellCompletion[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (signal.aborted) return [];
        if (!this.matches(entry.name, namePrefix) || /[\x00-\x1f\x7f]/u.test(entry.name)) continue;
        if (entry.name.startsWith('.') && !namePrefix.startsWith('.')) continue;
        const target = path.join(directory, entry.name);
        const info = entry.isSymbolicLink() ? await stat(target).catch(() => undefined) : entry;
        if (!info) continue;
        const isDirectory = info.isDirectory();
        if (directoriesOnly && !isDirectory) continue;
        if (command && !isDirectory && !(await this.executable(target))) continue;
        const relativePrefix = !completionParent && entry.name.startsWith('-') ? './' : '';
        candidates.push({
          value: `${completionParent}${relativePrefix}${entry.name}${isDirectory ? '/' : ''}`,
          directory: isDirectory,
        });
        if (candidates.length >= 100) break;
      }
      return candidates.sort((a, b) => Number(b.directory) - Number(a.directory));
    } catch {
      return [];
    }
  }

  private matches(name: string, prefix: string): boolean {
    return this.windows
      ? name.toLowerCase().startsWith(prefix.toLowerCase())
      : name.startsWith(prefix);
  }

  private async executable(target: string): Promise<boolean> {
    if (this.windows) {
      const extensions = (this.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1').toLowerCase().split(';');
      return extensions.includes(path.extname(target).toLowerCase());
    }
    return access(target, constants.X_OK).then(
      () => true,
      () => false,
    );
  }

  private async commandNames(cwd: string, signal: AbortSignal): Promise<string[]> {
    const searchPath = this.env.PATH ?? this.env.Path ?? '';
    const key = `${cwd}\0${searchPath}\0${this.env.PATHEXT ?? ''}`;
    if (this.cachedCommands?.key === key && this.cachedCommands.expires > Date.now())
      return this.cachedCommands.names;
    const names = new Set(this.windows ? POWERSHELL_COMMANDS : POSIX_BUILTINS);
    for (const directory of new Set(searchPath.split(this.windows ? ';' : ':'))) {
      if (signal.aborted) return [];
      const base = path.resolve(cwd, directory || '.');
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (signal.aborted) return [];
        if (entry.isDirectory() || /[\s\x00-\x1f\x7f]/u.test(entry.name)) continue;
        const target = path.join(base, entry.name);
        if (entry.isSymbolicLink() && !(await stat(target).catch(() => undefined))?.isFile())
          continue;
        if (await this.executable(target)) names.add(entry.name);
      }
    }
    const result = [...names].sort((a, b) => a.localeCompare(b));
    if (!signal.aborted) this.cachedCommands = { key, expires: Date.now() + 5_000, names: result };
    return result;
  }
}

export function escapeShellCompletion(value: string, windows: boolean): string {
  const escape = windows ? '`' : '\\';
  return value.replace(/[^\p{L}\p{N}_./:-]/gu, (character) => `${escape}${character}`);
}
