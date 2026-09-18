import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';

const INTERNAL_USER_SOURCES = new Set(['system', 'communication', 'team-engine']);
const SYNTHETIC_RESPONSE_RE = /<(questionnaire|permission)-response\b/u;
const NAVIGATION_BLOCK_RE =
  /<(agent-message|agent-context|system-reminder|peer-memory-path|engine-message|inbound-context|html-selection-context|archon_internal_context|locale-context|runtime-data-context|permission-ask|permission-response|questionnaire-ask|questionnaire-response|deliver-assets|deliver_assets|mavis-thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const MEDIA_TAG_RE = /<media\b[^>]*\/?\s*>/giu;
const UNICODE_WHITESPACE_RE = /\s+/gu;

export function isNavigableUserInput(message: AgentMessage): boolean {
  if (message.role !== 'user' || message.kind != null) return false;
  if (message.source && INTERNAL_USER_SOURCES.has(message.source)) return false;
  return !SYNTHETIC_RESPONSE_RE.test(message.msg_content ?? '');
}

export function projectNavigationText(content: string | undefined): string {
  if (!content) return '';
  return content
    .replace(NAVIGATION_BLOCK_RE, '')
    .replace(MEDIA_TAG_RE, '')
    .trim()
    .replace(UNICODE_WHITESPACE_RE, ' ');
}

export function takeUnicodeCodePoints(content: string, limit: number): string {
  if (limit <= 0 || !content) return '';
  return [...content].slice(0, limit).join('');
}
