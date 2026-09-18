import {
  createSkillRegistry,
  type SkillRegistry,
  type SkillRegistryWatcher,
  type SkillSourceRoot,
} from '@mavis/skills';

export interface RegistryHandle {
  registryPromise: Promise<SkillRegistry>;
  refreshPromise?: Promise<void>;
  restartWatcher(): void;
  close(): void;
}

export function inheritedRuntimeReadBetaFlags(
  registry: SkillRegistry,
): Readonly<Record<string, boolean>> {
  const enabled: Record<string, boolean> = {};
  for (const entry of registry.getAvailableSkills()) {
    const requiresBeta = entry.frontmatter.requiresBeta ?? entry.frontmatter.requires_beta;
    if (typeof requiresBeta === 'string' && requiresBeta.length > 0) {
      enabled[requiresBeta] = true;
    }
  }
  return enabled;
}

export function createRegistryHandle(roots: SkillSourceRoot[]): RegistryHandle {
  let registry: SkillRegistry | undefined;
  let watcher: SkillRegistryWatcher | undefined;
  let closed = false;
  const restartWatcher = () => {
    if (!registry || closed) return;
    if (watcher?.rearm) {
      watcher.rearm();
      return;
    }
    watcher?.close();
    watcher = registry.watch({ onChange: () => undefined });
  };
  return {
    registryPromise: createSkillRegistry(roots).then((createdRegistry) => {
      registry = createdRegistry;
      restartWatcher();
      return createdRegistry;
    }),
    restartWatcher,
    close() {
      closed = true;
      watcher?.close();
      watcher = undefined;
    },
  };
}

export function normalizeAgentName(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed || 'mavis';
}
