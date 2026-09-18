/**
 * Diagnostic event sink for local-runtime — privacy-tagged JSONL,
 * redaction metadata, diagnostic-bundle friendly. This is NOT an engineering
 * logger; engineering logging lives in `../common/logger.ts`.
 *
 * Per `.harness/docs/local-runtime-observability.md` §8 (MR3-B rename).
 *
 * The public interface is named `ObservabilityLogger` for legacy reasons; it is
 * in fact a diagnostic event sink, not an engineering logger.
 */
import type {
  ObservabilityContext,
  ObservabilityError,
  ObservabilityEvent,
  ObservabilityLogger,
  ObservabilityLoggerOptions,
  ObservabilityPrivacy,
  ObservabilitySink,
} from './types.js';
import { DEFAULT_OBSERVABILITY_REDACTION_POLICY, sanitizeObservabilityText } from './redaction.js';

const DEFAULT_PRIVACY: ObservabilityPrivacy = {
  redaction: 'masked',
  uploadDefault: 'consent-required',
};

export const NOOP_OBSERVABILITY_LOGGER: ObservabilityLogger = {
  child: () => NOOP_OBSERVABILITY_LOGGER,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  flush: async () => undefined,
};

export function serializeObservabilityError(error: unknown): ObservabilityError {
  if (error instanceof Error) {
    const maybeCode = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: sanitizeObservabilityText(error.message),
      ...(error.stack ? { stack: sanitizeObservabilityText(error.stack) } : {}),
      ...(typeof maybeCode === 'string' ? { code: maybeCode } : {}),
    };
  }
  return { message: sanitizeObservabilityText(String(error)) };
}

class DefaultObservabilityEventSink implements ObservabilityLogger {
  private readonly component: string;
  private readonly context: ObservabilityContext;
  private readonly sinks: ObservabilitySink[];
  private readonly nowMs: () => number;
  private readonly privacy: ObservabilityPrivacy;
  private readonly redaction = DEFAULT_OBSERVABILITY_REDACTION_POLICY;

  constructor(options: ObservabilityLoggerOptions) {
    this.component = options.component;
    this.context = options.context ?? {};
    this.sinks = options.sinks ?? [];
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.privacy = options.privacy ?? DEFAULT_PRIVACY;
    if (options.redaction) {
      this.redaction = options.redaction;
    }
  }

  child(context: Partial<ObservabilityContext> & { component?: string }): ObservabilityLogger {
    const { component, ...childContext } = context;
    return new DefaultObservabilityEventSink({
      component: component ?? this.component,
      context: { ...this.context, ...childContext },
      sinks: this.sinks,
      nowMs: this.nowMs,
      redaction: this.redaction,
      privacy: this.privacy,
    });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown> | Error): void {
    if (fields instanceof Error) {
      this.emit('error', message, undefined, fields);
      return;
    }
    this.emit('error', message, fields);
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.sinks.map((sink) => sink.flush?.()));
  }

  private emit(
    level: ObservabilityEvent['level'],
    message: string,
    fields?: Record<string, unknown>,
    error?: unknown,
  ): void {
    const sanitizedFields = fields ? this.redaction.sanitizeFields(fields) : undefined;
    const event: ObservabilityEvent = {
      schemaVersion: 1,
      tsMs: this.nowMs(),
      level,
      component: this.component,
      message: sanitizeObservabilityText(message),
      ...(Object.keys(this.context).length > 0 ? { context: this.context } : {}),
      ...(sanitizedFields && Object.keys(sanitizedFields).length > 0
        ? { fields: sanitizedFields }
        : {}),
      ...(error ? { error: serializeObservabilityError(error) } : {}),
      privacy: this.privacy,
    };
    for (const sink of this.sinks) {
      try {
        void sink.emit(event);
      } catch {
        // Observability must never break product behavior.
      }
    }
  }
}

export function createObservabilityEventSink(
  options: ObservabilityLoggerOptions,
): ObservabilityLogger {
  if (!options.sinks || options.sinks.length === 0) return NOOP_OBSERVABILITY_LOGGER;
  return new DefaultObservabilityEventSink(options);
}
