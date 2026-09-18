import type {
  TranscriptWindow,
  VerificationEvidence,
  VerificationEvidenceMode,
} from './verifier-port.js';

export const MAX_VERIFICATION_BRIEF_CHARS = 14_000;
export const MAX_SUBAGENT_VERIFICATION_PROMPT_CHARS = 16_000;
export const MAX_EVALUATOR_TAIL_CHARS = 32_000;
export const MAX_EVALUATOR_TAIL_MESSAGES = 20;
export const MAX_TRANSCRIPT_FALLBACK_CHARS = 512_000;
export const MAX_TRANSCRIPT_FALLBACK_MESSAGES = 200;

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_CLAIM_CHARS = 2_000;
const MAX_CHANGE_CHARS = 4_000;
const MAX_CHANGE_ITEMS = 100;
const MAX_RECENT_TAIL_CHARS = 4_000;
const MAX_RECENT_TAIL_MESSAGES = 5;
const MAX_RECENT_MESSAGE_CHARS = 800;

interface EvidenceBrief {
  readonly version: 1;
  readonly objective: { readonly text: string; readonly digest: string };
  readonly claim: string;
  readonly changes: {
    readonly files: readonly string[];
    readonly commands: readonly string[];
  };
  readonly baselineRef?: string;
  readonly recentTail: readonly { readonly role: string; readonly text: string }[];
  readonly sourceTranscriptTruncated: boolean;
}

export interface AssembleVerificationEvidenceInput {
  readonly mode: VerificationEvidenceMode;
  readonly objective: string;
  readonly objectiveDigest: string;
  readonly claim?: string;
  readonly baselineRef?: string;
  readonly transcriptWindow: TranscriptWindow;
}

/**
 * Build one bounded evidence index. Verifier prompts render these exact strings;
 * no pretty-printing or second measurement path can expand them afterwards.
 */
export function assembleVerificationEvidence(
  input: AssembleVerificationEvidenceInput,
): VerificationEvidence {
  const messages = input.transcriptWindow.messages;
  const changes = extractChanges(messages);
  const brief: MutableEvidenceBrief = {
    version: 1,
    objective: {
      text: truncate(input.objective, MAX_OBJECTIVE_CHARS),
      digest: input.objectiveDigest,
    },
    claim: truncate(input.claim?.trim() || 'No explicit completion claim was supplied.', MAX_CLAIM_CHARS),
    changes,
    ...(input.baselineRef?.trim() ? { baselineRef: truncate(input.baselineRef.trim(), 128) } : {}),
    recentTail: recentTail(messages),
    sourceTranscriptTruncated: input.transcriptWindow.truncated,
  };
  const serializedBrief = fitBrief(brief);
  const evaluatorTail = serializeBoundedMessages(
    messages,
    MAX_EVALUATOR_TAIL_MESSAGES,
    MAX_EVALUATOR_TAIL_CHARS,
  );
  const transcript = serializeBoundedMessages(
    messages,
    MAX_TRANSCRIPT_FALLBACK_MESSAGES,
    MAX_TRANSCRIPT_FALLBACK_CHARS,
  );
  return {
    mode: input.mode,
    serializedBrief,
    briefChars: serializedBrief.length,
    serializedEvaluatorTail: evaluatorTail.serialized,
    evaluatorTailTruncated: input.transcriptWindow.truncated || evaluatorTail.truncated,
    serializedTranscript: transcript.serialized,
    transcriptTruncated: input.transcriptWindow.truncated || transcript.truncated,
  };
}

interface MutableEvidenceBrief {
  version: 1;
  objective: { text: string; digest: string };
  claim: string;
  changes: { files: string[]; commands: string[] };
  baselineRef?: string;
  recentTail: { role: string; text: string }[];
  sourceTranscriptTruncated: boolean;
}

function fitBrief(brief: MutableEvidenceBrief): string {
  let serialized = safeJsonStringify(brief);
  while (serialized.length > MAX_VERIFICATION_BRIEF_CHARS && brief.recentTail.length > 0) {
    brief.recentTail.shift();
    serialized = safeJsonStringify(brief);
  }
  while (
    serialized.length > MAX_VERIFICATION_BRIEF_CHARS &&
    (brief.changes.commands.length > 0 || brief.changes.files.length > 0)
  ) {
    if (brief.changes.commands.length >= brief.changes.files.length) {
      brief.changes.commands.pop();
    } else {
      brief.changes.files.pop();
    }
    serialized = safeJsonStringify(brief);
  }
  if (serialized.length > MAX_VERIFICATION_BRIEF_CHARS && 'baselineRef' in brief) {
    delete brief.baselineRef;
    serialized = safeJsonStringify(brief);
  }
  if (serialized.length > MAX_VERIFICATION_BRIEF_CHARS) {
    const overflow = serialized.length - MAX_VERIFICATION_BRIEF_CHARS;
    brief.claim = truncate(brief.claim, Math.max(1, brief.claim.length - overflow));
    serialized = safeJsonStringify(brief);
  }
  if (serialized.length > MAX_VERIFICATION_BRIEF_CHARS) {
    const overflow = serialized.length - MAX_VERIFICATION_BRIEF_CHARS;
    brief.objective = {
      ...brief.objective,
      text: truncate(brief.objective.text, Math.max(1, brief.objective.text.length - overflow)),
    };
    serialized = safeJsonStringify(brief);
  }
  if (serialized.length > MAX_VERIFICATION_BRIEF_CHARS) {
    throw new Error('Goal verification evidence brief exceeded its hard rendered limit.');
  }
  return serialized;
}

