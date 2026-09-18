export interface PermissionRequestRecord {
  requestId: string;
  sessionId: string;
  agentName?: string;
  msgId?: string;
  toolName: string;
  ruleContents: string[];
  /** Human-readable tool input (e.g. actual command or file path) for user display. */
  toolInput?: string;
  /** Short description of the tool action provided by the AI model (e.g. "Lists files in current directory"). */
  toolDescription?: string;
  /** Reason shown to the user for why confirmation is required. */
  reason?: string;
  /**
   * Rewritten tool input produced by the permission layer (e.g. `rm` →
   * `mavis-trash`). Persisted so that the ASK card flow does not lose
   * the rewrite — the framework adapter checks `rewrittenInput` BEFORE
   * `behavior` and instructs the agent to re-run with the rewritten
   * command regardless of allow/ask/deny.
   */
  rewrittenInput?: Record<string, unknown>;
  createdAt?: number;
}

/**
 * Permission-request store contract for pending permission requests keyed by requestId.
 * All methods are async to allow non-blocking implementations.
 * Concrete implementations live in `store/impl/`.
 */
export interface PermissionRequestStore {
  /** Insert or update a permission request. Unique key: `requestId`. */
  upsert(record: PermissionRequestRecord): Promise<void>;

  get(requestId: string): Promise<PermissionRequestRecord | null>;

  delete(requestId: string): Promise<boolean>;

  getAll(): Promise<PermissionRequestRecord[]>;

  deleteBySession(sessionId: string): Promise<number>;

  findPendingByFingerprint(
    sessionId: string,
    toolName: string,
    ruleContents: string[],
    agentName?: string,
  ): Promise<PermissionRequestRecord | null>;
}
