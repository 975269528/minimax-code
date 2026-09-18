import {
  EN_RUNTIME_TRANSLATIONS,
  type RuntimeTranslationKey,
  type RuntimeTranslations,
} from './en.js';
import { ZH_HANS_RUNTIME_TRANSLATIONS } from './zh-Hans.js';

type RuntimeLocale = 'en' | 'zh-Hans';

const DEFAULT_RUNTIME_LOCALE: RuntimeLocale = 'en';

const RUNTIME_TRANSLATIONS: Readonly<Record<RuntimeLocale, RuntimeTranslations>> = {
  en: EN_RUNTIME_TRANSLATIONS,
  'zh-Hans': ZH_HANS_RUNTIME_TRANSLATIONS,
};

/** Extract the canonical language subtag from a BCP 47 locale. */
export function getRuntimeLocaleLanguage(locale?: string | null): string {
  const candidate = locale?.trim().replace(/_/gu, '-');
  if (!candidate) return DEFAULT_RUNTIME_LOCALE;

  try {
    return new Intl.Locale(candidate).language.toLowerCase();
  } catch {
    return candidate.split('-')[0]?.toLowerCase() || DEFAULT_RUNTIME_LOCALE;
  }
}

function resolveRuntimeLocale(locale?: string | null): RuntimeLocale {
  return getRuntimeLocaleLanguage(locale) === 'zh' ? 'zh-Hans' : DEFAULT_RUNTIME_LOCALE;
}

export function translateRuntimeText(
  locale: string | null | undefined,
  key: RuntimeTranslationKey,
): string {
  return RUNTIME_TRANSLATIONS[resolveRuntimeLocale(locale)][key];
}

export type { RuntimeTranslationKey } from './en.js';
