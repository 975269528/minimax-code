import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

interface WorkspaceInputResolutionOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  cwd?: string;
}

/**
 * Converts every supported user-facing workspace spelling into one absolute
 * platform path before filesystem identity is considered.
 */
function resolveWorkspaceInput(
  input: string,
  options: WorkspaceInputResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  let workspace = input.startsWith('~') ? path.join(homeDir, input.slice(1)) : input;

  if (platform === 'win32') {
    const msysMatch = workspace.match(/^\/([a-zA-Z])(\/.*)?$/u);
    if (msysMatch) {
      const drive = (msysMatch[1] ?? '').toUpperCase();
      const rest = msysMatch[2]?.replace(/\//gu, '\\') ?? '\\';
      workspace = `${drive}:${rest}`;
    }
  }

  return path.resolve(cwd, workspace);
}

/** Existing aliases collapse to the same physical workspace identity. */
export async function normalizeWorkspacePath(
  workspace: string,
  options: WorkspaceInputResolutionOptions = {},
): Promise<string> {
  const absolute = resolveWorkspaceInput(workspace, options);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}
