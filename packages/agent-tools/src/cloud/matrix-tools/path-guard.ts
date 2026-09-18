import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Input-path fence scope. A plain string keeps the legacy workspace-only
 * behavior; the object form additionally allows *input* paths under
 * `extraInputRoots` (e.g. the local-runtime dataDir assets subtree where
 * registered attachments live). Output paths never consult the extra roots —
 * use `workspaceRootOf()` for the write-side fence.
 */
export type MatrixPathScope =
  | string
  | {
      readonly workspaceRoot: string;
      readonly extraInputRoots?: readonly string[];
    };

export function workspaceRootOf(scope: MatrixPathScope): string {
  return typeof scope === 'string' ? scope : scope.workspaceRoot;
}

/** All roots an *input* path may live under, workspace first. */
export function inputRootsOf(scope: MatrixPathScope): readonly string[] {
  if (typeof scope === 'string') return [scope];
  return [scope.workspaceRoot, ...(scope.extraInputRoots ?? [])];
}

/**
 * Resolve an input path against the scope: relative paths resolve against the
 * workspace root only (never an extra root), then the absolute path must fall
 * inside the workspace root or one of the extra input roots. The realpath
 * walk in `assertWithinWorkspace` blocks symlink escapes per root.
 */
export async function resolveInputWithinScope(
  inputPath: string,
  scope: MatrixPathScope,
): Promise<string> {
  const abs = isAbsolute(inputPath) ? inputPath : resolve(workspaceRootOf(scope), inputPath);
  let firstError: unknown;
  for (const root of inputRootsOf(scope)) {
    try {
      await assertWithinWorkspace(abs, root);
      return abs;
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError instanceof Error
    ? firstError
    : new Error(`Workspace path escapes Matrix tool root: ${inputPath}`);
}

export async function assertWithinWorkspace(
  absolutePath: string,
  workspaceRoot: string,
): Promise<void> {
  const rootReal = await realpath(workspaceRoot);

  let candidate = resolve(absolutePath);
  const suffixParts: string[] = [];
  while (true) {
    let ancestorReal: string;
    try {
      ancestorReal = await realpath(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error(`Workspace path escapes Matrix tool root: ${absolutePath}`);
      }
      suffixParts.unshift(basename(candidate));
      candidate = parent;
      continue;
    }

    const finalPath =
      suffixParts.length === 0 ? ancestorReal : resolve(ancestorReal, ...suffixParts);
    const rel = relative(rootReal, finalPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Workspace path escapes Matrix tool root: ${absolutePath}`);
    }
    return;
  }
}

export async function resolveWithinWorkspace(
  inputPath: string,
  workspaceRoot: string,
): Promise<string> {
  const abs = isAbsolute(inputPath) ? inputPath : resolve(workspaceRoot, inputPath);
  await assertWithinWorkspace(abs, workspaceRoot);
  return abs;
}
