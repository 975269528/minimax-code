import { getLocaleLanguage } from '../utils/locale.js';

/** The default title given to newly created or promoted root sessions. */
export const DEFAULT_ROOT_SESSION_TITLE = 'Main';

const ARCHIVED_SESSION_TITLE_PREFIX: Record<string, string> = {
  zh: '记忆归档：',
  en: 'Memory archive: ',
};

const ARCHIVED_SESSION_TITLE_PREFIX_FALLBACK = 'Memory archive: ';

/** Build the synchronous archive fallback; V2 owns model-generated titles. */
export function buildArchivedRootSessionTitle(opts: {
  oldTitle?: string | null;
  fallbackName: string;
  locale?: string;
}): string {
  const oldTitle = opts.oldTitle?.trim() ?? '';
  const label =
    !oldTitle || oldTitle.toLowerCase() === DEFAULT_ROOT_SESSION_TITLE.toLowerCase()
      ? opts.fallbackName
      : oldTitle;
  // preview_train's shared normalizer: also handles `zh_CN`-style separators.
  const language = getLocaleLanguage(opts.locale);
  const prefix = ARCHIVED_SESSION_TITLE_PREFIX[language] ?? ARCHIVED_SESSION_TITLE_PREFIX_FALLBACK;
  return `${prefix}${label}`;
}
