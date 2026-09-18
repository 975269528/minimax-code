import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  LocalMemoryError,
  type LocalMemoryConfig,
  type LocalMemoryUnremindedEntry,
} from './types.js';
import { assertDate, formatTs, safeRead, safeReaddir } from './local-memory-store-utils.js';

interface TrackingRecord {
  sessionId: string;
  // Newer records key on agentName (local agents have no i64 snowflake). Older
  // on-disk records may carry only a numeric agentId; it is read tolerantly and
  // simply never matches an agentName filter.
  agentName?: string;
  agentId?: number;
  wroteMemory: boolean;
  reminded: boolean;
  checkedAt: string;
  lastReflectedAt?: string;
}

/**
 * Per-date session tracking for the local memory subsystem (which sessions
 * wrote memory / were reminded / reflected). Stored as JSON under
 * `<dataDir>/memory/tracking/<date>.json` and keyed by agentName.
 */
export class FsLocalMemoryTracking {
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: () => LocalMemoryConfig,
    private readonly nowMs: () => number,
  ) {}

  async markSession(
    date: string,
    sessionId: string,
    agentName: string,
    wroteMemory: boolean,
  ): Promise<void> {
    await this.updateTracking(date, (records) => {
      const idx = records.findIndex((record) => record.sessionId === sessionId);
      const previous = idx >= 0 ? records[idx] : undefined;
      const next: TrackingRecord = {
        ...(previous ?? {}),
        sessionId,
        agentName,
        wroteMemory: wroteMemory || previous?.wroteMemory === true,
        reminded: previous?.reminded ?? false,
        checkedAt: formatTs(this.nowMs()),
      };
      if (idx >= 0) records[idx] = next;
      else records.push(next);
      return records;
    });
  }

  async getUnreminded(date: string, agentName?: string): Promise<LocalMemoryUnremindedEntry[]> {
    return (await this.readTracking(date)).flatMap((record) => {
      if (record.reminded) return [];
      if (agentName !== undefined && record.agentName !== agentName) return [];
      return [
        {
          sessionId: record.sessionId,
          agentName: record.agentName ?? '',
          wroteMemory: record.wroteMemory,
          reminded: record.reminded,
          checkedAt: record.checkedAt,
          ...(record.lastReflectedAt ? { lastReflectedAt: record.lastReflectedAt } : {}),
        },
      ];
    });
  }

  async markReminded(date: string, sessionId: string): Promise<void> {
    await this.updateTracking(date, (records) => {
      for (const record of records) if (record.sessionId === sessionId) record.reminded = true;
      return records;
    });
  }

  async markReflected(
    date: string,
    sessionId: string,
    agentName: string,
    reflectedAt: string,
  ): Promise<void> {
    await this.updateTracking(date, (records) => {
      const idx = records.findIndex((record) => record.sessionId === sessionId);
      const previous = idx >= 0 ? records[idx] : undefined;
      const next: TrackingRecord = {
        ...(previous ?? {}),
        sessionId,
        agentName,
        wroteMemory: previous?.wroteMemory ?? false,
        reminded: previous?.reminded ?? false,
        checkedAt: previous?.checkedAt ?? formatTs(this.nowMs()),
        lastReflectedAt: reflectedAt,
      };
      if (idx >= 0) records[idx] = next;
      else records.push(next);
      return records;
    });
  }

  async getReflectionTs(sessionId: string): Promise<string | undefined> {
    const trackingDir = join(this.config().dataDir, 'memory', 'tracking');
    for (const file of await safeReaddir(trackingDir)) {
      if (!file.endsWith('.json')) continue;
      const found = (await this.readTracking(file.slice(0, -5))).find(
        (record) => record.sessionId === sessionId,
      );
      if (found?.lastReflectedAt) return found.lastReflectedAt;
    }
    return undefined;
  }

  private trackingPath(date: string): string {
    return join(this.config().dataDir, 'memory', 'tracking', `${assertDate(date)}.json`);
  }

  private async readTracking(date: string): Promise<TrackingRecord[]> {
    const raw = await safeRead(this.trackingPath(date));
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as TrackingRecord[];
    return Array.isArray(parsed) ? parsed : [];
  }

  private async updateTracking(
    date: string,
    update: (records: TrackingRecord[]) => TrackingRecord[],
  ): Promise<void> {
    const trackingPath = this.trackingPath(date);
    await this.withFileQueue(trackingPath, async () => {
      const raw = await safeRead(trackingPath);
      const parsed = raw.trim() ? (JSON.parse(raw) as TrackingRecord[]) : [];
      const records = Array.isArray(parsed) ? parsed : [];
      this.assertWritable();
      await this.writeFileAtomic(trackingPath, `${JSON.stringify(update(records), null, 2)}\n`);
    });
  }

  private async withFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.writeQueues.set(
      filePath,
      next.catch(() => undefined),
    );
    return next;
  }

  private async writeFileAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, filePath);
  }

  private assertWritable(): void {
    if (this.config().enabled === false) {
      throw new LocalMemoryError('MEMORY_DISABLED', 'memory writes are disabled');
    }
  }
}
