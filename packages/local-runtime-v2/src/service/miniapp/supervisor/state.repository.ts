import { asc, eq } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { miniAppStates } from '../../../infra/db/schema/miniapp.js';
import type { MiniAppPersistedState, MiniAppStateStore } from '../contracts.js';

type StateErrorCode = 'STATE_CORRUPT' | 'STATE_INVALID';

class MiniAppStateStoreError extends Error {
  override readonly name = 'MiniAppStateStoreError';

  constructor(
    readonly code: StateErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** Strict Supervisor persistence for accepted package identity and restart hints only. */
export class DrizzleMiniAppStateStore implements MiniAppStateStore {
  constructor(private readonly db: AppDb) {}

  read(pluginId: string): MiniAppPersistedState | undefined {
    const row = this.db
      .select()
      .from(miniAppStates)
      .where(eq(miniAppStates.pluginId, assertPluginId(pluginId)))
      .get();
    return row === undefined ? undefined : decodeRow(row);
  }

  list(): readonly MiniAppPersistedState[] {
    return this.db
      .select()
      .from(miniAppStates)
      .orderBy(asc(miniAppStates.pluginId))
      .all()
      .map(decodeRow);
  }

  write(state: MiniAppPersistedState): void {
    assertState(state, 'STATE_INVALID');
    const values = {
      pluginId: state.pluginId,
      acceptedSourceDigest: state.acceptedSourceDigest,
      clientDigest: state.clientDigest,
      nodeDigest: state.nodeDigest,
      preferredPort: state.preferredPort ?? null,
      lastErrorJson: state.lastErrorJson ?? null,
      updatedAtMs: state.updatedAtMs,
    };
    this.db
      .insert(miniAppStates)
      .values(values)
      .onConflictDoUpdate({ target: miniAppStates.pluginId, set: values })
      .run();
  }

  remove(pluginId: string): void {
    this.db
      .delete(miniAppStates)
      .where(eq(miniAppStates.pluginId, assertPluginId(pluginId)))
      .run();
  }
}

function decodeRow(row: typeof miniAppStates.$inferSelect): MiniAppPersistedState {
  const state: MiniAppPersistedState = {
    pluginId: row.pluginId,
    acceptedSourceDigest: row.acceptedSourceDigest,
    clientDigest: row.clientDigest,
    nodeDigest: row.nodeDigest,
    ...(row.preferredPort !== null ? { preferredPort: row.preferredPort } : {}),
    ...(row.lastErrorJson !== null ? { lastErrorJson: row.lastErrorJson } : {}),
    updatedAtMs: row.updatedAtMs,
  };
  assertState(state, 'STATE_CORRUPT');
  return state;
}

function assertState(state: MiniAppPersistedState, code: StateErrorCode): void {
  assertIdentity(state, code);
  assertPort(state, code);
  assertTimestamps(state, code);
  if (state.lastErrorJson !== undefined && !validJson(state.lastErrorJson)) {
    fail(code, 'lastErrorJson must be valid JSON');
  }
}

function assertIdentity(state: MiniAppPersistedState, code: StateErrorCode): void {
  if (!nonEmpty(state.pluginId)) fail(code, 'pluginId must be non-empty');
  if (!nonEmpty(state.acceptedSourceDigest)) fail(code, 'acceptedSourceDigest must be non-empty');
  if (!nonEmpty(state.clientDigest)) fail(code, 'clientDigest must be non-empty');
  if (!nonEmpty(state.nodeDigest)) fail(code, 'nodeDigest must be non-empty');
}

function assertPort(state: MiniAppPersistedState, code: StateErrorCode): void {
  if (state.preferredPort === undefined) return;
  if (
    !Number.isSafeInteger(state.preferredPort) ||
    state.preferredPort < 1024 ||
    state.preferredPort > 65_535
  ) {
    fail(code, 'preferredPort is outside the Host port range');
  }
}

function assertTimestamps(state: MiniAppPersistedState, code: StateErrorCode): void {
  timestamp(state.updatedAtMs, 'updatedAtMs', code);
}

function assertPluginId(pluginId: string): string {
  if (!nonEmpty(pluginId)) fail('STATE_INVALID', 'pluginId must be non-empty');
  return pluginId;
}

function timestamp(value: number, name: string, code: StateErrorCode): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${name} must be non-negative`);
}

function validJson(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(code: StateErrorCode, detail: string): never {
  throw new MiniAppStateStoreError(code, detail);
}
