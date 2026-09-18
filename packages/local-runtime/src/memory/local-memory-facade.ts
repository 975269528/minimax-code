import { join } from 'node:path';

import { FsLocalMemoryStore } from './local-memory-store-fs.js';
import {
  LocalMemoryError,
  type LocalMemoryConfig,
  type LocalMemoryEventEmitter,
  type LocalMemoryTarget,
} from './types.js';

const USER_APPEND_MAX_CHARS = 500;
const SUMMARY_MAX_BYTES = 4 * 1024;
const CLEANUP_THRESHOLD_BYTES = 64 * 1024;

const USER_TARGET: LocalMemoryTarget = { scope: 'user' };

// Stable identifier surfaced on emitted memory.saved payloads for user scope,
// which has no agentName.
const USER_SCOPE_KEY = '';

function agentTarget(agentName: string | undefined): LocalMemoryTarget {
  return { scope: 'agent', agentName: agentName ?? '' };
}

function scopeKey(target: LocalMemoryTarget): string {
  return target.scope === 'agent' ? target.agentName : USER_SCOPE_KEY;
}

export interface LocalMemoryFacadeOptions {
  config: () => LocalMemoryConfig;
  nowMs?: () => number;
  emitBusEvent?: LocalMemoryEventEmitter;
}

export class LocalMemoryFacade {
  private readonly nowMs: () => number;
  private readonly store: FsLocalMemoryStore;

  constructor(private readonly options: LocalMemoryFacadeOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.store = new FsLocalMemoryStore(options.config, this.nowMs);
  }

  getStore(): FsLocalMemoryStore {
    return this.store;
  }

  async getAgentMemory(agentName: string) {
    return this.store.readMain(agentTarget(agentName));
  }

  async getUserMemory() {
    return this.store.readMain(USER_TARGET);
  }

  async appendMemory(agentName: string, content: string) {
    const target = agentTarget(agentName);
    const result = await this.store.appendMain(target, content);
    this.emitSaved(target, 'main');
    return result;
  }

  async appendUserMemory(content: string, reason: string | undefined) {
    if (!reason?.trim())
      throw new LocalMemoryError('REASON_REQUIRED', 'user memory append requires reason');
    if (content.length > USER_APPEND_MAX_CHARS) {
      throw new LocalMemoryError(
        'CONTENT_TOO_LONG',
        'user memory append content exceeds 500 characters',
      );
    }
    const result = await this.store.appendMain(
      USER_TARGET,
      `<!-- mem-append-reason: ${reason.trim()} -->\n${content}`,
    );
    this.emitSaved(USER_TARGET, 'main');
    return result;
  }

  async writeMemory(agentName: string, content: string) {
    const target = agentTarget(agentName);
    const result = await this.store.writeMain(target, content);
    this.emitSaved(target, 'main');
    return result;
  }

  async writeMemoryForManagement(agentName: string, content: string) {
    const target = agentTarget(agentName);
    const result = await this.store.writeMainForManagement(target, content);
    this.emitSaved(target, 'main');
    return result;
  }

  async writeUserMemory(content: string) {
    const result = await this.store.writeMain(USER_TARGET, content);
    this.emitSaved(USER_TARGET, 'main');
    return result;
  }

  async writeUserMemoryForManagement(content: string) {
    const result = await this.store.writeMainForManagement(USER_TARGET, content);
    this.emitSaved(USER_TARGET, 'main');
    return result;
  }

  async editMemory(agentName: string, oldString: string, newString: string, replaceAll = false) {
    const target = agentTarget(agentName);
    const result = await this.store.editMain(target, oldString, newString, replaceAll);
    this.emitSaved(target, 'main');
    return result;
  }

  searchMemory(agentName: string, query: string) {
    return this.store.searchMain(agentTarget(agentName), query);
  }

  searchUserMemory(query: string) {
    return this.store.searchMain(USER_TARGET, query);
  }

  listTopics(agentName: string) {
    return this.store.listTopics(agentTarget(agentName));
  }

  getTopic(agentName: string, topicName: string) {
    return this.store.readTopic(agentTarget(agentName), topicName);
  }

  async writeTopic(agentName: string, topicName: string, description: string, content: string) {
    const target = agentTarget(agentName);
    await this.store.writeTopic(target, topicName, description, content);
    this.emitSaved(target, 'topic', { topicName });
  }

  async appendTopic(agentName: string, topicName: string, content: string) {
    const target = agentTarget(agentName);
    const result = await this.store.appendTopic(target, topicName, content);
    this.emitSaved(target, 'topic', { topicName });
    return result;
  }

