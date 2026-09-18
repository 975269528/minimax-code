export interface TimestampedCanonicalHistoryMessage extends Record<string, unknown> {
  readonly role: string;
  readonly timestamp: number;
}

export interface MinimalNativeCompactionSummary extends Record<string, unknown> {
  readonly role: 'compactionSummary';
  readonly summary: string;
  readonly timestamp?: never;
  readonly tokensBefore?: never;
}

export type CanonicalHistoryMessage =
  | TimestampedCanonicalHistoryMessage
  | MinimalNativeCompactionSummary;

export interface CanonicalTurnConfigTool extends Record<string, unknown> {
  readonly tool_name: string;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** The exact non-secret LLM input configuration anchored to one Turn's user message. */
export interface CanonicalTurnConfig extends Record<string, unknown> {
  readonly system_prompt: string;
  readonly model: Readonly<Record<string, unknown>>;
  readonly tools?: readonly CanonicalTurnConfigTool[];
}

export interface CanonicalHistoryWriteOptions {
  readonly turnId?: string;
  readonly turnConfig?: CanonicalTurnConfig;
  readonly idempotencyKey?: string;
  /** Legacy migration boundary requests a typed canonical compaction snapshot. */
  readonly snapshotId?: string;
}

/**
 * Neutral canonical-history capability. The Agent/runtime host owns concrete file access and
 * injects this port; session-system never imports AgentHost or a production history adapter.
 */
export interface CanonicalHistoryPort {
  getPiHistory(sessionId: string): Promise<CanonicalHistoryMessage[]>;
  appendPiHistory(
    sessionId: string,
    messages: readonly CanonicalHistoryMessage[],
    options?: CanonicalHistoryWriteOptions,
  ): Promise<void>;
  replacePiHistory(
    sessionId: string,
    messages: readonly CanonicalHistoryMessage[],
    options?: CanonicalHistoryWriteOptions,
  ): Promise<void>;
}

/** Reads the current canonical artifact without initializing or claiming legacy sources. */
export interface CurrentCanonicalHistoryReader {
  readCurrentHistory(sessionId: string, createdAtMs: number): Promise<CanonicalHistoryMessage[]>;
}

export interface PersistedHistoryMessage {
  readonly message_id: string;
  readonly turn_id: string;
  readonly message: CanonicalHistoryMessage;
  readonly turn_config?: CanonicalTurnConfig;
}

export function sanitizeCanonicalTurnModel(model: object): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(model).filter(([key]) => !isSensitiveModelKey(key)));
}

function isSensitiveModelKey(key: string): boolean {
  return [
    'apikey',
    'authorization',
    'token',
    'accesstoken',
    'secret',
    'password',
    'credential',
  ].includes(key.replaceAll(/[_-]/gu, '').toLowerCase());
}
