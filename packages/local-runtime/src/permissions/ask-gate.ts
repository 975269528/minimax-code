/**
 * `applyAskGate` — single chokepoint that enforces the
 * `bypassPermissions` ("Always allow") product invariant:
 *
 *   **bypassPermissions = the UI never surfaces a permission card.**
 *
 * The wider permission pipeline (agent-core `PermissionEngine`,
 * `path-capability`, `bash-permission`, `local-permission-checkers`,
 * `local-permission-facade`'s cloud-gateway branch — 22 distinct sites
 * as of this writing) produces verdicts with `behavior === 'ask'` for
 * many independent reasons:
 *
 *   - user-persisted whole-tool / MCP server `ask` rules
 *   - tool checker `bypassImmune` safetyCheck (credential paths, etc.)
 *   - content-ask rules
 *   - interactive tools
 *   - bash safe-first-words fallback
 *   - local hard-check ASK (curl-pipe-shell, shell substitution,
 *     slow whole-tree scan, recursive rm, workspace-escape)
 *   - cloud gateway verdicts of `block` / `confirm` / `timeout`
 *
 * Before this gate each of those sites was responsible for "is this
 * ask bypass-immune?". The verdict shape grew an ad-hoc
 * `bypassImmune?: boolean` field that some sites set and others
 * forgot (e.g. content-ask rules in `engine.ts`), and the facade
 * needed special-case `if (askPolicy === 'never' && ...)` branches
 * to paper over the inconsistency. The result was a fragile
 * contract: adding a new ask site meant remembering to reason about
 * bypass mode all over again.
 *
 * The gate collapses that to one rule, applied once at the very end
 * of `LocalPermissionFacade.checkPermission`:
 *
 *   - `mode !== 'bypassPermissions'` → pass through unchanged.
 *   - `mode === 'bypassPermissions'`:
 *       - `behavior === 'deny'` → unchanged. Deny is reported back to
 *         the LLM as a tool error; it never surfaces a card. The
 *         bypass-immune deny set (UNC, `rm -rf /` / `~`) lives at
 *         `facade.ts:202` and short-circuits before we get here, so
 *         the verdict at this point is either an engine deny or
 *         nothing.
 *       - `behavior === 'allow'` → unchanged.
 *       - `behavior === 'ask'` → **downgraded to `allow`**. The user
 *         has waived per-call review for this mode.
 *
 * Whatever new ask sources land later, they automatically inherit
 * this invariant — no need to touch them. The invariant is also
 * directly exercised by `local-permission-ask-gate.test.ts`'s
 * exhaustive trigger table.
 */

import type { PermissionMode } from '@mavis/permission';

import type { LocalPermissionCheckResult } from './facade.js';

/**
 * Reason text rendered into the downgraded allow verdict. Kept
 * neutral so it reads correctly in both English and Chinese log
 * surfaces — the facade owns localised renderings of explicit asks,
 * but a "bypassPermissions waived this" event is by definition
 * untranslated user policy.
 */
const BYPASS_ALLOW_REASON =
  'Allowed under bypassPermissions ("始终允许"): per-call review was waived by the user.';

export function applyAskGate(
  verdict: LocalPermissionCheckResult,
  mode: PermissionMode,
): LocalPermissionCheckResult {
  if (mode !== 'bypassPermissions') return verdict;
  if (verdict.behavior !== 'ask') return verdict;
  // Preserve `rewrittenInput` (e.g. `rm` → `mavis-trash` rewrite) so
  // the downstream tool call still receives the safer payload. Drop
  // `ruleContents` — they are an ask-card UI concern and have no
  // meaning on an allow verdict.
  return {
    behavior: 'allow',
    reason: BYPASS_ALLOW_REASON,
    ...(verdict.rewrittenInput ? { rewrittenInput: verdict.rewrittenInput } : {}),
  };
}
