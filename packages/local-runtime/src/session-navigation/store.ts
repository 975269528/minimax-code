import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';

import { withLocalRuntimeDb, type DataDirInput, type DatabaseLike } from '../persistence/db.js';
import { isNavigableUserInput, projectNavigationText, takeUnicodeCodePoints } from './text.js';

const CONTENT_HEAD_CODE_POINTS = 200;

interface MessageRow {
  id: number;
  msg_id: string;
  role: string | null;
  created_at_ms: number;
  data_json: string;
}

interface AssetRow {
  message_row_id: number;
  msg_id: string;
  message_created_at_ms: number;
  asset_index: number;
  asset_key: string;
  source_tag: string;
  path: string;
  name: string | null;
  asset_type: string | null;
  artifact_id: string | null;
  drive_node_id: string | null;
}

interface TurnDiffRow {
  message_row_id: number;
  file_changes_json: string;
}

export interface SessionInputSummaryArtifact {
  messageRowId: number;
  msgId: string;
  messageCreatedAtMs: number;
  assetIndex: number;
  assetKey: string;
  sourceTag: string;
  path: string;
  name?: string;
  assetType?: string;
  artifactId?: string;
  driveNodeId?: string;
}

export interface SessionInputMessageHead {
  messageRowId: number;
  msgId: string;
  timestamp: number;
  contentHead?: string;
}

export interface SessionInputSummaryRecord {
  userInput: SessionInputMessageHead;
  assistantResponse?: SessionInputMessageHead;
  artifacts: SessionInputSummaryArtifact[];
  fileChangeCount: number;
}

export interface SessionInputSummaryPage {
  summaries: SessionInputSummaryRecord[];
  total: number;
  hasMore: boolean;
  nextBeforeRowId?: number;
  scannedRows: number;
  dataJsonBytes: number;
}

export interface SessionInputSummaryListOptions {
  limit: number;
  beforeRowId?: number;
}

export interface SessionInputSummaryReader {
  list(
    sessionId: string,
    options: SessionInputSummaryListOptions,
  ): Promise<SessionInputSummaryPage | undefined>;
}

interface MutableSummary {
  userInput: SessionInputMessageHead;
  assistantResponse?: SessionInputMessageHead;
  artifactsByKey: Map<string, SessionInputSummaryArtifact>;
  fileChangePaths: Set<string>;
}

export class SqliteSessionInputSummaryStore implements SessionInputSummaryReader {
  constructor(private readonly dataDir: DataDirInput) {}

  async list(
    sessionId: string,
    options: SessionInputSummaryListOptions,
  ): Promise<SessionInputSummaryPage | undefined> {
    return this.withDb((db) =>
      runReadTransaction(db, () => readSessionInputSummaryPage(db, sessionId, options)),
    );
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T {
    return withLocalRuntimeDb(this.dataDir, fn);
  }
}

function readSessionInputSummaryPage(
  db: DatabaseLike,
  sessionId: string,
  options: SessionInputSummaryListOptions,
): SessionInputSummaryPage | undefined {
  if (!sessionExists(db, sessionId)) return undefined;

  const rows = db
    .prepare(
      `
      SELECT id, msg_id, role, created_at_ms, data_json
      FROM local_runtime_message_rows
      WHERE session_id = ?
      ORDER BY id ASC
    `,
    )
    .all(sessionId) as MessageRow[];
  const assets = db
    .prepare(
      `
      SELECT messages.id AS message_row_id,
             assets.msg_id,
             assets.message_created_at_ms,
             assets.asset_index,
             assets.asset_key,
             assets.source_tag,
             assets.path,
             assets.name,
             assets.asset_type,
             assets.artifact_id,
             assets.drive_node_id
      FROM local_runtime_session_assets AS assets
      JOIN local_runtime_message_rows AS messages
        ON messages.session_id = assets.session_id
       AND messages.msg_id = assets.msg_id
      WHERE assets.session_id = ?
      ORDER BY messages.id ASC, assets.asset_index ASC, assets.id ASC
    `,
    )
    .all(sessionId) as AssetRow[];
  const turnDiffs = db
    .prepare(
      `
      SELECT messages.id AS message_row_id,
             diffs.file_changes_json
      FROM local_runtime_turn_diffs AS diffs
      JOIN local_runtime_message_rows AS messages
        ON messages.session_id = diffs.session_id
       AND messages.msg_id = diffs.assistant_message_id
      WHERE diffs.session_id = ?
      ORDER BY messages.id ASC, diffs.captured_at_ms ASC, diffs.change_set_id ASC
    `,
    )
    .all(sessionId) as TurnDiffRow[];

  const summaries = buildSummaries(rows, assets, turnDiffs);
  const page = paginateSummaries(summaries, options);
  return {
    ...page,
    total: summaries.length,
    scannedRows: rows.length,
    dataJsonBytes: rows.reduce((total, row) => total + Buffer.byteLength(row.data_json), 0),
  };
}

function sessionExists(db: DatabaseLike, sessionId: string): boolean {
  const session = db
    .prepare('SELECT 1 AS found FROM local_runtime_sessions WHERE session_id = ?')
    .get(sessionId) as { found?: number } | undefined;
  return session?.found === 1;
}

function buildSummaries(
  rows: MessageRow[],
  assets: AssetRow[],
  turnDiffs: TurnDiffRow[],
): SessionInputSummaryRecord[] {
  const assetsByRowId = groupAssetsByMessageRow(assets);
  const fileChangesByRowId = groupFileChangesByMessageRow(turnDiffs);
  const summaries: SessionInputSummaryRecord[] = [];
  let current: MutableSummary | undefined;

  for (const row of rows) {
    const message = parseMessage(row);
    if (!message) continue;
    if (isNavigableUserInput(message)) {
      if (current) summaries.push(finishSummary(current));
      current = {
        userInput: messageHead(row, message),
        artifactsByKey: new Map(),
        fileChangePaths: new Set(),
      };
    }
    if (!current) continue;

    if (message.role === 'assistant') {
      const head = messageHead(row, message);
      if (head.contentHead) current.assistantResponse = head;
    }
    for (const asset of assetsByRowId.get(row.id) ?? []) {
      current.artifactsByKey.set(asset.assetKey, asset);
    }
    for (const file of fileChangesByRowId.get(row.id) ?? []) {
      current.fileChangePaths.add(file);
    }
  }

  if (current) summaries.push(finishSummary(current));
  return summaries;
}

function groupAssetsByMessageRow(rows: AssetRow[]): Map<number, SessionInputSummaryArtifact[]> {
  const grouped = new Map<number, SessionInputSummaryArtifact[]>();
  for (const row of rows) {
    const artifact = toArtifact(row);
    const existing = grouped.get(row.message_row_id);
    if (existing) existing.push(artifact);
    else grouped.set(row.message_row_id, [artifact]);
  }
  return grouped;
}

function groupFileChangesByMessageRow(rows: TurnDiffRow[]): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const row of rows) {
    const files = parseChangedFiles(row.file_changes_json);
    if (files.length === 0) continue;
    const existing = grouped.get(row.message_row_id);
    if (existing) existing.push(...files);
    else grouped.set(row.message_row_id, files);
  }
  return grouped;
}

