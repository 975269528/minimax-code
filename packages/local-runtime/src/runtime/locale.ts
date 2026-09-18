/** Electron locale first; system locale fallback for CLI/headless hosts. */
export function resolveLocalRuntimeLocale(): string {
  const electronLocale = process.env.MAVIS_ELECTRON_LOCALE?.trim();
  if (electronLocale === 'en' || electronLocale === 'zh') return electronLocale;
  const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  if (intlLocale) return intlLocale;
  const lang = process.env.LANG?.split('.')[0]?.replace('_', '-');
  return lang || 'en';
}
