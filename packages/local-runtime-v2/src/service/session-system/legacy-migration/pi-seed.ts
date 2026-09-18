import type { LegacyImportedAssetPort } from './assets.js';
import type { LegacyPiHistoryMessage } from './conversion/native-conversion-types.js';
import {
  LEGACY_MESSAGE_ROLE,
  LEGACY_MESSAGE_TYPE,
  type LegacyOpencodeDisplayMessage,
} from './legacy-message.js';
import type { LegacyOpencodeMessageScan, LegacyOpencodeSessionRecord } from './repo/contract.js';

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
  messages: LegacyPiHistoryMessage[];
  strategy: string;
  warnings: string[];
  report: Record<string, unknown>;
}

export interface LegacyPiSeedInput {
  readonly session: LegacyOpencodeSessionRecord;
  readonly messages: readonly LegacyOpencodeDisplayMessage[];
  readonly sourceMessageScan: LegacyOpencodeMessageScan;
  readonly options: LegacyPiSeedStrategyOptions;
  readonly assets: LegacyImportedAssetPort;
  readonly nowMs: () => number;
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
export async function buildPiSeedHistory(input: LegacyPiSeedInput): Promise<LegacyPiSeedResult> {
  const conversational = conversationalSeedMessages(input.messages);
  const totalTextChars = conversational.reduce((sum, message) => sum + message.text.length, 0);
  const toolOrSystemEventCount = countToolOrSystemMessages(input.messages);
  const strategy = choosePiSeedStrategy(conversational.length, totalTextChars, input.options);
  const selected = selectSeedMessages(conversational, strategy, input.options);
  const transcript = await tryRegisterTranscriptAsset(input, strategy);
  const seed = buildPiSeedText({
    session: input.session,
    messages: input.messages,
    sourceMessageScan: input.sourceMessageScan,
    selected,
    strategy,
    totalTextChars,
    toolOrSystemEventCount,
    transcriptAsset: transcript.asset,
    options: input.options,
  });
  return {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: seed.text }],
      },
    ],
    strategy,
    warnings: seedWarnings(toolOrSystemEventCount, strategy, transcript, seed.truncated),
    report: seedReport({
      input,
      conversational,
      selected,
      totalTextChars,
      toolOrSystemEventCount,
      seed,
      transcript,
      strategy,
    }),
  };
}

type SeedStrategy = 'full' | 'expanded' | 'transcript-asset';

interface TranscriptRegistration {
  readonly asset?: RegisteredTranscriptAsset;
  readonly error?: string;
}

function selectSeedMessages(
  messages: readonly ConversationalSeedMessage[],
  strategy: SeedStrategy,
  options: LegacyPiSeedStrategyOptions,
): readonly ConversationalSeedMessage[] {
  if (strategy === 'full') return messages;
  if (strategy === 'expanded') return messages.slice(-options.mediumConversationMessageLimit);
  return messages.slice(-options.recentConversationMessageLimit);
}