function parseChangedFiles(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (item === null || typeof item !== 'object' || !('file' in item)) return [];
      const file = item.file;
      if (typeof file !== 'string' || file.trim().length === 0) return [];
      return [file.trim()];
    });
  } catch {
    return [];
  }
}

function parseMessage(row: MessageRow): AgentMessage | undefined {
  try {
    const parsed = JSON.parse(row.data_json) as AgentMessage;
    return {
      ...parsed,
      msg_id: row.msg_id,
      ...(row.role ? { role: row.role as AgentMessage['role'] } : {}),
    };
  } catch {
    return undefined;
  }
}

function messageHead(row: MessageRow, message: AgentMessage): SessionInputMessageHead {
  const contentHead = takeUnicodeCodePoints(
    projectNavigationText(message.msg_content),
    CONTENT_HEAD_CODE_POINTS,
  );
  return {
    messageRowId: row.id,
    msgId: message.msg_id,
    timestamp: row.created_at_ms,
    ...(contentHead ? { contentHead } : {}),
  };
}

function finishSummary(summary: MutableSummary): SessionInputSummaryRecord {
  return {
    userInput: summary.userInput,
    ...(summary.assistantResponse ? { assistantResponse: summary.assistantResponse } : {}),
    artifacts: [...summary.artifactsByKey.values()].sort(
      (left, right) => left.messageRowId - right.messageRowId || left.assetIndex - right.assetIndex,
    ),
    fileChangeCount: summary.fileChangePaths.size,
  };
}

function paginateSummaries(
  summaries: SessionInputSummaryRecord[],
  options: SessionInputSummaryListOptions,
): Pick<SessionInputSummaryPage, 'summaries' | 'hasMore' | 'nextBeforeRowId'> {
  const end =
    options.beforeRowId === undefined
      ? summaries.length
      : findExclusiveEndIndex(summaries, options.beforeRowId);
  const start = Math.max(0, end - options.limit);
  const page = summaries.slice(start, end);
  const hasMore = start > 0;
  return {
    summaries: page,
    hasMore,
    ...(hasMore && page[0] ? { nextBeforeRowId: page[0].userInput.messageRowId } : {}),
  };
}

function findExclusiveEndIndex(
  summaries: SessionInputSummaryRecord[],
  beforeRowId: number,
): number {
  let low = 0;
  let high = summaries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (summaries[middle]!.userInput.messageRowId < beforeRowId) low = middle + 1;
    else high = middle;
  }
  return low;
}

function toArtifact(row: AssetRow): SessionInputSummaryArtifact {
  return {
    messageRowId: row.message_row_id,
    msgId: row.msg_id,
    messageCreatedAtMs: row.message_created_at_ms,
    assetIndex: row.asset_index,
    assetKey: row.asset_key,
    sourceTag: row.source_tag,
    path: row.path,
    ...(row.name ? { name: row.name } : {}),
    ...(row.asset_type ? { assetType: row.asset_type } : {}),
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    ...(row.drive_node_id ? { driveNodeId: row.drive_node_id } : {}),
  };
}

function runReadTransaction<T>(db: DatabaseLike, fn: () => T): T {
  if (!db.transaction) return fn();
  return db.transaction(fn as (...args: never[]) => T)();
}
