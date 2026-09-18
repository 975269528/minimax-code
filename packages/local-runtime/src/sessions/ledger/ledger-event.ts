import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';

import type { LocalSessionRecord } from '../controller.js';

export const LOCAL_SESSION_LEDGER_SCHEMA_VERSION = 1;

export type LocalSessionLedgerEventKind =
  | 'session.created'
  | 'session.metadata_updated'
  | 'session.deleted'
  | 'message.display_upserted'
  | 'message.pi_history_appended'
  | 'message.pi_history_replaced'
  | 'message.state_deleted'
  | 'message.turn_retracted'
  | 'media.file_api_uploaded'
  | 'session.snapshot_created';

export interface BaseLocalSessionLedgerEvent {
  schemaVersion: typeof LOCAL_SESSION_LEDGER_SCHEMA_VERSION;
  eventId: string;
  sessionId: string;
  seq: number;
  createdAtMs: number;
  turnId?: string;
  kind: LocalSessionLedgerEventKind;
}

export interface LocalSessionCreatedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'session.created';
  record: LocalSessionRecord;
}

export interface LocalSessionMetadataUpdatedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'session.metadata_updated';
  record: LocalSessionRecord;
}

export interface LocalSessionDeletedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'session.deleted';
}

export interface LocalDisplayMessageUpsertedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'message.display_upserted';
  message: AgentMessage;
}

export interface LocalPiHistoryAppendedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'message.pi_history_appended';
  messages: PiAgentMessage[];
}

export interface LocalPiHistoryReplacedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'message.pi_history_replaced';
  messages: PiAgentMessage[];
}

export interface LocalMessageStateDeletedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'message.state_deleted';
}

/**
 * Retract an entire turn after output review exhausted its regenerations. The
 * leaked draft pi history is discarded and replaced with the pre-turn snapshot
 * (`messages`), and the listed display rows — notably the user-query bubble,
 * which is the only display row persisted for a fully retracted turn — are
 * removed. Keyed on `turnId` for traceability; the concrete display ids are
 * carried explicitly because display rows are not stamped with a turn id.
 */
export interface LocalTurnRetractedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'message.turn_retracted';
  removedDisplayMsgIds: string[];
  messages: PiAgentMessage[];
}

export interface LocalFileApiUploadedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'media.file_api_uploaded';
  contentHash: string;
  endpointHash: string;
  callerIdentityHash: string;
  ttlSec: number;
  fileId: string;
  expiresAtMs: number;
}

export interface LocalSessionSnapshotCreatedLedgerEvent extends BaseLocalSessionLedgerEvent {
  kind: 'session.snapshot_created';
  snapshotId: string;
  snapshotWatermark: LocalSessionLedgerWatermark;
}

export type LocalSessionLedgerEvent =
  | LocalSessionCreatedLedgerEvent
  | LocalSessionMetadataUpdatedLedgerEvent
  | LocalSessionDeletedLedgerEvent
  | LocalDisplayMessageUpsertedLedgerEvent
  | LocalPiHistoryAppendedLedgerEvent
  | LocalPiHistoryReplacedLedgerEvent
  | LocalMessageStateDeletedLedgerEvent
  | LocalTurnRetractedLedgerEvent
  | LocalFileApiUploadedLedgerEvent
  | LocalSessionSnapshotCreatedLedgerEvent;

export type LocalSessionLedgerEventDraft =
  | {
      kind: 'session.created';
      sessionId: string;
      turnId?: string;
      record: LocalSessionRecord;
    }
  | {
      kind: 'session.metadata_updated';
      sessionId: string;
      turnId?: string;
      record: LocalSessionRecord;
    }
  | {
      kind: 'session.deleted';
      sessionId: string;
      turnId?: string;
    }
  | {
      kind: 'message.display_upserted';
      sessionId: string;
      turnId?: string;
      message: AgentMessage;
    }
  | {
      kind: 'message.pi_history_appended';
      sessionId: string;
      turnId?: string;
      messages: PiAgentMessage[];
    }
  | {
      kind: 'message.pi_history_replaced';
      sessionId: string;
      turnId?: string;
      messages: PiAgentMessage[];
    }
  | {
      kind: 'message.state_deleted';
      sessionId: string;
      turnId?: string;
    }
  | {
      kind: 'message.turn_retracted';
      sessionId: string;
      turnId?: string;
      removedDisplayMsgIds: string[];
      messages: PiAgentMessage[];
    }
  | {
      kind: 'media.file_api_uploaded';
      sessionId: string;
      turnId?: string;
      contentHash: string;
      endpointHash: string;
      callerIdentityHash: string;
      ttlSec: number;
      fileId: string;
      expiresAtMs: number;
    }
  | {
      kind: 'session.snapshot_created';
      sessionId: string;
      turnId?: string;
      snapshotId: string;
      snapshotWatermark: LocalSessionLedgerWatermark;
    };

export interface LocalSessionLedgerWatermark {
  sessionId: string;
  lastSeq: number;
  lastEventId: string;
  updatedAtMs: number;
  byteOffset?: number;
}

export interface AppendLocalSessionLedgerResult {
  events: LocalSessionLedgerEvent[];
  watermark: LocalSessionLedgerWatermark;
}

export function isLocalSessionLedgerEvent(value: unknown): value is LocalSessionLedgerEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<LocalSessionLedgerEvent>;
  return (
    event.schemaVersion === LOCAL_SESSION_LEDGER_SCHEMA_VERSION &&
    typeof event.eventId === 'string' &&
    typeof event.sessionId === 'string' &&
    Number.isInteger(event.seq) &&
    typeof event.createdAtMs === 'number' &&
    typeof event.kind === 'string'
  );
}