  async editTopic(
    agentName: string,
    topicName: string,
    oldString: string,
    newString: string,
    replaceAll = false,
  ) {
    const target = agentTarget(agentName);
    const result = await this.store.editTopic(target, topicName, oldString, newString, replaceAll);
    this.emitSaved(target, 'topic', { topicName });
    return result;
  }

  async deleteTopic(agentName: string, topicName: string) {
    const target = agentTarget(agentName);
    const deleted = await this.store.deleteTopic(target, topicName);
    if (deleted) this.emitSaved(target, 'topic', { topicName, deleted });
    return deleted;
  }

  searchTopics(agentName: string, keyword: string, limit?: number) {
    return this.store.searchTopics(agentTarget(agentName), keyword, limit);
  }

  listDaily(agentName: string, limit?: number, offset?: number, includeArchived?: boolean) {
    return this.store.listDaily(agentTarget(agentName), limit, offset, includeArchived);
  }

  getDaily(agentName: string, date: string) {
    return this.store.readDaily(agentTarget(agentName), date);
  }

  async writeDaily(agentName: string, date: string, content: string) {
    const target = agentTarget(agentName);
    await this.store.writeDaily(target, date, content);
    this.emitSaved(target, 'daily', { date });
  }

  async appendDaily(agentName: string, date: string, content: string) {
    const target = agentTarget(agentName);
    await this.store.appendDaily(target, date, content);
    this.emitSaved(target, 'daily', { date });
  }

  async deleteDaily(agentName: string, date: string) {
    const target = agentTarget(agentName);
    const deleted = await this.store.deleteDaily(target, date);
    if (deleted) this.emitSaved(target, 'daily', { date, deleted });
    return deleted;
  }

  async writeMemorySummary(agentName: string, content: string) {
    if (Buffer.byteLength(content, 'utf8') > SUMMARY_MAX_BYTES) {
      throw new LocalMemoryError('SUMMARY_TOO_LARGE', 'summary exceeds 4KB');
    }
    const target = agentTarget(agentName);
    await this.store.writeSummary(target, content);
    this.emitSaved(target, 'summary');
  }

  listArchive(agentName: string, limit?: number, offset?: number) {
    return this.store.listArchive(agentTarget(agentName), limit, offset);
  }

  getArchive(agentName: string, snapshotDate: string, fileName: string) {
    return this.store.readArchive(agentTarget(agentName), snapshotDate, fileName);
  }

  snapshotForCleanup(agentName: string, date?: string) {
    return this.store.snapshotForCleanup(agentTarget(agentName), date);
  }

  archiveOldDaily(agentName: string, ttlDays: number) {
    return this.store.archiveOldDaily(agentTarget(agentName), ttlDays);
  }

  async triggerCleanup(agentName: string, force = false) {
    const target = agentTarget(agentName);
    const current = await this.store.readMain(target);
    if (!force && current.sizeBytes < CLEANUP_THRESHOLD_BYTES) {
      return { spawned: false, reason: 'below_threshold' };
    }
    await this.store.snapshotForCleanup(target);
    return { spawned: true, reason: force ? 'force_snapshot' : 'threshold_snapshot' };
  }

  markSession(date: string, sessionId: string, agentName: string, wroteMemory: boolean) {
    return this.store.markSession(date, sessionId, agentName, wroteMemory);
  }

  getUnreminded(date: string, agentName?: string) {
    return this.store.getUnreminded(date, agentName);
  }

  markReminded(date: string, sessionId: string) {
    return this.store.markReminded(date, sessionId);
  }

  markReflected(date: string, sessionId: string, agentName: string, reflectedAt: string) {
    return this.store.markReflected(date, sessionId, agentName, reflectedAt);
  }

  getReflectionTs(sessionId: string) {
    return this.store.getReflectionTs(sessionId);
  }

  async collectReminderMemory(agentName: string) {
    const target = agentTarget(agentName);
    const main = await this.store.readMain(target);
    const user = await this.store.readMain(USER_TARGET);
    const summary = await this.store.readSummary(target);
    const topics = await this.store.listTopics(target).catch(() => []);
    const location = this.store.resolve(target);
    return {
      main: main.content,
      mainPath: location.mainPath,
      mainLines: main.content ? main.content.split('\n').length : 0,
      mainSizeBytes: main.sizeBytes,
      user: user.content,
      userPath: this.store.resolve(USER_TARGET).mainPath,
      summary,
      topics: topics.map((topic) => ({
        name: topic.name,
        description: topic.description,
        path: join(location.memoryDir, 'topics', `${topic.name}.md`),
      })),
    };
  }

  private emitSaved(target: LocalMemoryTarget, kind: string, extra: Record<string, unknown> = {}) {
    this.options.emitBusEvent?.('memory.saved', {
      agentName: scopeKey(target),
      kind,
      timestamp: this.nowMs(),
      ...extra,
    });
  }
}
