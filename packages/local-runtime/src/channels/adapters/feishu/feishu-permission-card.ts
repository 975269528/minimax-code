import type {
  ChannelPermissionBehavior,
  ChannelRenderablePermission,
} from '../../permission-bridge.js';
import { DEFAULT_BOT_NAME, makeHeader } from './feishu-card-header.js';

/**
 * Feishu / Lark **permission card** encoder + card-action decoder.
 *
 * Sibling of `feishu-card.ts` (questionnaire) — the two interactive surfaces
 * ride the same `POST /channel-bridge/feishu/card-action` endpoint, so both
 * embed a self-describing `kind` discriminator in the button `value` and the
 * host handler dispatches on it. Permission buttons carry
 * `{ kind: 'permission_action', requestId, behavior }` (mirrors the
 * questionnaire submit-button's {@link QuestionnaireSubmitActionValue} shape),
 * where `behavior` is the platform-agnostic {@link ChannelPermissionBehavior}
 * the bridge maps to the daemon's `allowOnce / allowAlways / deny` vocabulary.
 *
 * No SDK import here — pure card-spec objects + a permissive value decoder, so
 * this file is safe to import from vitest without pulling axios/protobufjs in.
 * The IM Gateway / daemon are NOT resurrected; only the card-shape lives here.
 */

// ---------------------------------------------------------------------------
// Value contract (button payload)
// ---------------------------------------------------------------------------

/** Discriminator carried by every permission-card button `value`. */
export const PERMISSION_ACTION_KIND = 'permission_action' as const;

/**
 * Permission-card button value. `behavior` is the decision the click encodes:
 *   - `allow`  — Allow once (session-scoped allowOnce)
 *   - `always` — Always allow (global allowAlways)
 *   - `deny`   — Deny (deny)
 */
export interface PermissionActionValue {
  kind: typeof PERMISSION_ACTION_KIND;
  requestId: string;
  behavior: ChannelPermissionBehavior;
}

// ---------------------------------------------------------------------------
// String helpers (aligned with feishu-card.ts)
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return s.replace(/\n/g, ' ').trim();
}

function escapeMarkdownCode(s: string): string {
  return s.replace(/`/g, '\\`');
}

/** Clamp a possibly-long tool input / rule line so a card stays readable. */
function clampLine(s: string, max = 300): string {
  const text = normalizeText(s);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

// ---------------------------------------------------------------------------
// Behavior label helpers
// ---------------------------------------------------------------------------

/** Terminal-state noun for a resolved permission (used in the resolved card). */
export function permissionResolvedLabel(behavior: ChannelPermissionBehavior): string {
  switch (behavior) {
    case 'allow':
      return '已允许(本次)';
    case 'always':
      return '已始终允许';
    case 'deny':
      return '已拒绝';
    default:
      return '已处理';
  }
}

// ---------------------------------------------------------------------------
// Card encoders
// ---------------------------------------------------------------------------

/**
 * Build the interactive permission-ask card (Card 2.0). Shows the tool name,
 * optional description, the reason the agent needs the tool, and the concrete
 * rule contents that would be granted, plus three action buttons:
 * Allow once / Always allow / Deny. Each button `value` carries
 * `{ kind: 'permission_action', requestId, behavior }` so the host card-action
 * handler can resolve the click without any out-of-band pending lookup.
 */
export function buildPermissionCard(
  renderable: ChannelRenderablePermission,
  botName: string = DEFAULT_BOT_NAME,
): Record<string, unknown> {
  const lines: string[] = [
    `**🔐 工具授权请求**`,
    `**工具**: \`${escapeMarkdownCode(renderable.toolName)}\``,
  ];
  if (renderable.toolDescription?.trim()) {
    lines.push(
      `<font color='grey'>${escapeMarkdownCode(clampLine(renderable.toolDescription))}</font>`,
    );
  }
  if (renderable.reason.trim()) {
    lines.push(`**原因**: ${escapeMarkdownCode(clampLine(renderable.reason))}`);
  }
  const rules = (renderable.ruleContents ?? [])
    .map((r) => clampLine(r))
    .filter((r) => r.length > 0);
  if (rules.length > 0) {
    lines.push(`**将授予**:`);
    for (const rule of rules) lines.push(`- \`${escapeMarkdownCode(rule)}\``);
  }

  const button = (
    content: string,
    behavior: ChannelPermissionBehavior,
    type: 'primary' | 'default' | 'danger',
  ) => {
    const value: PermissionActionValue = {
      kind: PERMISSION_ACTION_KIND,
      requestId: renderable.requestId,
      behavior,
    };
    return {
      tag: 'button',
      text: { tag: 'plain_text', content },
      type,
      name: `permission_${behavior}_btn`,
      // Both `behaviors[].value` (Card 2.0) and top-level `value` (legacy v1
      // card-action webhook) carry the same payload so either wire shape
      // round-trips through `extractPermissionActionValue`.
      behaviors: [{ type: 'callback', value }],
      value,
    };
  };

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: makeHeader({
      title: botName,
      subtitle: 'permission',
      template: 'orange',
      tagText: '授权',
      tagColor: 'orange',
      // `icon: 'lock_outlined'` removed: the orange template + "Permission" tag
      // already anchor the header visually; the lock_outlined standard_icon
      // crowded the title row in narrow chats without conveying extra signal.
    }),
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        // Card 2.0 dropped the v1 `action` container (real-device HTTP 400,
        // code 230099 / ErrCode 200861 "unsupported tag action") — buttons
        // ride a column_set instead. `flex_mode: 'flow'` gives native
        // responsive wrap: wide screens keep a single row of three buttons;
        // narrow screens auto-flow extra columns to the next row instead of
        // compressing button text into "Allow once..." ellipsis. The previous
        // default `flex_mode: 'none'` was the documented "narrow-screen
        // compression" mode that produced the truncation bug.
        {
          tag: 'column_set',
          flex_mode: 'flow',
          columns: [
            {
              tag: 'column',
              width: 'auto',
              elements: [button('仅本次允许', 'allow', 'primary')],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [button('始终允许', 'always', 'default')],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [button('拒绝', 'deny', 'danger')],
            },
          ],
        },
      ],
    },
  };
}