async function tryRegisterTranscriptAsset(
  input: LegacyPiSeedInput,
  strategy: SeedStrategy,
): Promise<TranscriptRegistration> {
  if (strategy !== 'transcript-asset') return {};
  try {
    return { asset: await registerTranscriptAsset(input) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function seedWarnings(
  eventCount: number,
  strategy: SeedStrategy,
  transcript: TranscriptRegistration,
  seedTruncated: boolean,
): string[] {
  const warnings: string[] = [];
  if (eventCount > 0)
    warnings.push(`legacy_pi_history_non_conversational_events_skipped:${eventCount}`);
  if (strategy === 'transcript-asset')
    warnings.push('legacy_pi_history_degraded_to_transcript_asset');
  if (transcript.asset?.truncated) warnings.push('legacy_pi_history_transcript_asset_truncated');
  if (transcript.error)
    warnings.push(`legacy_pi_history_transcript_asset_failed:${transcript.error.slice(0, 160)}`);
  if (seedTruncated) warnings.push('legacy_pi_history_seed_truncated');
  return warnings;
}

function seedReport(output: {
  readonly input: LegacyPiSeedInput;
  readonly conversational: readonly ConversationalSeedMessage[];
  readonly selected: readonly ConversationalSeedMessage[];
  readonly totalTextChars: number;
  readonly toolOrSystemEventCount: number;
  readonly seed: { readonly text: string; readonly truncated: boolean };
  readonly transcript: TranscriptRegistration;
  readonly strategy: SeedStrategy;
}): Record<string, unknown> {
  return {
    strategy: output.strategy,
    sourceMessages: output.input.sourceMessageScan.sourceCount,
    parsedMessages: output.input.messages.length,
    conversationalMessages: output.conversational.length,
    selectedConversationalMessages: output.selected.length,
    totalTextChars: output.totalTextChars,
    seedChars: output.seed.text.length,
    toolOrSystemEventCount: output.toolOrSystemEventCount,
    ...transcriptReport(output.transcript),
  };
}

function transcriptReport(transcript: TranscriptRegistration): Record<string, unknown> {
  const asset = transcript.asset;
  return {
    ...(asset
      ? {
          transcriptAsset: {
            assetId: asset.assetId,
            relativePath: asset.relativePath,
            bytes: asset.bytes,
            sha256: asset.sha256,
            truncated: asset.truncated,
          },
        }
      : {}),
    ...(transcript.error ? { transcriptAssetError: transcript.error } : {}),
  };
}

function choosePiSeedStrategy(
  conversationalMessageCount: number,
  totalTextChars: number,
  options: LegacyPiSeedStrategyOptions,
): SeedStrategy {
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
  messages: readonly LegacyOpencodeDisplayMessage[];
  sourceMessageScan: LegacyOpencodeMessageScan;
  selected: readonly ConversationalSeedMessage[];
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
    const block = blocks[index];
    if (block === undefined) continue;
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

function conversationalSeedMessages(
  messages: readonly LegacyOpencodeDisplayMessage[],
): ConversationalSeedMessage[] {
  return messages.flatMap((message) => {
    const converted = conversationalSeedMessage(message);
    return converted ? [converted] : [];
  });
}

function conversationalSeedMessage(
  message: LegacyOpencodeDisplayMessage,
): ConversationalSeedMessage | undefined {
  if (!isConversationalRole(message.role)) return undefined;
  if (isToolOrSystemMessage(message)) return undefined;
  if (typeof message.msg_content !== 'string' || !message.msg_content.trim()) return undefined;
  return {
    role: message.role,
    text: message.msg_content,
    ...(typeof message.msg_id === 'string' ? { msgId: message.msg_id } : {}),
    ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}),
  };
}

function isConversationalRole(role: unknown): role is 'user' | 'assistant' {
  return role === LEGACY_MESSAGE_ROLE.user || role === LEGACY_MESSAGE_ROLE.assistant;
}

function isToolOrSystemMessage(message: LegacyOpencodeDisplayMessage): boolean {
  if (message.msg_type === LEGACY_MESSAGE_TYPE.toolCall) return true;
  if (message.msg_type === LEGACY_MESSAGE_TYPE.systemEvent) return true;
  return Boolean(message.tool_calls?.length);
}

async function registerTranscriptAsset(
  input: LegacyPiSeedInput,
): Promise<RegisteredTranscriptAsset> {
  const transcript = buildTranscriptMarkdown(
    input.session,
    input.messages,
    input.options.maxTranscriptAssetChars,
  );
  const dataUrl = `data:text/markdown;base64,${Buffer.from(transcript.text, 'utf-8').toString('base64')}`;
  const asset = await input.assets.register({
    fileName: `legacy-transcript-${safeFileSegment(input.session.sessionId)}.md`,
    mimeType: 'text/markdown',
    sourceKind: 'legacy-migration',
    dataUrl,
    sessionId: input.session.sessionId,
    nowMs: input.nowMs,
  });
  return { ...asset, truncated: transcript.truncated };
}

function buildTranscriptMarkdown(
  session: LegacyOpencodeSessionRecord,
  messages: readonly LegacyOpencodeDisplayMessage[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const builder = new TranscriptBuilder(maxChars);
  for (const line of transcriptHeader(session)) {
    if (!builder.append(line)) break;
  }
  for (const [index, message] of messages.entries()) {
    if (builder.truncated) break;
    appendTranscriptMessage(builder, message, index);
  }
  return builder.result();
}

function transcriptHeader(session: LegacyOpencodeSessionRecord): Array<string | undefined> {
  return [
    `# Legacy transcript: ${session.title || session.sessionId}`,
    '',
    `sessionId: ${session.sessionId}`,
    session.legacyFrameworkSessionId
      ? `legacyFrameworkSessionId: ${session.legacyFrameworkSessionId}`
      : undefined,
    `agentName: ${session.agentName}`,
    '',
  ];
}

function appendTranscriptMessage(
  builder: TranscriptBuilder,
  message: LegacyOpencodeDisplayMessage,
  index: number,
): void {
  const title = `## ${index + 1}. ${String(message.role ?? 'unknown')}${message.msg_id ? ` (${message.msg_id})` : ''}`;
  const block = [title, '', formatTranscriptMessage(message, builder.remainingChars), ''];
  for (const line of block) {
    if (!builder.append(line)) return;
  }
}

class TranscriptBuilder {
  private readonly lines: string[] = [];
  private currentLength = 0;
  truncated = false;

  constructor(private readonly maxChars: number) {}

  get remainingChars(): number {
    return Math.max(0, this.maxChars - this.currentLength);
  }

  append(value: string | undefined): boolean {
    if (value === undefined) return true;
    const separatorLength = this.lines.length === 0 ? 0 : 1;
    const nextLength = separatorLength + value.length;
    if (this.currentLength + nextLength <= this.maxChars) {
      this.lines.push(value);
      this.currentLength += nextLength;
      return true;
    }
    const remaining = Math.max(0, this.maxChars - this.currentLength - separatorLength);
    if (remaining > 0) this.lines.push(value.slice(0, remaining));
    this.truncated = true;
    return false;
  }

  result(): { text: string; truncated: boolean } {
    if (this.truncated) {
      this.lines.push('');
      this.lines.push('[Legacy transcript truncated by migration safety limit.]');
    }
    return { text: `${this.lines.join('\n')}\n`, truncated: this.truncated };
  }
}

function formatSeedMessage(message: ConversationalSeedMessage, maxChars: number): string {
  const role = message.role === 'user' ? 'User' : 'Assistant';
  const prefix = message.msgId ? `${role} (${message.msgId})` : role;
  return `${prefix}: ${truncateForSeed(message.text, maxChars)}`;
}

function countToolOrSystemMessages(messages: readonly LegacyOpencodeDisplayMessage[]): number {
  return messages.filter(isToolOrSystemMessage).length;
}

function truncateForSeed(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

function formatTranscriptMessage(
  message: LegacyOpencodeDisplayMessage,
  maxChars = Number.POSITIVE_INFINITY,
): string {
  if (typeof message.msg_content === 'string' && message.msg_content.trim()) {
    return truncateTranscriptValue(message.msg_content.trim(), maxChars);
  }
  if (message.msg_type === LEGACY_MESSAGE_TYPE.toolCall || (message.tool_calls?.length ?? 0) > 0) {
    return truncateTranscriptValue(
      `[tool event preserved in display history]\n\n${safeJson(message)}`,
      maxChars,
    );
  }
  if (message.msg_type === LEGACY_MESSAGE_TYPE.systemEvent) {
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
