import type {
  LocalSandboxBashExecutionPort,
  LocalSandboxBashOperationsFactory,
} from '@mavis/agent-tools/desktop';

export interface DeferredLocalSandboxBashOperationsFactory extends LocalSandboxBashExecutionPort {
  bind(factory: LocalSandboxBashOperationsFactory): void;
}