/** Keep untrusted data from manufacturing the XML-like prompt boundary itself. */
function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function extractChanges(messages: readonly unknown[]): {
  files: string[];
  commands: string[];
} {
  const files = new Set<string>();
  const commands = new Set<string>();
  for (const message of messages) {
    for (const call of toolCalls(message)) {
      const name = call.name.toLowerCase();
      if (['write', 'edit', 'apply_patch'].includes(name)) {
        for (const path of filePaths(call.arguments)) files.add(path);
      }
      if (['bash', 'shell', 'exec', 'exec_command'].includes(name)) {
        const command = commandText(call.arguments);
        if (command) commands.add(command);
      }
      if (files.size + commands.size >= MAX_CHANGE_ITEMS) break;
    }
    if (files.size + commands.size >= MAX_CHANGE_ITEMS) break;
  }
  return capChanges([...files], [...commands]);
}

function capChanges(files: string[], commands: string[]): { files: string[]; commands: string[] } {
  let serialized = JSON.stringify({ files, commands });
  while (serialized.length > MAX_CHANGE_CHARS && (commands.length > 0 || files.length > 0)) {
    if (commands.length >= files.length) commands.pop();
    else files.pop();
    serialized = JSON.stringify({ files, commands });
  }
  return { files, commands };
}

function toolCalls(message: unknown): readonly { name: string; arguments: unknown }[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (!isRecord(part)) return [];
    const name =
      typeof part.name === 'string'
        ? part.name
        : typeof part.toolName === 'string'
          ? part.toolName
          : undefined;
    if (!name || !['toolCall', 'tool-call', 'tool_call'].includes(String(part.type))) return [];
    return [{ name, arguments: part.arguments ?? part.args ?? {} }];
  });
}

function filePaths(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const direct = ['path', 'filePath', 'file_path'].flatMap((key) =>
    typeof value[key] === 'string' ? [truncate(value[key], 1_000)] : [],
  );
  const patch = typeof value.patch === 'string' ? value.patch : typeof value.input === 'string' ? value.input : '';
  const fromPatch = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)].map(
    (match) => truncate(match[1]?.trim() ?? '', 1_000),
  );
  return [...direct, ...fromPatch].filter(Boolean);
}

function commandText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['cmd', 'command', 'script']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return truncate(value[key].trim(), 2_000);
    }
  }
  return undefined;
}

function recentTail(messages: readonly unknown[]): { role: string; text: string }[] {
  const tail = messages.slice(-MAX_RECENT_TAIL_MESSAGES).flatMap((message) => {
    if (!isRecord(message)) return [];
    const text = messageText(message);
    return text ? [{ role: typeof message.role === 'string' ? message.role : 'unknown', text }] : [];
  });
  while (JSON.stringify(tail).length > MAX_RECENT_TAIL_CHARS && tail.length > 0) tail.shift();
  return tail;
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return truncate(content, MAX_RECENT_MESSAGE_CHARS);
  if (!Array.isArray(content)) return '';
  const text = content
    .flatMap((part) =>
      isRecord(part) && typeof part.text === 'string' && ['text', 'reasoning'].includes(String(part.type))
        ? [part.text]
        : [],
    )
    .join('\n')
    .trim();
  return truncate(text, MAX_RECENT_MESSAGE_CHARS);
}

function serializeBoundedMessages(
  messages: readonly unknown[],
  maxMessages: number,
  maxChars: number,
): { readonly serialized: string; readonly truncated: boolean } {
  const candidates = messages.slice(-maxMessages);
  let retained = candidates.slice();
  let serialized = JSON.stringify(retained);
  let contentTruncated = candidates.length < messages.length;
  while (serialized.length > maxChars && retained.length > 1) {
    retained.shift();
    contentTruncated = true;
    serialized = JSON.stringify(retained);
  }
  if (serialized.length > maxChars) {
    const preview = truncate(serialized, Math.max(1, maxChars - 96));
    retained = [{ truncatedMessagePreview: preview }];
    contentTruncated = true;
    serialized = JSON.stringify(retained);
  }
  if (serialized.length > maxChars) serialized = '[]';
  return {
    serialized,
    truncated: contentTruncated || serialized === '[]',
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return '…'.slice(0, maxChars);
  return `${value.slice(0, maxChars - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
