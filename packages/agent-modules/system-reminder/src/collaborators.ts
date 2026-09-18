/**
 * System-reminder collaborator registry.
 *
 * The system-reminder subsystem consumes its cross-cutting runtime
 * collaborators (logger, request context, config, date formatting) through
 * constructor injection on `SystemReminderService`. The SR-specific
 * collaborator `NudgeRegistry` flows through constructor injection on
 * `createBoardNudgeProvider`.
 *
 * This module exposes `configureSystemReminderHost` as a thin marker /
 * future-extension point so the host declares subsystem wiring symmetrically
 * with the other agent-module subsystems. Currently the only side effect is to
 * record the host-side defaults so tests that construct an SR service ad-hoc
 * can reuse them. Constructor / setter injection on the service stays the
 * primary path — these module-scope defaults are a convenience only.
 */

import type { NudgeRegistry } from './dependencies.js';

let _defaultNudgeRegistry: NudgeRegistry | null = null;

/** Optional defaults for SR collaborators. Tests can read these via the getters. */
export interface SystemReminderHostUtils {
  /**
   * Host-side `NudgeRegistry` (or any compatible stub). Recorded so that
   * downstream helpers and tests can grab the same instance without having to
   * thread it through every call site. Constructor injection on
   * `createBoardNudgeProvider(registry)` remains the canonical wiring.
   */
  nudgeRegistry?: NudgeRegistry;
}

/**
 * Register optional system-reminder defaults. Idempotent — later calls
 * overwrite the recorded references; missing fields preserve previous
 * registrations.
 */
export function configureSystemReminderHost(opts: SystemReminderHostUtils): void {
  if (opts.nudgeRegistry !== undefined) _defaultNudgeRegistry = opts.nudgeRegistry;
}

/** Returns the registered default `NudgeRegistry`, or null if none. */
export function getDefaultNudgeRegistry(): NudgeRegistry | null {
  return _defaultNudgeRegistry;
}

/** Test helper — clear all registered defaults. */
export function _resetSystemReminderHostForTests(): void {
  _defaultNudgeRegistry = null;
}
