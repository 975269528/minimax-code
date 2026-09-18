import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';

import { COMPOSER_COPY, type ComposerCopyKey } from './copy.en.js';
import { ZH_HANS_COMPOSER_COPY } from './copy.zh-Hans.js';

function resolveComposerLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en';
  }
}

export function composerText(key: ComposerCopyKey, locale = resolveComposerLocale()): string {
  return getRuntimeLocaleLanguage(locale) === 'zh'
    ? ZH_HANS_COMPOSER_COPY[key]
    : COMPOSER_COPY[key];
}
