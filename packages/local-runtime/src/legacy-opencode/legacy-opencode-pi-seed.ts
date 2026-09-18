import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import { MsgType, Role, type AgentMessage } from '@mavis/agent-core/protocol/agent-message';

import { registerLocalAsset } from '../assets/store.js';
import type {
  LegacyOpencodeMessageScan,
  LegacyOpencodeSessionRecord,
} from './legacy-opencode-store.js';

export interface LegacyPiSeedStrategyOptions {
  shortConversationMessageLimit: number;
  mediumConversationMessageLimit: number;
  recentConversationMessageLimit: number;
  maxSeedChars: number;
  maxSeedMessageChars: number;
  transcriptAssetMessageThreshold: number;
  transcriptAssetCharThreshold: number;
  maxTranscriptAssetChars: number;
}

export const DEFAULT_PI_SEED_STRATEGY: LegacyPiSeedStrategyOptions = {
  shortConversationMessageLimit: 80,
  mediumConversationMessageLimit: 240,
  recentConversationMessageLimit: 60,
  maxSeedChars: 160_000,
  maxSeedMessageChars: 8_000,
  transcriptAssetMessageThreshold: 240,
  transcriptAssetCharThreshold: 240_000,
  maxTranscriptAssetChars: 5_000_000,
};

export const PI_SEED_MARKER_PREFIX = 'migrationSeedId: legacy-opencode:';

export const UNSAFE_LEGACY_STATUS_NOTE =
  'Started, running, pending, partial, in_progress, queued, processing, streaming, active, tool, system, permission, and questionnaire states are historical only and must not be resumed as executable state.';

export interface LegacyPiSeedResult {
  messages: PiAgentMessage[];
  strategy: string;
  warnings: string[];
  report: Record<string, unknown>;
}

interface ConversationalSeedMessage {
  role: 'user' | 'assistant';
  text: string;
  msgId?: string;
  timestamp?: number;
}

interface RegisteredTranscriptAsset {
  assetId: string;
  relativePath: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
}

/**
 * Pick a pi-history seed strategy from the conversational message count and
 * total text size. Full conversations under both budgets stay verbatim;
 * medium ones get the most recent slice; oversized ones fall through to a
 * transcript-asset summary so the seed prompt stays manageable.
 */
export async function buildPiSeedHistory(input: {
  session: LegacyOpencodeSessionRecord;
  messages: AgentMessage[];
  sourceMessageScan: LegacyOpencodeMessageScan;
  options: LegacyPiSeedStrategyOptions;
  dataDir: () => string;
  nowMs: () => number;
}): Promise<LegacyPiSeedResult> {
  const conversational = conversationalSeedMessages(input.messages);
  const totalTextChars = conversational.reduce((sum, message) => sum + message.text.length, 0);
  const toolOrSystemEventCount = countToolOrSystemMessages(input.messages);
  const strategy = choosePiSeedStrategy(conversational.length, totalTextChars, input.options);
  const selected =
    strategy === 'full'
      ? conversational
      : strategy === 'expanded'
        ? conversational.slice(-input.options.mediumConversationMessageLimit)
        : conversational.slice(-input.options.recentConversationMessageLimit);
  let transcriptAsset: RegisteredTranscriptAsset | undefined;
  let transcriptAssetError: string | undefined;
  if (strategy === 'transcript-asset') {
    try {
      transcriptAsset = await registerTranscriptAsset(
        input.session,
        input.messages,
        input.dataDir,
        input.nowMs,
        input.options.maxTranscriptAssetChars,
      );
    } catch (err) {
      transcriptAssetError = err instanceof Error ? err.message : String(err);
    }
  }
  const seed = buildPiSeedText({
    session: input.session,
    messages: input.messages,
    sourceMessageScan: input.sourceMessageScan,
    selected,
    strategy,
    totalTextChars,
    toolOrSystemEventCount,
    transcriptAsset,
    options: input.options,
  });
  const warnings = [
    ...(toolOrSystemEventCount > 0
      ? [`legacy_pi_history_non_conversational_events_skipped:${toolOrSystemEventCount}`]
      : []),
    ...(strategy === 'transcript-asset' ? ['legacy_pi_history_degraded_to_transcript_asset'] : []),
    ...(transcriptAsset?.truncated ? ['legacy_pi_history_transcript_asset_truncated'] : []),
    ...(transcriptAssetError
      ? [`legacy_pi_history_transcript_asset_failed:${transcriptAssetError.slice(0, 160)}`]
      : []),
    ...(seed.truncated ? ['legacy_pi_history_seed_truncated'] : []),
  ];
  return {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: seed.text }],
      } as PiAgentMessage,
    ],
    strategy,
    warnings,
    report: {
      strategy,
      sourceMessages: input.sourceMessageScan.sourceCount,
      parsedMessages: input.messages.length,
      conversationalMessages: conversational.length,
      selectedConversationalMessages: selected.length,
      totalTextChars,
      seedChars: seed.text.length,
      toolOrSystemEventCount,
      ...(transcriptAsset
        ? {
            transcriptAsset: {
              assetId: transcriptAsset.assetId,
              relativePath: transcriptAsset.relativePath,
              bytes: transcriptAsset.bytes,
              sha256: transcriptAsset.sha256,
              truncated: transcriptAsset.truncated,
            },
          }
        : {}),
      ...(transcriptAssetError ? { transcriptAssetError } : {}),
    },
  };
}

