import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';

/** Extract the canonical language subtag from a BCP 47 locale. */
export function getLocaleLanguage(locale?: string | null): string {
  return getRuntimeLocaleLanguage(locale);
}

export function isChineseLocale(locale?: string | null): boolean {
  return getRuntimeLocaleLanguage(locale) === 'zh';
}
