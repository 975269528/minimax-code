import { getRuntimeRegion } from '@mavis/config';
import type { LocalConversationRuntimeConfig } from '../../../../model-system/index.js';
import { ENVIRONMENT_RULES } from '../prompt-blocks.js';
import { resolveRuntimeLocale } from '../static-prompt-reader.js';

export interface LocalPromptEnvironment {
  readonly platform: string;
  readonly osVersion: string;
  readonly shell: string;
}

export function environmentContextBlock(scope: {
  readonly config: LocalConversationRuntimeConfig;
  readonly workspaceDir: string;
  readonly environment: LocalPromptEnvironment | undefined;
  readonly modelId: string;
  readonly isGitRepository: boolean | undefined;
}): string {
  const { config, workspaceDir, environment, modelId, isGitRepository } = scope;
  return [
    '# Environment',
    'You have been invoked in the following environment:',
    `- Primary working directory: ${workspaceDir}`,
    `- Is a git repository: ${isGitRepository ?? 'unavailable'}`,
    `- Platform: ${environment?.platform ?? process.platform}`,
    `- Shell: ${environment?.shell ?? 'unavailable'}`,
    `- OS Version: ${environment?.osVersion ?? 'unavailable'}`,
    `- Model: ${modelId}`,
    `- appLocale: ${resolveRuntimeLocale()}`,
    `- region: ${getRuntimeRegion()}`,
    `- activeDataDir: ${config.dataDir}`,
    '',
    ENVIRONMENT_RULES,
  ].join('\n');
}
