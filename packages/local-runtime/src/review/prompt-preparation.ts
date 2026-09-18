import type { PromptReadScope, PromptSnapshotSource } from '@mavis/agent-core';
import { getRuntimeRegion } from '@mavis/config';

import type { LocalRuntimeConfig } from '../config/types.js';
import { readPromptBundleScopeWithBuiltinFallback } from '../runtime/prompt-read.js';
import {
  loadBuiltinReviewPromptTemplates,
  REVIEW_PROMPT_KEYS,
  ReviewPreparationService,
  type PreparedReview,
  type ReviewPromptTemplates,
} from './preparation.js';
import { ReviewPreferencesService } from './preferences.js';
import type { ReviewMode, ReviewTrigger } from './types.js';

export interface PreparedReviewRead {
  readonly prepared: PreparedReview;
  readonly promptRead?: PromptReadScope;
}

export interface ReviewPreparationInput {
  readonly workspace: string;
  readonly trigger: ReviewTrigger;
  readonly request: string;
  readonly requestedMode?: ReviewMode;
  readonly promptRead?: PromptReadScope;
}

export async function prepareReview(
  input: ReviewPreparationInput,
  options: {
    readonly reviewPromptDir: string;
    readonly configGetter: () => LocalRuntimeConfig;
    readonly promptSnapshots?: () => PromptSnapshotSource | undefined;
  },
): Promise<PreparedReviewRead> {
  const builtin = await loadBuiltinReviewPromptTemplates(options.reviewPromptDir);
  const resolved = await readPromptTemplates(
    builtin,
    input.promptRead,
    options.promptSnapshots?.(),
  );
  const prepared = await new ReviewPreparationService({
    preferences: new ReviewPreferencesService(options.configGetter().dataDir),
    configGetter: options.configGetter,
    regionGetter: getRuntimeRegion,
  }).prepare(input, resolved.templates);
  return {
    prepared,
    ...(resolved.promptRead ? { promptRead: resolved.promptRead } : {}),
  };
}

async function readPromptTemplates(
  builtin: ReviewPromptTemplates,
  promptRead: PromptReadScope | undefined,
  promptSnapshots: PromptSnapshotSource | undefined,
): Promise<{ readonly templates: ReviewPromptTemplates; readonly promptRead?: PromptReadScope }> {
  const resolved = await readPromptBundleScopeWithBuiltinFallback(promptRead ?? promptSnapshots, [
    { key: REVIEW_PROMPT_KEYS.reviewer, builtin: builtin.reviewer },
    { key: REVIEW_PROMPT_KEYS.candidates, builtin: builtin.candidates },
  ]);
  return {
    templates: {
      reviewer: resolved.templates.get(REVIEW_PROMPT_KEYS.reviewer) ?? builtin.reviewer,
      candidates: resolved.templates.get(REVIEW_PROMPT_KEYS.candidates) ?? builtin.candidates,
    },
    ...(resolved.promptRead ? { promptRead: resolved.promptRead } : {}),
  };
}
