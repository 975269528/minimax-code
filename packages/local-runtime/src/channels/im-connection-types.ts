import type { ChannelPlatform } from './route-api.js';

export interface LocalImConnection {
  readonly connectionId: string;
  readonly agentName: string;
  /** Product-facing channel key. Keep this a string, never a numeric enum. */
  readonly channel: ChannelPlatform;
  /** Null means the user explicitly chose "no project". */
  readonly projectKey: string | null;
  /** Internal Session routing key. Never project this back to the API for null projectKey. */
  readonly resolvedProjectKey: string;
  /**
   * Exact legacy rows that created this Connection before their physical
   * Binding committed. It is deliberately internal: a normal Connection
   * prepare clears it, while a retry may resume only these same rows.
   */
  readonly pendingLegacyRouteKeys?: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LocalImPhysicalBinding {
  readonly bindingId: string;
  readonly connectionId: string;
  readonly channel: ChannelPlatform;
  /** Runtime transport identity, e.g. telegram:agent or bare Feishu agent. */
  readonly clientName: string;
  /**
   * Historical evidence for a pre-Binding-only cursor. New Bindings never
   * create this identifier and online routing must not dereference it.
   */
  readonly imConversationId?: string;
  /** Absent only until startup transfers an existing legacy Conversation. */
  readonly currentSessionId?: string;
  /** Absent only until startup transfers an existing legacy Conversation. */
  readonly resolvedProjectKey?: string;
  /** Bounded durable receipts make /new and /clear replay-safe across restarts. */
  readonly mutationReceipts?: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Read-only audit receipt for one-version legacy route migration. */
  readonly migratedLegacyRouteKeys?: readonly string[];
}

export interface LocalImConversation {
  readonly imConversationId: string;
  readonly agentName: string;
  readonly projectKey: string;
  /** Empty only for a legacy migration Conversation shared by its old Bindings. */
  readonly connectionId: string;
  /** Empty until a credential-only legacy binding receives its first inbound event. */
  readonly currentSessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Bounded durable receipts make /new and /clear replay-safe across restarts. */
  readonly mutationReceipts: Readonly<Record<string, string>>;
}

/** Fully migrated Binding state required by every online IM route. */
export interface LocalImBindingSessionState {
  readonly currentSessionId: string;
  readonly resolvedProjectKey: string;
  readonly mutationReceipts: Readonly<Record<string, string>>;
}

export type LocalImConnectionState = 'configured' | 'authorizing' | 'bound' | 'error';

export interface LocalImConnectionView {
  readonly connection: LocalImConnection;
  readonly state: LocalImConnectionState;
  readonly binding?: LocalImPhysicalBinding;
  readonly errorCode?: string;
}

/** Stable facts observed while one Connection deletion owns its mutation lane. */
export interface LocalImConnectionDeletionSnapshot {
  readonly connection: LocalImConnection;
  readonly binding?: LocalImPhysicalBinding;
  readonly authorization?: LocalImAuthorizationState;
}

export class LocalImConnectionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalImConnectionError';
  }
}

export interface LocalImAuthorizationState {
  readonly channel: ChannelPlatform;
  readonly platformSessionId?: string;
  readonly expiresAt?: number;
  readonly errorCode?: string;
}

export interface LocalImConnectionStoreOptions {
  readonly dataDir: () => string;
  readonly nowMs: () => number;
  readonly resolveProjectWorkspace: (projectKey: string) => {
    workspaceDir: string;
    isDefaultWorkspace: boolean;
  };
  readonly createSession: (input: {
    agentName?: string;
    workspaceDir: string;
    sessionType?: 'branch';
    sessionKind?: 'channel';
    title?: string | null;
    parentSessionId?: string | null;
    visibility?: 'visible';
    purpose?: string;
    isDefaultWorkspace?: boolean;
  }) => Promise<{ sessionId: string }>;
  /**
   * Host-owned check for a Desktop `/new` target. The store keeps the
   * physical Binding durable but must never attach it to an arbitrary,
   * archived, or cross-Agent Session.
   */
  readonly validateTargetSession?: (input: {
    sessionId: string;
    agentName: string;
    projectKey: string;
  }) => Promise<void>;
  /**
   * V2-only repair for a legacy Root that was already verified and adopted as
   * an IM Conversation cursor. The host keeps this narrow so the store cannot
   * change any other Session metadata.
   */
  readonly revealMigratedSession?: (sessionId: string) => Promise<void>;
  /** @internal Narrow regression seam; absent from every production composition. */
  readonly onDeleteBindingSnapshot?: (input: {
    connectionId: string;
    bindingId?: string;
  }) => void | Promise<void>;
}
