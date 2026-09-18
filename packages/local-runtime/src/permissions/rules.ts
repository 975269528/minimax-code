import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { MetricsClient } from '../common/metrics.js';
import { logger } from '../common/logger.js';
import {
  configV1ToRules,
  configV2ToRules,
  mutateRules,
  readPermissionUpdate,
  readRuleSource,
  readRuleStringArray,
  rulesToConfigV1,
  rulesToConfigV2,
} from './rule-codec.js';
import { selectMatchingRule } from './rule-match.js';
import {
  LocalPermissionRuleError,
  LocalPermissionStoreUnhealthyError,
  type LocalPermissionDecision,
  type LocalPermissionMode,
  type LocalPermissionRule,
  type LocalPermissionRuleSource,
} from './rule-model.js';

export { serializeLocalPermissionRule } from './rule-codec.js';
export { LocalPermissionRuleError, LocalPermissionStoreUnhealthyError } from './rule-model.js';
export type {
  LocalPermissionAction,
  LocalPermissionBehavior,
  LocalPermissionDecision,
  LocalPermissionMatcher,
  LocalPermissionMode,
  LocalPermissionRule,
  LocalPermissionRuleSource,
  LocalPermissionRuleValue,
  LocalPermissionStoreUnhealthyReason,
} from './rule-model.js';

interface PermissionFileState {
  rules: LocalPermissionRule[];
}

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SESSION_ID_PATTERN = /^[a-z0-9_-]+$/i;

