import { sourceReferenceExtension } from '@mavis/agent-extension';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

interface AttachmentSourceRegistration {
  resolveSource(input: {
    readonly sessionId: string;
    readonly filePath: string;
  }): { readonly filePath: string; readonly fileName: string } | undefined;
}

export function createRuntimeSourceReferenceExtension(
  attachmentRegistration: AttachmentSourceRegistration,
) {
  return sourceReferenceExtension({
    resolveFileSourcePath: ({ path, turn, origin }) => {
      const source = attachmentRegistration.resolveSource({
        sessionId: turn.sessionId,
        filePath: path,
      });
      if (source) return { path: source.filePath, name: source.fileName };
      return resolveWorkspaceFileSource(path, turn.workspaceDir, origin === 'diff-result');
    },
  });
}

function resolveWorkspaceFileSource(
  candidatePath: string,
  workspaceDir: string,
  requireExistingFile = false,
): { path: string; name: string } | undefined {
  const pathApi = isWindowsPath(candidatePath) || isWindowsPath(workspaceDir) ? win32 : posix;
  if (!pathApi.isAbsolute(candidatePath) || !pathApi.isAbsolute(workspaceDir)) return undefined;

  const workspacePath = pathApi.resolve(workspaceDir);
  const resolvedPath = pathApi.resolve(candidatePath);
  const relativePath = pathApi.relative(workspacePath, resolvedPath);
  if (
    !relativePath ||
    pathApi.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${pathApi.sep}`)
  ) {
    return undefined;
  }
  return existingWorkspaceFileSource(
    { path: resolvedPath, name: pathApi.basename(resolvedPath) },
    requireExistingFile,
  );
}

function existingWorkspaceFileSource(
  source: { path: string; name: string },
  required: boolean,
): { path: string; name: string } | undefined {
  return required && !existsSync(source.path) ? undefined : source;
}

function isWindowsPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(value);
}
