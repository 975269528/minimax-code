/**
 * System-reminder injected dependencies.
 *
 * The block assembly logic (registry / providers / blocks / service) lives in
 * this package and produces a `<system-reminder>` text block from a
 * `SystemReminderInput` payload. The host owns the IO-heavy data collection
 * (reading stores, scanning filesystem) and the cross-cutting runtime
 * collaborators (logger, request context, config, date formatting); it supplies
 * them through the small interfaces defined here.
 *
 *   - {@link DataCollector}: satisfied by the host's data collector. The
 *     service calls it once per `buildReminder` to gather the IO-heavy payload.
 *   - {@link NudgeRegistry}: satisfied by the host's nudge registry. The
 *     `boardNudgeProvider` reads + clears a pending nudge for the session.
 *   - {@link Logger} / {@link LogContext}: the host logging surface, injected
 *     so this package never imports a runtime logger.
 *   - {@link ReminderConfig}: the small config slice the service reads.
 *   - {@link DateFormatter}: host-local date formatting (timezone owned by host).
 *
 * No runtime fallback is exposed: dependencies are passed in directly via
 * constructor arguments or setters, so a missing wiring fails loudly at the
 * call site instead of silently no-opping. Hosts satisfy these shapes
 * structurally — no `implements` declaration required.
 */

import type { SessionInfo, MessageRequest, SystemReminderInput } from './types.js';

// ─── DataCollector ─────────────────────────────────────────────────────────

/**
 * Subset of the host data collector consumed by `SystemReminderService`.
 *
 * The full host collector is IO-heavy (sqlite stores, filesystem scans,
 * agent template lookups) and stays in the host. The service only calls two
 * methods — gather data for a turn, and release per-session bookkeeping on
 * session removal.
 */
export interface DataCollector {
  collect(
    session: SessionInfo,
    msg: MessageRequest,
    turnCount: number,
  ): Promise<SystemReminderInput>;
  onSessionRemoved(sessionId: string): void;
}

// ─── NudgeRegistry ───────────────────────────────────────────────────────────

/** Pending nudge metadata returned by {@link NudgeRegistry.get}. */
export interface NudgeInfo {
  /** Path to the board.md file the worker should update. */
  boardPath: string;
  /** Current consecutive nudge count (for logging / escalation context). */
  nudgeCount: number;
  /** Epoch-ms when the nudge was set. */
  createdAt: number;
}

/**
 * Subset of the host nudge registry consumed by `boardNudgeProvider`.
 *
 * The host registry satisfies this structurally — it carries additional
 * methods (`set`, `clearAll`, `size`) that we don't need on the read path.
 */
export interface NudgeRegistry {
  get(sessionId: string): NudgeInfo | undefined;
  clear(sessionId: string): void;
}

// ─── Logging ───────────────────────────────────────────────────────────────

/**
 * Per-call request context passed to the logger. Structurally compatible with
 * the host's `RequestContext` (carries at least a trace id); only `traceId` is
 * required by this package.
 */
export interface LogContext {
  traceId: string;
  callerAgent?: string;
  callerSession?: string;
  locale?: string;
}

/**
 * Logging surface consumed by `SystemReminderService`. The host injects an
 * implementation; only the levels this package uses are declared.
 */
export interface Logger {
  warn(ctx: LogContext, msg: string): void;
  info(ctx: LogContext, msg: string): void;
  error(ctx: LogContext, msg: string): void;
}

// ─── ReminderConfig ──────────────────────────────────────────────────────────

/**
 * Config slice read by `SystemReminderService`. The host owns the full config;
 * this is the only field the SR service reads (gates the model-preview path
 * that suppresses the per-message reminder for selected models).
 */
export interface ReminderConfig {
  disableModelPrefixes: readonly string[];
}

// ─── DateFormatter ─────────────────────────────────────────────────────────

/**
 * Host-local datetime formatter. The host owns the timezone; this package only
 * needs to render a timestamp into a human-readable local string.
 */
export type DateFormatter = (ts: number | Date) => string;

// ─── Diagnostic shapes ─────────────────────────────────────────────────────

/**
 * Per-provider diagnostic emitted alongside the assembled `<system-reminder>`
 * when diagnostics are explicitly requested via the `withDiagnostic` option.
 */
export interface ProviderDiagnostic {
  /** Provider name, e.g. "agentContextProvider". */
  name: string;
  /** Whether the provider produced output. */
  fired: boolean;
  /** The block content produced (only when fired=true). */
  output?: string | undefined;
  /** Execution time in milliseconds. */
  durationMs: number;
  /** Whether this is a critical provider (runs even when full SR is disabled). */
  critical: boolean;
}

/**
 * Aggregate diagnostic returned from `SystemReminderService.buildReminder`
 * when diagnostics are explicitly requested.
 */
export interface SystemReminderDiagnostic {
  fullText: string | null;
  criticalOnly: boolean;
  providers: ProviderDiagnostic[];
  collectDurationMs: number;
  totalDurationMs: number;
}

// ─── ModelSelector ───────────────────────────────────────────────────────────

/** Resolved model identifier returned by {@link ModelSelector.resolveForSend}. */
export interface ModelSelection {
  providerID: string;
  modelID: string;
}

/**
 * Subset of the host's model selection service consumed by
 * `SystemReminderService` for the SR-disable preview.
 *
 * The service calls `resolveForSend({ dryRun: true })` to learn which model
 * the bridge will commit to before actually dispatching, so it can decide
 * whether the per-message reminder block is suppressed for that model. The
 * host's model selection service satisfies the shape; cloud hosts can supply a
 * remote-resolution proxy.
 */
export interface ModelSelector {
  resolveForSend(input: {
    sessionId: string;
    agentName: string;
    requestModel?: { providerID: string; modelID: string; variant?: string };
    dryRun?: boolean;
  }): Promise<ModelSelection>;
}
