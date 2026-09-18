import type { PromptConfig } from '@mavis/config';
import type { PromptSnapshotSource } from '@mavis/agent-runtime';
import { LocalPromptSnapshotSource } from '../../service/agent/index.js';
import {
  initializeRuntimePromptSupport,
  type LocalPromptFileReader,
  type RuntimePromptSupport,
} from '../../service/prompt-config/index.js';

/** Keeps Prompt-specific wiring outside the shared service composition flow. */
export async function initializeRuntimeServicePromptSupport(input: {
  readonly runtimeOwnerKind?: string;
  readonly promptConfig: PromptConfig | undefined;
  readonly dataDir: string;
  readonly promptConfigKey?: Uint8Array;
  readonly plugin: Parameters<typeof initializeRuntimePromptSupport>[0]['plugin'];
  readonly agentService: Parameters<typeof initializeRuntimePromptSupport>[0]['agentService'] & {
    frozenPromptSource?(): Promise<PromptSnapshotSource | undefined>;
  };
  readonly promptFileReader?: LocalPromptFileReader;
}): Promise<RuntimePromptSupport> {
  const local = await input.agentService.frozenPromptSource?.();
  const support = await initializeRuntimePromptSupport({
    // Hotfix: keep package prompts paired with this client, including when an
    // existing profile explicitly enables auto-update. Do not bind old disk caches.
    enabled: false,
    dataDir: input.dataDir,
    ...(input.promptConfigKey ? { promptConfigKey: input.promptConfigKey } : {}),
    plugin: input.plugin,
    agentService: input.agentService,
    snapshotFactory: {
      create: (options) => new LocalPromptSnapshotSource(options),
    },
    ...(input.promptFileReader ? { promptFileReader: input.promptFileReader } : {}),
  });
  return local ? { ...support, promptSnapshots: local } : support;
}
