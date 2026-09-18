/**
 * Internal context fragment — append-only runtime steering envelope.
 *
 * Thread-goal steering prompts (continuation / budget_limit /
 * objective_updated) are injected as synthetic user messages so the
 * runtime can persist them in pi-history (audit / replay / UI). The wrapper
 * identifies those synthetic messages without changing the append-only
 * provider history contract.
 *
 * This module is the archon equivalent:
 *
 *  - `wrapInternalContext` wraps a body in
 *    `<archon_internal_context source="...">...</archon_internal_context>`
 *    with the same `\n`-padded body shape as codex
 *    `InternalModelContextFragment::body`.
 *  - `isInternalContextMessage` recognises a pi `AgentMessage` that
 *    carries the wrapper, handling both `content: string` and the
 *    canonical `content: [{type:'text', ...}]` shape that
 *    `agent.prompt(text)` produces.
 */

import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';

/**
 * Opening tag prefix. Includes the `source="` attribute opener so
 * callers cannot accidentally produce a wrapper without a source.
 */
export const INTERNAL_CONTEXT_OPEN_PREFIX = '<archon_internal_context source="';

/** Closing tag — fixed string, no attributes. */
export const INTERNAL_CONTEXT_CLOSE_TAG = '</archon_internal_context>';

/**
 * Allowed source labels — lowercase ASCII, digits, and underscore,
 * starting with a letter. Mirrors codex `InternalContextSource::new`.
 */
const SOURCE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Wrap `body` in the archon internal-context XML envelope with the
 * given `source` tag. `source` MUST match `SOURCE_PATTERN` — the
 * pattern is constrained so the value can be embedded without
 * attribute-escaping. Throws on invalid input rather than silently
 * producing a broken wrapper.
 */
export function wrapInternalContext(source: string, body: string): string {
  if (!SOURCE_PATTERN.test(source)) {
    throw new Error(`invalid internal_context source: ${JSON.stringify(source)}`);
  }
  return `${INTERNAL_CONTEXT_OPEN_PREFIX}${source}">\n${body}\n${INTERNAL_CONTEXT_CLOSE_TAG}`;
}

/**
 * True when the message is a `user` message whose entire text content
 * is an `<archon_internal_context source="...">...</archon_internal_context>`
 * wrapper. Tolerates leading/trailing whitespace.
 *
 * Recognises both representation shapes pi-agent uses for user input:
 *  - `content: string` (older code paths, queue items)
 *  - `content: [{type:'text', text:string}]` (what `agent.prompt(text)`
 *    produces; see pi-coding-agent `agent.js`).
 *
 * Multi-block user messages (e.g. text + image) are never wrappers —
 * the wrapper is whole-message by construction.
 */
export function isInternalContextMessage(message: PiAgentMessage): boolean {
  if (message.role !== 'user') return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return matchesWrapper(content);
  }
  if (!Array.isArray(content) || content.length !== 1) return false;
  const first = content[0];
  if (!first || typeof first !== 'object') return false;
  const block = first as { type?: unknown; text?: unknown };
  if (block.type !== 'text' || typeof block.text !== 'string') return false;
  return matchesWrapper(block.text);
}

function matchesWrapper(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith(INTERNAL_CONTEXT_OPEN_PREFIX) && trimmed.endsWith(INTERNAL_CONTEXT_CLOSE_TAG)
  );
}
