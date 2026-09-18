import type {
  PromptConfigAuthProvider,
  PromptConfigClient,
  PromptKeyProvider,
} from './contracts.js';
import { createPromptKeyProvider } from './storage/prompt-crypto.js';
import { LocalPromptFileReader } from './storage/prompt-file-reader.js';
import { PromptConfigService } from './prompt-config.service.js';
import { EncryptedPromptStorage } from './storage/encrypted-prompt-storage.js';
import {
  loadManagedDesktopPromptRegistry,
  resolveBuiltinPromptAssetsDir,
} from './managed-desktop-prompts.js';
import { readPromptConfigDesktopKey } from './desktop-key.js';
import {
  RuntimePromptConfigAuthProvider,
  type PromptConfigRuntimeAuthContext,
} from './runtime/runtime-auth.js';
import {
  PromptConfigCloudClient,
  resolvePromptConfigCloudBaseUrl,
} from './prompt-config-cloud-client.js';

interface InitializePromptConfigOptions {
  readonly dataDir: string;
  readonly builtinAssetsDir: string;
  readonly auth: PromptConfigAuthProvider;
  readonly client: PromptConfigClient;
  readonly desktopKey: Uint8Array;
  readonly allowedPaths: ReadonlySet<string>;
  readonly keyProvider?: PromptKeyProvider;
  /** The Agent owner constructs this cache before service composition. */
  readonly reader?: LocalPromptFileReader;
  readonly nowMs?: () => number;
}

interface PromptConfigOwner {
  readonly service: PromptConfigService;
  readonly reader: LocalPromptFileReader;
}

export interface ManagedDesktopPromptConfigOptions {
  readonly enabled: boolean;
  readonly dataDir: string;
  readonly authContextGetter: () => PromptConfigRuntimeAuthContext | undefined;
  readonly deploymentGetter: () => string;
  readonly fetchImpl: typeof fetch;
  readonly appVersion?: string;
  readonly desktopKey?: Uint8Array;
  readonly reader?: LocalPromptFileReader;
}

export interface ManagedDesktopPromptConfig {
  readonly owner: PromptConfigOwner;
  readonly auth: RuntimePromptConfigAuthProvider;
  readonly managedPaths: ReadonlySet<string>;
}

function initializePromptConfig(options: InitializePromptConfigOptions): PromptConfigOwner {
  const reader = options.reader ?? new LocalPromptFileReader();
  const storage = new EncryptedPromptStorage({
    dataDir: options.dataDir,
    builtinAssetsDir: options.builtinAssetsDir,
  });
  const service = new PromptConfigService({
    auth: options.auth,
    client: options.client,
    keys: options.keyProvider ?? createPromptKeyProvider({ desktopKey: options.desktopKey }),
    storage,
    reader,
    allowedPaths: options.allowedPaths,
    nowMs: options.nowMs,
  });
  return { service, reader };
}

/** Assembles the Desktop-only auth, cloud, encrypted storage, and reader slice. */
export async function initializeManagedDesktopPromptConfig(
  options: ManagedDesktopPromptConfigOptions,
): Promise<ManagedDesktopPromptConfig | undefined> {
  if (!options.enabled) return undefined;
  const auth = new RuntimePromptConfigAuthProvider({
    authContextGetter: options.authContextGetter,
    deploymentGetter: options.deploymentGetter,
  });
  const builtinAssetsDir = await resolveBuiltinPromptAssetsDir();
  const registry = await loadManagedDesktopPromptRegistry(builtinAssetsDir);
  const owner = initializePromptConfig({
    dataDir: options.dataDir,
    builtinAssetsDir,
    auth,
    client: new PromptConfigCloudClient({
      baseUrl: resolvePromptConfigCloudBaseUrl(),
      fetchImpl: options.fetchImpl,
      ...(options.appVersion ? { appVersion: options.appVersion } : {}),
      previewSecret: process.env.PREVIEW_SECRET,
      lane: process.env.MAVIS_PLUGIN_CLOUD_LANE,
    }),
    desktopKey: readPromptConfigDesktopKey(options.desktopKey),
    allowedPaths: registry.paths,
    ...(options.reader ? { reader: options.reader } : {}),
  });
  return { owner, auth, managedPaths: registry.paths };
}
