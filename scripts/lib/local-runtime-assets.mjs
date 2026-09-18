import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Copies shared local-runtime assets and the canonical V2 Agent asset tree.
 * Agent definitions/prompts have one source of truth under local-runtime-v2;
 * the V1 package no longer ships a second builtin Agent tree.
 */
export function copyLocalRuntimeAssets({
  repositoryRoot,
  outputDir,
  filter,
  excludedBuiltinSkillNames = [],
}) {
  const assetsSrc = path.join(repositoryRoot, 'packages/local-runtime/assets');
  const v2AgentAssetsSrc = path.join(repositoryRoot, 'packages/local-runtime-v2/assets/agents');
  const v2ProviderCatalogSrc = path.join(
    repositoryRoot,
    'packages/local-runtime-v2/assets/models-dev-catalog.json.gz',
  );
  const assetsDst = path.join(outputDir, 'assets');
  const v2AgentAssetsDst = path.join(assetsDst, 'agents');
  const v2ProviderCatalogDst = path.join(assetsDst, 'models-dev-catalog.json.gz');
  const excludedBuiltinSkills = new Set(excludedBuiltinSkillNames);
  const isExcludedBuiltinSkill = (sourcePath) =>
    path.basename(path.dirname(sourcePath)) === 'skills' &&
    excludedBuiltinSkills.has(path.basename(sourcePath));
  const shouldCopyFrom = (sourceRoot, sourcePath) => filter(path.relative(sourceRoot, sourcePath));
  if (!existsSync(assetsSrc)) {
    throw new Error('packages/local-runtime/assets not found');
  }
  if (!existsSync(v2AgentAssetsSrc)) {
    throw new Error('packages/local-runtime-v2/assets/agents not found');
  }
  if (!existsSync(v2ProviderCatalogSrc)) {
    throw new Error('packages/local-runtime-v2/assets/models-dev-catalog.json.gz not found');
  }
  rmSync(assetsDst, { recursive: true, force: true });
  cpSync(assetsSrc, assetsDst, {
    recursive: true,
    filter: (sourcePath) => {
      // The canonical Agent tree is copied below from V2. Do not resurrect
      // a duplicate packages/local-runtime/assets/agents source tree.
      return (
        sourcePath !== path.join(assetsSrc, 'agents') &&
        !isExcludedBuiltinSkill(sourcePath) &&
        shouldCopyFrom(assetsSrc, sourcePath)
      );
    },
  });
  cpSync(v2AgentAssetsSrc, v2AgentAssetsDst, {
    recursive: true,
    filter: (sourcePath) =>
      !isExcludedBuiltinSkill(sourcePath) && shouldCopyFrom(v2AgentAssetsSrc, sourcePath),
  });
  cpSync(v2ProviderCatalogSrc, v2ProviderCatalogDst);
}
