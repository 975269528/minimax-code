/**
 * WeChat permission-card helpers — split out from `wechat-adapter.ts` so the
 * adapter file stays within the layout budget (mirrors `wechat-questionnaire.ts`).
 *
 * WeChat has no rich card / inline-keyboard SDK, so the permission surface is
 * plain text: render the ask as a text card and let the user reply with one of
 * three slash commands. Unlike Telegram (`callback_data` codec) or Feishu
 * (card-action value), WeChat's reply is an ordinary text message, so the
 * inbound side matches on an exact command token.
 *
 * Slash-command design (user decision 2026-07-03): `/allow` (Allow once) /
 * `/always` (Always allow) / `/deny` (Deny). Chosen over numbered-text (1/2/3) to
 * remove the parse ambiguity + short time-window risk of the numbered scheme
 * (a bare `1` could be "answer the previous question" or "allow"). Because the
 * command is unambiguous, the permission bridge's per-chat pending map is the
 * sole gate: `parsePermissionCommand` only ever runs when the bridge already
 * has a pending ask for the conversation.
 *
 * NOTE: These three commands are intentionally NOT added to
 * `LOCAL_CHANNEL_SLASH_COMMANDS` (`channel-inbound-utils.ts`). They are
 * consumed exclusively by the runner's permission interception via the bridge;
 * with no pending ask, `parseLocalChannelSlashCommand` returns undefined and
 * the text flows on as an ordinary message (parity with retired `/pin` / `/btw`).
 */
import type {
  ChannelPermissionBehavior,
  ChannelRenderablePermission,
} from '../../permission-bridge.js';

/**
 * Render a pending permission ask as a plain-text WeChat message body:
 *   - `[Permission request]` header line.
 *   - `Tool: <toolName>` and (when distinct) the tool description.
 *   - The `reason` paragraph, blank-line separated.
 *   - Each rule content as a `• <rule>` bullet.
 *   - A trailer hint spelling out the three slash commands so the user knows
 *     exactly how to respond (WeChat has no button affordance).
 *
 * Copy is hardcoded to zh-Hans — WeChat has no client-language signal (parity
 * with `formatQuestionnaireText`).
 */
export function formatPermissionText(renderable: ChannelRenderablePermission): string {
  const lines: string[] = ['【权限请求】', `工具：${renderable.toolName}`];
  if (renderable.toolDescription && renderable.toolDescription !== renderable.toolName) {
    lines.push(renderable.toolDescription);
  }
  if (renderable.reason) {
    lines.push('');
    lines.push(renderable.reason);
  }
  if (renderable.ruleContents.length > 0) {
    lines.push('');
    for (const rule of renderable.ruleContents) {
      lines.push(`• ${rule}`);
    }
  }
  lines.push('');
  lines.push('回复 /allow 允许本次 · /always 始终允许 · /deny 拒绝');
  return lines.join('\n');
}

/**
 * Parse a free-text WeChat reply as a permission decision.
 *
 * Matching rules:
 *   - The whole message (trimmed) must be exactly `/allow`, `/always` or
 *     `/deny`, case-insensitive. A trailing `@botname` suffix is tolerated
 *     (parity with `parseLocalChannelSlashCommand`), though WeChat commands
 *     generally carry no @-handle.
 *   - Anything else — a bare word without the leading `/`, an unknown command,
 *     a command with extra arguments (`/allow now`), or a longer token
 *     (`/allowme`) — returns `null` so the message flows on as ordinary text
 *     and is never mis-consumed as a permission reply.
 *
 * Returns the `ChannelPermissionBehavior` directly (`allow` | `always` |
 * `deny`); the route boundary maps these to `allowOnce` / `allowAlways` /
 * `deny` — no translation is needed here since the vocabularies coincide.
 */
export function parsePermissionCommand(text: string): ChannelPermissionBehavior | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  // Exact command token only: letters, optional `@botname`, then end-of-string.
  // Any trailing argument or extra character fails the match on purpose.
  const match = trimmed.match(/^\/([a-z]+)(?:@[a-z0-9_]+)?$/iu);
  if (!match) return null;
  switch (match[1]!.toLowerCase()) {
    case 'allow':
      return 'allow';
    case 'always':
      return 'always';
    case 'deny':
      return 'deny';
    default:
      return null;
  }
}
