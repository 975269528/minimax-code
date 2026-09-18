import type {
  ProjectRecord,
  ProjectRepository,
  ProjectService,
  SessionRecord,
  SessionRepository,
} from '../session-system/index.js';
import type { AppDb } from '../../infra/db/client.js';

export type PinItemType = 'agent' | 'session' | 'project';

export interface PinRef {
  readonly type: PinItemType;
  readonly id: string;
}

interface PinAgentRecord {
  readonly agentName: string;
  readonly rootSessionId?: string;
  readonly displayName?: string;
  readonly defaultWorkspaceDir?: string;
}

export interface PinItem {
  readonly ref: PinRef;
  readonly agent?: PinAgentRecord;
  readonly session?: SessionRecord;
  readonly project?: ProjectRecord;
}

export type PinMutation = {
  readonly item?: PinItem;
  readonly items: readonly PinItem[];
};

export interface PinServiceOptions {
  readonly db: AppDb;
  readonly agents: Pick<{ get(agentName: string): Promise<PinAgentRecord | undefined> }, 'get'>;
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly projects: Pick<ProjectService, 'canonicalizeReferences' | 'resolve' | 'resolveOrder'>;
  readonly projectRepository: Pick<ProjectRepository, 'listPage' | 'setPinned' | 'putOrder'>;
  /** Reads the old preview_train preference before v2 takes ownership. */
  readonly legacyOrder?: () => Promise<readonly PinRef[]>;
  /** Reads Agent pins that only survived in the migrated Agent columns. */
  readonly legacyPinnedAgents?: () => Promise<
    readonly { readonly id: string; readonly pinnedAt: number | null }[]
  >;
  readonly nowMs?: () => number;
}

export type PinFailureReason =
  | 'invalid-ref'
  | 'duplicate-ref'
  | 'agent-not-found'
  | 'session-not-found';