function choosePiSeedStrategy(
  conversationalMessageCount: number,
  totalTextChars: number,
  options: LegacyPiSeedStrategyOptions,
): 'full' | 'expanded' | 'transcript-asset' {
  if (
    conversationalMessageCount <= options.shortConversationMessageLimit &&
    totalTextChars <= options.maxSeedChars
  ) {
    return 'full';
  }
  if (
    conversationalMessageCount <= options.mediumConversationMessageLimit &&
    totalTextChars <= options.transcriptAssetCharThreshold
  ) {
    return 'expanded';
  }
  return 'transcript-asset';
}

function buildPiSeedText(input: {
  session: LegacyOpencodeSessionRecord;
  messages: AgentMessage[];
  sourceMessageScan: LegacyOpencodeMessageScan;
  selected: ConversationalSeedMessage[];
  strategy: string;
  totalTextChars: number;
  toolOrSystemEventCount: number;
  transcriptAsset?: {
    assetId: string;
    relativePath: string;
    absolutePath: string;
    bytes: number;
    sha256: string;
    truncated?: boolean;
  };
  options: LegacyPiSeedStrategyOptions;
}): { text: string; truncated: boolean } {
  const headerLines = [
    'This session was migrated from the legacy opencode runtime.',
    'The complete product-visible transcript is preserved in local-runtime display history.',
    UNSAFE_LEGACY_STATUS_NOTE,
    '',
    '## Migration manifest',
    `${PI_SEED_MARKER_PREFIX}${input.session.sessionId}`,
    `sessionId: ${input.session.sessionId}`,
    input.session.legacyFrameworkSessionId
      ? `legacyFrameworkSessionId: ${input.session.legacyFrameworkSessionId}`
      : undefined,
    `agentName: ${input.session.agentName}`,
    input.session.title ? `title: ${input.session.title}` : undefined,
    `strategy: ${input.strategy}`,
    `sourceMessageCount: ${input.sourceMessageScan.sourceCount}`,
    `importedDisplayMessageCount: ${input.messages.length}`,
    `conversationalMessageCount: ${conversationalSeedMessages(input.messages).length}`,
    `toolOrSystemEventCount: ${input.toolOrSystemEventCount}`,
    `totalConversationalTextChars: ${input.totalTextChars}`,
    `sourceChecksum: ${input.sourceMessageScan.rawChecksum}`,
    input.transcriptAsset
      ? `transcriptAsset: ${input.transcriptAsset.relativePath} (${input.transcriptAsset.sha256})`
      : undefined,
    '',
    input.strategy === 'transcript-asset' ? '## Recent safe turns' : '## Safe migrated turns',
  ].filter((line): line is string => typeof line === 'string');
  const header = headerLines.join('\n');
  const turnBlocks = input.selected.map((message) =>
    formatSeedMessage(message, input.options.maxSeedMessageChars),
  );
  const fullText = [header, ...turnBlocks].join('\n');
  if (fullText.length <= input.options.maxSeedChars) return { text: fullText, truncated: false };

  const truncationLine = '[Legacy migration seed truncated: kept newest safe turns.]';
  const prefix = `${header}\n${truncationLine}`;
  const turnBudget = input.options.maxSeedChars - prefix.length - 1;
  const newestTurnBlocks = selectNewestSeedBlocks(turnBlocks, Math.max(0, turnBudget));
  const text = [prefix, ...newestTurnBlocks].filter(Boolean).join('\n');
  return {
    text:
      text.length <= input.options.maxSeedChars ? text : text.slice(0, input.options.maxSeedChars),
    truncated: true,
  };
}

function selectNewestSeedBlocks(blocks: string[], maxChars: number): string[] {
  if (maxChars <= 0) return [];
  const selected: string[] = [];
  let used = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    const separatorChars = selected.length === 0 ? 0 : 1;
    if (used + separatorChars + block.length <= maxChars) {
      selected.unshift(block);
      used += separatorChars + block.length;
      continue;
    }
    if (selected.length === 0 && maxChars > 0) {
      selected.unshift(block.slice(Math.max(0, block.length - maxChars)));
    }
    break;
  }
  return selected;
}

