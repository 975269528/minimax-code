import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type TuiExternalTargetOpener = (target: string) => Promise<void>;

export function createTuiExternalTargetOpener(workspaceDir: string): TuiExternalTargetOpener {
  return (target) => openTuiExternalTarget(target, workspaceDir);
}

export function openTuiExternalTarget(target: string, workspaceDir: string): Promise<void> {
  const normalized = resolveTuiExternalTarget(target, workspaceDir);
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [normalized]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', normalized]]
        : ['xdg-open', [normalized]];

  return new Promise((resolveOpen, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveOpen();
    });
  });
}

export function resolveTuiExternalTarget(target: string, workspaceDir: string): string {
  if (/^https?:\/\//iu.test(target)) return target;
  if (/^file:\/\//iu.test(target)) return fileURLToPath(target);
  return isAbsolute(target) ? target : resolve(workspaceDir, target);
}
