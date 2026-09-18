import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';

import type { LocalSessionRecord } from '../controller.js';
import type { LocalSessionLedgerEvent, LocalSessionLedgerWatermark } from '../ledger/index.js';

export interface ReplayedLocalSessionProjection {
  sessionId: string;
  record?: LocalSessionRecord;
  displayMessages: AgentMessage[];
  piHistory: PiAgentMessage[];
  fileApiUploads?: Record<string, LocalFileApiUploadProjectionEntry>;
  deleted: boolean;
  watermark?: LocalSessionLedgerWatermark;
}

export interface LocalSessionProjectionReplayBase {
  record?: LocalSessionRecord;
  displayMessages?: AgentMessage[];
  piHistory?: PiAgentMessage[];
  fileApiUploads?: Record<string, LocalFileApiUploadProjectionEntry>;
  deleted?: boolean;
  watermark?: LocalSessionLedgerWatermark;
}

export interface LocalFileApiUploadProjectionEntry {
  contentHash: string;
  endpointHash: string;
  callerIdentityHash: string;
  ttlSec: number;
  fileId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export function replayLocalSessionLedger(
  sessionId: string,
  events: Iterable<LocalSessionLedgerEvent>,
  base: LocalSessionProjectionReplayBase = {},
): ReplayedLocalSessionProjection {
  const projection: ReplayedLocalSessionProjection = {
    sessionId,
    ...(base.record ? { record: base.record } : {}),
    displayMessages: [...(base.displayMessages ?? [])],
    piHistory: [...(base.piHistory ?? [])],
    ...(base.fileApiUploads ? { fileApiUploads: { ...base.fileApiUploads } } : {}),
    deleted: base.deleted ?? false,
    ...(base.watermark ? { watermark: base.watermark } : {}),
  };
  const displayMessageIndexes = new Map<string, number>();
  projection.displayMessages.forEach((message, index) => {
    displayMessageIndexes.set(readDisplayMessageKey(message), index);
  });

  for (const event of [...events].sort(compareLedgerEvents)) {
    if (event.sessionId !== sessionId) continue;
    projection.watermark = {
      sessionId,
      lastSeq: event.seq,
      lastEventId: event.eventId,
      updatedAtMs: event.createdAtMs,
    };

    switch (event.kind) {
      case 'session.created':
      case 'session.metadata_updated':
        projection.record = event.record;
        projection.deleted = false;
        break;
      case 'session.deleted':
        projection.record = undefined;
        projection.deleted = true;
        projection.displayMessages = [];
        projection.piHistory = [];
        projection.fileApiUploads = {};
        displayMessageIndexes.clear();
        break;
      case 'message.display_upserted':
        upsertDisplayMessage(projection.displayMessages, displayMessageIndexes, event.message);
        break;
      case 'message.pi_history_appended':
        projection.piHistory.push(...event.messages);
        break;
      case 'message.pi_history_replaced':
        projection.piHistory = [...event.messages];
        break;
      case 'message.state_deleted':
        projection.displayMessages = [];
        projection.piHistory = [];
        projection.fileApiUploads = {};
        displayMessageIndexes.clear();
        break;
      case 'message.turn_retracted': {
        const removed = new Set(event.removedDisplayMsgIds);
        if (removed.size > 0) {
          projection.displayMessages = projection.displayMessages.filter((message) => {
            const msgId = readDisplayMsgId(message);
            return !(msgId !== undefined && removed.has(msgId));
          });
          displayMessageIndexes.clear();
          projection.displayMessages.forEach((message, index) => {
            displayMessageIndexes.set(readDisplayMessageKey(message), index);
          });
        }
        projection.piHistory = [...event.messages];
        break;
      }
      case 'media.file_api_uploaded':
        (projection.fileApiUploads ??= {})[
          `${event.contentHash}:${event.endpointHash}:${event.callerIdentityHash}:${event.ttlSec}`
        ] = {
          contentHash: event.contentHash,
          endpointHash: event.endpointHash,
          callerIdentityHash: event.callerIdentityHash,
          ttlSec: event.ttlSec,
          fileId: event.fileId,
          createdAtMs: event.createdAtMs,
          expiresAtMs: event.expiresAtMs,
        };
        break;
      case 'session.snapshot_created':
        break;
    }
  }

  return projection;
}

function compareLedgerEvents(
  left: LocalSessionLedgerEvent,
  right: LocalSessionLedgerEvent,
): number {
  return left.seq - right.seq || left.eventId.localeCompare(right.eventId);
}

function upsertDisplayMessage(
  messages: AgentMessage[],
  indexes: Map<string, number>,
  message: AgentMessage,
): void {
  const key = readDisplayMessageKey(message);
  const index = indexes.get(key);
  if (index === undefined) {
    indexes.set(key, messages.length);
    messages.push(message);
    return;
  }
  messages[index] = message;
}

function readDisplayMessageKey(message: AgentMessage): string {
  const msgId = (message as { msg_id?: unknown }).msg_id;
  if (typeof msgId === 'string' && msgId) return `msg_id:${msgId}`;
  return `json:${JSON.stringify(message)}`;
}

function readDisplayMsgId(message: AgentMessage): string | undefined {
  const msgId = (message as { msg_id?: unknown }).msg_id;
  return typeof msgId === 'string' && msgId ? msgId : undefined;
}