function conversationalSeedMessages(messages: AgentMessage[]): ConversationalSeedMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== Role.User && message.role !== Role.Assistant) return [];
    if (message.msg_type === MsgType.AgentToolCall || message.msg_type === MsgType.SystemEvent) {
      return [];
    }
    if ((message.tool_calls?.length ?? 0) > 0) return [];
    if (typeof message.msg_content !== 'string' || !message.msg_content.trim()) return [];
    return [
      {
        role: message.role === Role.User ? 'user' : 'assistant',
        text: message.msg_content,
        ...(typeof message.msg_id === 'string' ? { msgId: message.msg_id } : {}),
        ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}),
      },
    ];
  });
}

async function registerTranscriptAsset(
  session: LegacyOpencodeSessionRecord,
  messages: AgentMessage[],
  dataDir: () => string,
  nowMs: () => number,
  maxChars: number,
): Promise<RegisteredTranscriptAsset> {
  const transcript = buildTranscriptMarkdown(session, messages, maxChars);
  const dataUrl = `data:text/markdown;base64,${Buffer.from(transcript.text, 'utf-8').toString('base64')}`;
  const asset = await registerLocalAsset({
    dataDir,
    fileName: `legacy-transcript-${safeFileSegment(session.sessionId)}.md`,
    mimeType: 'text/markdown',
    kind: 'document',
    sourceKind: 'legacy-migration',
    dataUrl,
    sessionId: session.sessionId,
    generatedBy: 'legacy-opencode-migrator',
    nowMs,
  });
  return { ...asset, truncated: transcript.truncated };
}

function buildTranscriptMarkdown(
  session: LegacyOpencodeSessionRecord,
  messages: AgentMessage[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;
  let currentLength = 0;
  const append = (value: string | undefined): boolean => {
    if (value === undefined) return true;
    const separatorLength = lines.length === 0 ? 0 : 1;
    const nextLength = separatorLength + value.length;
    if (currentLength + nextLength <= maxChars) {
      lines.push(value);
      currentLength += nextLength;
      return true;
    }
    const remaining = Math.max(0, maxChars - currentLength - separatorLength);
    if (remaining > 0) lines.push(value.slice(0, remaining));
    truncated = true;
    return false;
  };
  for (const line of [
    `# Legacy transcript: ${session.title || session.sessionId}`,
    '',
    `sessionId: ${session.sessionId}`,
    session.legacyFrameworkSessionId
      ? `legacyFrameworkSessionId: ${session.legacyFrameworkSessionId}`
      : undefined,
    `agentName: ${session.agentName}`,
    '',
  ]) {
    if (!append(line)) break;
  }
  if (!truncated) {
    for (const [index, message] of messages.entries()) {
      const remaining = Math.max(0, maxChars - currentLength);
      const block = [
        `## ${index + 1}. ${String(message.role ?? 'unknown')}${message.msg_id ? ` (${message.msg_id})` : ''}`,
        '',
        formatTranscriptMessage(message, remaining),
        '',
      ];
      for (const line of block) {
        if (!append(line)) break;
      }
      if (truncated) break;
    }
  }
  if (truncated) {
    lines.push('');
    lines.push('[Legacy transcript truncated by migration safety limit.]');
  }
  return { text: `${lines.join('\n')}\n`, truncated };
}

function formatSeedMessage(message: ConversationalSeedMessage, maxChars: number): string {
  const role = message.role === 'user' ? 'User' : 'Assistant';
  const prefix = message.msgId ? `${role} (${message.msgId})` : role;
  return `${prefix}: ${truncateForSeed(message.text, maxChars)}`;
}

function countToolOrSystemMessages(messages: AgentMessage[]): number {
  return messages.filter(
    (message) =>
      message.msg_type === MsgType.AgentToolCall ||
      message.msg_type === MsgType.SystemEvent ||
      (message.tool_calls?.length ?? 0) > 0,
  ).length;
}

function truncateForSeed(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

function formatTranscriptMessage(
  message: AgentMessage,
  maxChars = Number.POSITIVE_INFINITY,
): string {
  if (typeof message.msg_content === 'string' && message.msg_content.trim()) {
    return truncateTranscriptValue(message.msg_content.trim(), maxChars);
  }
  if (message.msg_type === MsgType.AgentToolCall || (message.tool_calls?.length ?? 0) > 0) {
    return truncateTranscriptValue(
      `[tool event preserved in display history]\n\n${safeJson(message)}`,
      maxChars,
    );
  }
  if (message.msg_type === MsgType.SystemEvent) {
    return truncateTranscriptValue(
      `[system event preserved in display history]\n\n${safeJson(message)}`,
      maxChars,
    );
  }
  return truncateTranscriptValue(safeJson(message), maxChars);
}

function truncateTranscriptValue(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, Math.max(0, maxChars)) : value;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'session';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
