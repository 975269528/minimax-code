import { SAFETY_SCENE, reviewBlocks, type ContentSafetyChecker } from './api.js';

/**
 * Review non-empty user-controllable config text (agent display name /
 * description / persona / system prompt / avatar, and user skill name /
 * description / content) at the shared `ConfigField` scene, returning `true`
 * when a field must block the write.
 *
 * The fail policy lives in one place — `reviewBlocks` — and the checker always
 * resolves to a `SafetyCheckResult` (never throws), so this helper just walks the
 * fields and routes each verdict through the shared predicate. Empty / whitespace
 * values and the no-checker case (dev/test) never block. Callers own the
 * user-facing error shape (agent throws a 422, skill returns a sentinel), so no
 * review detail leaks from here.
 */
export async function configReviewBlocks(
  review: ContentSafetyChecker | undefined,
  values: ReadonlyArray<string | null | undefined>,
): Promise<boolean> {
  if (!review) return false;
  for (const raw of values) {
    const value = raw?.trim() || '';
    if (!value) continue;
    if (reviewBlocks(await review(value, SAFETY_SCENE.ConfigField))) return true;
  }
  return false;
}
