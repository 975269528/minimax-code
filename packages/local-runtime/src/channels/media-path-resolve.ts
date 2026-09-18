/**
 * Resolve relative `OutboundMediaRef.path` values against the session's
 * workspace directory.
 *
 * Why this exists: agents commonly emit a bare basename (e.g.
 * `cute_kitten.png` or `images/foo.png`) assuming the UI's daemon
 * file-API workspace base. IM senders, however, run on `process.cwd()`,
 * so feeding the bare basename to `readFile` raises ENOENT and the
 * deliver layer reports `[Media send failed: … ENOENT: no such file or directory]`.
 *
 * Rebase rules:
 *   - `http(s)://` / `data:` / `blob:` / `file://` and absolute paths →
 *     left as-is (no rebase needed).
 *   - any other relative path + non-empty workspaceDir → `join(ws, path)`.
 *   - empty workspaceDir → leave the path untouched so we fall back to
 *     `process.cwd()` (the legacy behaviour); the deliver layer surfaces
 *     the ENOENT with the original path for easy debugging.
 *
 * Symbolic schemes (`sandbox://`, etc.) are NOT rebased — they need a
 * dedicated resolver, which is `feishu-sender.ts`'s job to reject loudly.
 */

import { isAbsolute, join } from 'node:path';

import type { OutboundMediaRef } from '@mavis/shared';

export function rebaseMediaPath(
  ref: OutboundMediaRef,
  workspaceDir: string | undefined,
): OutboundMediaRef {
  if (!workspaceDir || !ref.path) return ref;
  const path = ref.path;
  // URLs and abs paths — already routable.
  if (
    /^https?:\/\//iu.test(path) ||
    /^file:\/\//iu.test(path) ||
    /^data:/iu.test(path) ||
    /^blob:/iu.test(path) ||
    isAbsolute(path)
  ) {
    return ref;
  }
  // Reserved symbolic schemes — let the sender's scheme guard surface
  // a stable error rather than silently rebasing to a bogus local path.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(path)) {
    return ref;
  }
  return { ...ref, path: join(workspaceDir, path) };
}