export class LocalPermissionRuleStore {
  /** Per-file promise chain serializing read-modify-write cycles. */
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataDirGetter: () => string,
    private readonly metricsClient?: MetricsClient,
    private readonly storageWriteVersionGetter: () => 1 | 2 = () => 2,
  ) {}

  async listRules(
    filter: {
      source?: string | null;
      agentName?: string | null;
      /** Read-only management union; runtime checks keep using `agentName`. */
      agentNames?: readonly string[];
      sessionId?: string | null;
    } = {},
  ): Promise<LocalPermissionRule[]> {
    const source = filter.source ? readRuleSource(filter.source) : undefined;
    const agentName = filter.agentName ?? undefined;
    const agentNames = filter.agentNames
      ? [...new Set(filter.agentNames)]
      : agentName
        ? [agentName]
        : [];
    const sessionId = filter.sessionId ?? undefined;
    for (const name of agentNames) validateAgentName(name);
    if (sessionId) validateSessionId(sessionId);

    const rules = [
      ...(await this.readRules('global', 'global')),
      ...(await Promise.all(agentNames.map((name) => this.readRules('agent', name)))).flat(),
      ...(sessionId ? await this.readRules('session', sessionId) : []),
    ];
    return source ? rules.filter((rule) => rule.source === source) : rules;
  }

  async applyUpdate(raw: Record<string, unknown>): Promise<void> {
    const update = readPermissionUpdate(raw);
    // Serialize the whole read-modify-write per file: concurrent updates
    // (e.g. bulk permission batch-reply from parallel agents) would otherwise
    // lose rules or tear the file (issue minimax-code#117).
    const filePath = this.filePath(update.source, update.destination);
    logger.info(
      {
        lifecycle: 'rule_update_start',
        update_type: update.type,
        source: update.source,
        destination_kind: update.source === 'global' ? 'global' : update.source,
        rule_count: update.rules.length,
      },
      'permission.store',
    );
    await this.withFileQueue(filePath, async () => {
      const current = await this.readConfigFile(filePath, update.source, update.destination);
      const next = mutateRules(current.rules, update);
      await this.writeRules(filePath, next, this.readStorageWriteVersion());
    });
    logger.info(
      {
        lifecycle: 'rule_update_committed',
        update_type: update.type,
        source: update.source,
        destination_kind: update.source === 'global' ? 'global' : update.source,
        rule_count: update.rules.length,
      },
      'permission.store',
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    const filePath = this.filePath('session', sessionId);
    await this.withFileQueue(filePath, () => rm(filePath, { force: true }));
  }

  async copySession(sourceSessionId: string, targetSessionId: string): Promise<void> {
    validateSessionId(sourceSessionId);
    validateSessionId(targetSessionId);
    const sourceState = await this.readConfigFile(
      this.filePath('session', sourceSessionId),
      'session',
      sourceSessionId,
    );
    const sourceRules = sourceState.rules;
    const targetPath = this.filePath('session', targetSessionId);
    await this.withFileQueue(targetPath, () => {
      if (sourceRules.length === 0) return rm(targetPath, { force: true });
      return this.writeRules(
        targetPath,
        sourceRules.map((rule) => ({ ...rule, destination: targetSessionId })),
        this.readStorageWriteVersion(),
      );
    });
  }

  async check(input: {
    toolName: string;
    input: Record<string, unknown>;
    mode: LocalPermissionMode;
    agentName?: string;
    sessionId?: string;
  }): Promise<LocalPermissionDecision> {
    if (input.mode === 'off') {
      return {
        behavior: 'allow',
        reason: `Permission mode ${input.mode} allows local tool calls.`,
      };
    }
    const rules = await this.listRules({
      agentName: input.agentName,
      sessionId: input.sessionId,
    });
    const match = selectMatchingRule(rules, input.toolName, input.input);
    if (input.mode === 'bypassPermissions') {
      if (match && match.ruleBehavior !== 'allow') {
        return {
          behavior: match.ruleBehavior,
          reason: `Matched ${match.source} permission rule for ${input.toolName}.`,
          rule: match,
        };
      }
      return {
        behavior: 'allow',
        reason: `Permission mode ${input.mode} allows local tool calls.`,
      };
    }
    if (match) {
      return {
        behavior: match.ruleBehavior,
        reason: `Matched ${match.source} permission rule for ${input.toolName}.`,
        rule: match,
      };
    }

    return {
      behavior: 'ask',
      reason: `No local permission rule matched ${input.toolName}; approval is required.`,
    };
  }

  private async readRules(
    source: LocalPermissionRuleSource,
    destination: string,
  ): Promise<LocalPermissionRule[]> {
    const state = await this.readConfigFile(
      this.filePath(source, destination),
      source,
      destination,
    );
    return state.rules;
  }

  private async readConfigFile(
    filePath: string,
    source: LocalPermissionRuleSource,
    destination: string,
  ): Promise<PermissionFileState> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [] };
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Keep the corrupt file in place as repair evidence. Treating it as an
      // empty rule set could drop a persisted deny and silently authorize a
      // command; callers map this typed health failure to an approval prompt.
      logger.warn(
        { lifecycle: 'store_unhealthy', source, reason: 'corrupt-json' },
        'permission.store',
      );
      this.metricsClient?.counter('permission_store_corrupt_total', 1, { source });
      throw new LocalPermissionStoreUnhealthyError('corrupt-json', source);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn(
        { lifecycle: 'store_unhealthy', source, reason: 'invalid-store-shape' },
        'permission.store',
      );
      throw new LocalPermissionStoreUnhealthyError('invalid-store-shape', source);
    }
    const record = parsed as Record<string, unknown>;
    if (record.version === 2) {
      try {
        return {
          rules: configV2ToRules(record, source, destination),
        };
      } catch (error) {
        logger.warn(
          {
            lifecycle: 'store_unhealthy',
            source,
            reason: 'invalid-v2-rule',
            error: error instanceof Error ? error.message : String(error),
          },
          'permission.store',
        );
        throw new LocalPermissionStoreUnhealthyError('invalid-v2-rule', source);
      }
    }
    if (record.version !== undefined) {
      logger.warn(
        { lifecycle: 'unsupported_store_version', source, version: record.version },
        'permission.store',
      );
      throw new LocalPermissionStoreUnhealthyError('unsupported-version', source);
    }
    const config = {
      allow: readRuleStringArray(record.allow),
      deny: readRuleStringArray(record.deny),
      ask: readRuleStringArray(record.ask),
    };
    return { rules: configV1ToRules(config, source, destination) };
  }

  private async writeRules(
    filePath: string,
    rules: LocalPermissionRule[],
    writeVersion: 1 | 2,
  ): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    // Atomic replace (temp file + rename) so a crash or a concurrent reader
    // never observes a torn permission store.
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const config = writeVersion === 2 ? rulesToConfigV2(rules) : rulesToConfigV1(rules);
    try {
      await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
      await rename(tmp, filePath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private readStorageWriteVersion(): 1 | 2 {
    return this.storageWriteVersionGetter() === 2 ? 2 : 1;
  }

  private async withFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.withCrossProcessFileLock(filePath, work));
    this.writeQueues.set(
      filePath,
      next.catch(() => undefined),
    );
    return next;
  }

  private async withCrossProcessFileLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(filePath), { recursive: true });
    let release: (() => Promise<void>) | undefined;
    try {
      // `realpath: false` allows locking a permission file before its first
      // write. proper-lockfile creates a same-directory lock directory, so
      // every runtime sharing this dataDir serializes the full read-modify-write.
      release = await lockfile.lock(filePath, {
        realpath: false,
        stale: 10_000,
        retries: { retries: 20, factor: 1, minTimeout: 5, maxTimeout: 25 },
      });
      return await work();
    } finally {
      await release?.().catch(() => undefined);
    }
  }

  private filePath(source: LocalPermissionRuleSource, destination: string): string {
    const dataDir = this.dataDirGetter();
    if (source === 'global') {
      if (destination !== 'global') {
        throw new LocalPermissionRuleError(
          'Global permission updates must use destination "global"',
        );
      }
      return path.join(dataDir, 'permission.json');
    }
    if (source === 'agent') {
      validateAgentName(destination);
      return resolveScopedPermissionPath(dataDir, 'agents', destination);
    }
    validateSessionId(destination);
    return resolveScopedPermissionPath(dataDir, 'sessions', destination);
  }
}

function resolveScopedPermissionPath(
  dataDir: string,
  scopeDir: 'agents' | 'sessions',
  destination: string,
): string {
  const scopeRoot = path.resolve(dataDir, scopeDir);
  const resolved = path.resolve(scopeRoot, destination, 'permission.json');
  if (!resolved.startsWith(`${scopeRoot}${path.sep}`)) {
    throw new LocalPermissionRuleError(`Invalid permission destination: ${destination}`);
  }
  return resolved;
}

function validateAgentName(agentName: string): void {
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new LocalPermissionRuleError(`Invalid agent name: "${agentName}"`);
  }
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new LocalPermissionRuleError(`Invalid session id: "${sessionId}"`);
  }
}
