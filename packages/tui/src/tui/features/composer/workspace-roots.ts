import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, parse, resolve } from 'node:path';
import type { TuiWorkspaceRoot } from '../../../runtime/port.js';

export interface CreateTuiWorkspaceRootsOptions {
  readonly workspaceDir: string;
  readonly workspaceRoots?: readonly TuiWorkspaceRoot[];
  readonly homeDir?: string;
}

export function createTuiWorkspaceRoots(
  options: CreateTuiWorkspaceRootsOptions,
): TuiWorkspaceRoots {
  return new TuiWorkspaceRoots(options.workspaceDir, options.workspaceRoots, options.homeDir);
}

export class TuiWorkspaceRoots {
  private roots: TuiWorkspaceRoot[];

  constructor(
    primaryWorkspaceDir: string,
    initialRoots: readonly TuiWorkspaceRoot[] = [],
    private readonly homeDir = homedir(),
  ) {
    const primary = resolve(primaryWorkspaceDir);
    const roots = [
      { path: primary, label: workspaceRootLabel(primary), primary: true },
      ...initialRoots,
    ];
    const seen = new Set<string>();
    this.roots = roots.flatMap((root) => {
      const path = resolve(root.path);
      const key = workspaceRootKey(path);
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          path,
          label: root.label?.trim() || workspaceRootLabel(path),
          primary: path === primary,
        },
      ];
    });
  }

  list(): TuiWorkspaceRoot[] {
    return this.roots.map((root) => ({ ...root }));
  }

  additionalDirectories(): string[] {
    return this.roots.filter((root) => root.primary !== true).map((root) => root.path);
  }

  async add(reference: string): Promise<TuiWorkspaceRoot> {
    const requested = stripMatchingQuotes(reference.trim());
    if (!requested) throw new Error('Usage: /add-dir <path>');
    if (/[\u0000\r\n]/u.test(requested)) {
      throw new Error('Directory path contains unsupported control characters.');
    }
    const expanded =
      requested === '~'
        ? this.homeDir
        : requested.startsWith('~/') || requested.startsWith('~\\')
          ? resolve(this.homeDir, requested.slice(2))
          : requested;
    const primary = this.roots.find((root) => root.primary)?.path ?? process.cwd();
    const candidate = isAbsolute(expanded) ? resolve(expanded) : resolve(primary, expanded);
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'ENOENT'
          ? `Directory does not exist: ${candidate}`
          : `Unable to inspect directory ${candidate}: ${errorMessage(error)}`,
      );
    }
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error(`Path is not a directory: ${canonical}`);
    if (canonical === parse(canonical).root) {
      throw new Error('Refusing to add a filesystem root; choose a narrower directory.');
    }
    if (workspaceRootKey(canonical) === workspaceRootKey(resolve(this.homeDir))) {
      throw new Error('Refusing to add the whole home directory; choose a narrower directory.');
    }
    const existing = this.roots.find(
      (root) => workspaceRootKey(root.path) === workspaceRootKey(canonical),
    );
    if (existing) return { ...existing };
    if (this.additionalDirectories().length >= 16) {
      throw new Error('A CLI process can use at most 16 additional directories.');
    }
    const root: TuiWorkspaceRoot = {
      path: canonical,
      label: workspaceRootLabel(canonical),
      primary: false,
    };
    this.roots = [...this.roots, root];
    return { ...root };
  }
}

function workspaceRootKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase() : path;
}

function workspaceRootLabel(path: string): string {
  return basename(path) || path;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
