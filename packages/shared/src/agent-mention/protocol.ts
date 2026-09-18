/**
 * Reversible, persisted representation for a user-selected Agent mention.
 *
 * This deliberately has no dependency on a runtime roster. A caller may
 * render the decoded display name, while runtime code separately authorizes
 * the request ref before turning it into a Task instruction.
 */
export interface AgentReference {
  readonly requestRef: string;
  readonly displayName: string;
}

export const AGENT_REFERENCE_ERROR_CODES = {
  INVALID_AGENT_REFERENCE: 'INVALID_AGENT_REFERENCE',
  UNKNOWN_AGENT_REFERENCE: 'UNKNOWN_AGENT_REFERENCE',
  UNAUTHORIZED_AGENT_REFERENCE: 'UNAUTHORIZED_AGENT_REFERENCE',
} as const;

export type AgentReferenceErrorCode =
  (typeof AGENT_REFERENCE_ERROR_CODES)[keyof typeof AGENT_REFERENCE_ERROR_CODES];

export interface AgentReferenceTextSegment {
  readonly type: 'text';
  readonly content: string;
}

export interface AgentReferenceMentionSegment {
  readonly type: 'agent-reference';
  readonly reference: AgentReference;
  /** Original bytes, retained so failed authorization can fail closed. */
  readonly raw: string;
}

export type AgentReferenceSegment = AgentReferenceTextSegment | AgentReferenceMentionSegment;

export interface ParseAgentReferencesResult {
  readonly segments: readonly AgentReferenceSegment[];
  readonly errorCodes: readonly AgentReferenceErrorCode[];
}

const AGENT_REFERENCE_BLOCK_RE =
  /<agent-reference\b[^>]*>[\s\S]*?<\/agent-reference\s*>/gu;
const AGENT_REFERENCE_LITERAL_RE = /<\/?agent-reference\b/giu;
const AGENT_REFERENCE_LITERAL_TEST_RE = /<\/?agent-reference\b/iu;
const ESCAPED_AGENT_REFERENCE_LITERAL_RE = /&lt;(\/?agent-reference\b)/giu;
const EXACT_AGENT_REFERENCE_RE =
  /^<agent-reference request-ref="([^"]+)" display-name="([^"]+)">([\s\S]*)<\/agent-reference>$/u;

function appendError(
  errorCodes: AgentReferenceErrorCode[],
  errorCode: AgentReferenceErrorCode,
): void {
  if (!errorCodes.includes(errorCode)) errorCodes.push(errorCode);
}

function appendText(segments: AgentReferenceSegment[], content: string): void {
  if (!content) return;
  const previous = segments.at(-1);
  if (previous?.type === 'text') {
    segments[segments.length - 1] = { type: 'text', content: previous.content + content };
    return;
  }
  segments.push({ type: 'text', content });
}

/** Restore only text that this module escaped to keep manual literals non-semantic. */
function restoreEscapedAgentReferenceLiterals(content: string): string {
  return content.replace(ESCAPED_AGENT_REFERENCE_LITERAL_RE, '<$1');
}

function isUsableValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function safelyDecodeAttribute(encodedValue: string): string | undefined {
  try {
    return decodeURIComponent(encodedValue);
  } catch {
    return undefined;
  }
}

function escapeText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function parseSerializedAgentReference(raw: string): AgentReference | undefined {
  const match = EXACT_AGENT_REFERENCE_RE.exec(raw);
  if (!match) return undefined;

  const requestRef = safelyDecodeAttribute(match[1]!);
  const displayName = safelyDecodeAttribute(match[2]!);
  if (!isUsableValue(requestRef) || !isUsableValue(displayName)) return undefined;

  // Only the serializer can create a semantic reference. A manually composed
  // tag with a mismatched body remains ordinary text and never becomes a task.
  if (match[3] !== escapeText(`@${displayName}`)) return undefined;
  return { requestRef, displayName };
}

/**
 * Serialize one trusted editor node. Invalid values return `undefined` so a
 * UI caller can keep them as normal text rather than emitting malformed markup.
 */
export function serializeAgentReference(reference: AgentReference): string | undefined {
  if (!isUsableValue(reference?.requestRef) || !isUsableValue(reference?.displayName)) {
    return undefined;
  }

  try {
    const requestRef = encodeURIComponent(reference.requestRef);
    const displayName = encodeURIComponent(reference.displayName);
    return `<agent-reference request-ref="${requestRef}" display-name="${displayName}">${escapeText(
      `@${reference.displayName}`,
    )}</agent-reference>`;
  } catch {
    // encodeURIComponent rejects malformed surrogate pairs. Do not emit a
    // partly encoded protocol block in that case.
    return undefined;
  }
}

/**
 * Escape literal protocol tag openers in ordinary editor text. It is
 * intentionally narrow: user prose is otherwise preserved byte-for-byte.
 */
export function escapeAgentReferenceLiterals(content: string): string {
  return content.replace(AGENT_REFERENCE_LITERAL_RE, (literal) => `&lt;${literal.slice(1)}`);
}

/**
 * Parse only exact serializer output. Every malformed or partial block stays
 * in the returned text segments, accompanied solely by a stable error code.
 */
export function parseAgentReferences(content: string): ParseAgentReferencesResult {
  const segments: AgentReferenceSegment[] = [];
  const errorCodes: AgentReferenceErrorCode[] = [];
  let cursor = 0;

  for (const match of content.matchAll(AGENT_REFERENCE_BLOCK_RE)) {
    const index = match.index ?? 0;
    appendText(segments, content.slice(cursor, index));

    const raw = match[0];
    const reference = parseSerializedAgentReference(raw);
    if (reference) {
      segments.push({ type: 'agent-reference', reference, raw });
    } else {
      appendText(segments, raw);
      appendError(errorCodes, AGENT_REFERENCE_ERROR_CODES.INVALID_AGENT_REFERENCE);
    }
    cursor = index + raw.length;
  }

  appendText(segments, content.slice(cursor));
  if (
    segments.some(
      (segment) => segment.type === 'text' && AGENT_REFERENCE_LITERAL_TEST_RE.test(segment.content),
    )
  ) {
    appendError(errorCodes, AGENT_REFERENCE_ERROR_CODES.INVALID_AGENT_REFERENCE);
  }
  for (const [index, segment] of segments.entries()) {
    if (segment.type !== 'text') continue;
    const restored = restoreEscapedAgentReferenceLiterals(segment.content);
    if (restored !== segment.content) {
      segments[index] = { type: 'text', content: restored };
    }
  }

  return { segments, errorCodes };
}
