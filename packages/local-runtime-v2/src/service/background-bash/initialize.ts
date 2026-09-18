import type { BashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';
import type { LocalSandboxBashOperationsFactory } from '@mavis/agent-tools/desktop';

import { createLocalBackgroundBashExecutor } from './executor.js';

export function initializeLocalBackgroundBashExecutor(
  operationsFactory: LocalSandboxBashOperationsFactory,
  envPolicy: BashEnvPolicy,
) {
  return createLocalBackgroundBashExecutor(operationsFactory, envPolicy);
}
