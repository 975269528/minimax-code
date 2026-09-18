import type { MiniAppLifecycle } from '@mavis/agent-extension';

import type { MiniAppSupervisor } from '../../service/miniapp/index.js';
import type {
  MiniAppPluginControl,
  PluginServiceLogger,
} from '../../service/plugin-system/index.js';
import { createSessionMiniAppLifecycle } from './miniapp-actions.js';
import type { MiniAppPresenter } from './process-local-application-contract.js';

interface SessionWorkspaceRepository {
  get(sessionId: string): Promise<{ readonly workspaceDir: string } | undefined>;
}

export function createHostSessionMiniAppLifecycle(input: {
  readonly plugins: MiniAppPluginControl;
  readonly supervisor: Pick<MiniAppSupervisor, 'inspect'> | undefined;
  readonly sessions: SessionWorkspaceRepository;
  readonly surface: MiniAppPresenter | undefined;
  readonly logger: Pick<PluginServiceLogger, 'error'>;
}): MiniAppLifecycle | undefined {
  return createSessionMiniAppLifecycle(input.plugins, input.supervisor, input.sessions, {
    ...(input.surface ? { surface: input.surface } : {}),
    diagnostics: {
      record: (diagnostic) =>
        input.logger.error({ ...diagnostic }, 'Mini App action failed internally'),
    },
  });
}
