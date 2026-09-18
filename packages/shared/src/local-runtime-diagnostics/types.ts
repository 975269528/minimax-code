export type ObservabilityLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type ObservabilityPrivacyClass = 'safe' | 'masked' | 'sensitive';

export type ObservabilityUploadDefault = 'include' | 'exclude' | 'consent-required';

export interface ObservabilityContext {
  runtimeOwnerKind?: 'electron' | 'cli' | 'tui' | string;
  runtimeOwnerId?: string;
  runtimeMode?: string;
  dataDir?: string;
  profile?: string;
  surface?: 'electron' | 'cli-standalone' | 'cli-parent-runtime' | string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  turnId?: string;
  agentName?: string;
  workspaceDir?: string;
}

export interface ObservabilityError {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface ObservabilityPrivacy {
  redaction: ObservabilityPrivacyClass;
  uploadDefault: ObservabilityUploadDefault;
}

export interface ObservabilityEvent {
  schemaVersion: 1;
  tsMs: number;
  level: ObservabilityLevel;
  component: string;
  operation?: string;
  message: string;
  context?: ObservabilityContext;
  fields?: Record<string, unknown>;
  error?: ObservabilityError;
  privacy?: ObservabilityPrivacy;
}

export interface ObservabilitySink {
  emit(event: ObservabilityEvent): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export interface ObservabilityLogger {
  child(context: Partial<ObservabilityContext> & { component?: string }): ObservabilityLogger;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown> | Error): void;
  flush(): Promise<void>;
}

export interface ObservabilityRedactionPolicy {
  readonly policyVersion: number;
  sanitizeValue(key: string, value: unknown): unknown;
  sanitizeFields(fields: Record<string, unknown>): Record<string, unknown>;
}

export interface ObservabilityLoggerOptions {
  component: string;
  context?: ObservabilityContext;
  sinks?: ObservabilitySink[];
  nowMs?: () => number;
  redaction?: ObservabilityRedactionPolicy;
  privacy?: ObservabilityPrivacy;
}
