import path from 'node:path';

import type { LocalHostTrashRuntime } from '@mavis/agent-tools/desktop';
import { readWindowsTrashExecution } from '@mavis/permission';

import { logger } from '../common/logger.js';

/**
 * Host-side trash launcher metadata. Only Windows needs it: POSIX recoverable
 * deletion runs inside the sandbox through the runtime-managed `rm` shim, so
 * the host never spawns `mavis-trash` on darwin/linux.
 */
export function buildLocalHostTrashRuntime(input: {
  readonly dataDir?: string;
}): LocalHostTrashRuntime {
  return {
    platform: process.platform,
    readExecution: readWindowsTrashExecution,
    reportDiagnostic: (diagnostic) =>
      logger.error({ ...diagnostic }, 'local_runtime.windows_trash_execution_failed'),
    ...(input.dataDir ? { scriptPath: path.join(input.dataDir, 'bin', 'mavis-trash.js') } : {}),
  };
}