/**
 * Read-only terminal card that replaces the permission card after the user
 * decides. Deliberately contains NO buttons so it can never be re-clicked.
 * Header colour + tag reflect the decision (green = allowed, red = denied).
 * `resolvedByOpenId`, when present, renders a `· Action by @user` mention line.
 */
export function buildPermissionResolvedCard(
  renderable: Pick<ChannelRenderablePermission, 'toolName'>,
  behavior: ChannelPermissionBehavior,
  resolvedByOpenId?: string,
  botName: string = DEFAULT_BOT_NAME,
): Record<string, unknown> {
  const allowed = behavior !== 'deny';
  const statusIcon = allowed ? '✅' : '🚫';
  const lines = [
    `${statusIcon} **${permissionResolvedLabel(behavior)}** · \`${escapeMarkdownCode(renderable.toolName)}\``,
  ];
  if (resolvedByOpenId && resolvedByOpenId.trim()) {
    lines.push(`<font color='grey'>操作人 <at id=${resolvedByOpenId.trim()}></at></font>`);
  }
  return {
    schema: '2.0',
    // `update_multi: true` is REQUIRED for Card 2.0 PATCH to apply (same fix as
    // buildQuestionnaireSubmittedCard) — without it Feishu no-ops the morph.
    config: { wide_screen_mode: true, update_multi: true },
    header: makeHeader({
      title: botName,
      subtitle: 'permission',
      template: allowed ? 'green' : 'red',
      tagText: allowed ? '已授权' : '已拒绝',
      tagColor: allowed ? 'green' : 'red',
    }),
    body: {
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    },
  };
}

// ---------------------------------------------------------------------------
// Card-action decoder
// ---------------------------------------------------------------------------

function toObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isBehavior(value: unknown): value is ChannelPermissionBehavior {
  return value === 'allow' || value === 'deny' || value === 'always';
}

/**
 * Extract a {@link PermissionActionValue} from a raw Feishu card-action event.
 * Mirrors `extractQuestionnaireSubmitValue`: searches the same v1/v2 candidate
 * locations, each of which may be an object OR a JSON string. Returns the value
 * only when `kind === 'permission_action'`, `behavior` is a valid decision, and
 * `requestId` is a non-empty string — so a questionnaire submit (or any foreign
 * card) decodes to `null` and the two branches never cross-eat each other.
 */
export function extractPermissionActionValue(rawEvent: unknown): PermissionActionValue | null {
  const event = toObject(rawEvent);
  if (!event) return null;
  const eventBody = toObject(event.event);
  const actionObj = toObject(event.action) ?? toObject(eventBody?.action);

  const candidates: unknown[] = [
    actionObj?.value,
    event.action_value,
    event.value,
    eventBody?.action_value,
    eventBody?.value,
  ];

  for (const candidate of candidates) {
    let valueObj: Record<string, unknown> | null = null;
    if (typeof candidate === 'string') {
      try {
        valueObj = toObject(JSON.parse(candidate));
      } catch {
        valueObj = null;
      }
    } else {
      valueObj = toObject(candidate);
    }
    if (!valueObj) continue;
    if (
      valueObj.kind === PERMISSION_ACTION_KIND &&
      typeof valueObj.requestId === 'string' &&
      valueObj.requestId.length > 0 &&
      isBehavior(valueObj.behavior)
    ) {
      return {
        kind: PERMISSION_ACTION_KIND,
        requestId: valueObj.requestId,
        behavior: valueObj.behavior,
      };
    }
  }
  return null;
}
