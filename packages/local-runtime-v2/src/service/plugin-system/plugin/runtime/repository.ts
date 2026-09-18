import path from 'node:path';

import { and, asc, eq } from 'drizzle-orm';
import {
  PluginInstallationPolicy,
  type PluginInstallationPolicy as PluginInstallationPolicyType,
} from '@mavis/protocol/local';

import type { AppDb } from '../../../../infra/db/client.js';
import {
  pluginDisabledLocalRoots,
  pluginOfficialStates,
} from '../../../../infra/db/schema/plugin.js';

const CONTENT_DIGEST = /^sha256-tree-v1:[0-9a-f]{64}$/u;
const ARCHIVE_DIGEST = /^[0-9a-f]{64}$/u;
const CACHE_KEY = /^sha256-tree-v1-[0-9a-f]{64}$/u;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface PluginRepositoryScope {
  readonly principalId: string;
  readonly deployment: string;
}

export interface CachedPluginPackage {
  readonly name: string;
  readonly version: string;
  readonly archiveSha256: string;
  readonly contentDigest: string;
  readonly cacheKey: string;
}

interface OfficialPluginPackageIdentity {
  readonly name: string;
  readonly version: string;
  readonly archiveSha256: string;
  readonly contentDigest: string;
}

export interface OfficialPluginInstallationRecord {
  readonly name: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  /** Missing in legacy schema-v1 JSON and normalized to USER_MANAGED. */
  readonly installationPolicy?: PluginInstallationPolicyType;
  /**
   * Current catalog package. Older persisted schema-v1 rows may omit it; the
   * next full or target reconciliation fills it without a DB migration.
   */
  readonly package?: OfficialPluginPackageIdentity;
  readonly cachedPackages: readonly CachedPluginPackage[];
}

export function effectiveInstallationPolicy(
  installation: Pick<OfficialPluginInstallationRecord, 'installationPolicy'>,
): PluginInstallationPolicyType {
  return installation.installationPolicy === PluginInstallationPolicy.DEFAULT_INSTALLED_UNREMOVABLE
    ? PluginInstallationPolicy.DEFAULT_INSTALLED_UNREMOVABLE
    : PluginInstallationPolicy.USER_MANAGED;
}

interface PluginSnapshotMetadata {
  readonly revision: string;
  readonly publishedAtMs: number;
  readonly packageContentDigests: readonly string[];
}

export interface OfficialPluginRepositoryState {
  readonly schemaVersion: 1;
  readonly installations: readonly OfficialPluginInstallationRecord[];
  readonly lastSuccessfulFullState?: JsonValue;
  readonly currentSnapshot?: PluginSnapshotMetadata;
}

class PluginRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PluginRepositoryError';
  }
}

export class SqlitePluginRepository {
  constructor(
    private readonly db: AppDb,
    private readonly nowMs: () => number = Date.now,
  ) {}

  loadOfficialState(scope: PluginRepositoryScope): OfficialPluginRepositoryState | undefined {
    assertScope(scope);
    const row = this.db
      .select({ stateJson: pluginOfficialStates.stateJson })
      .from(pluginOfficialStates)
      .where(
        and(
          eq(pluginOfficialStates.principalId, scope.principalId),
          eq(pluginOfficialStates.deployment, scope.deployment),
        ),
      )
      .get();
    if (!row) return undefined;
    if (typeof row.stateJson !== 'string') {
      fail('STATE_CORRUPT', 'official Plugin state row has no JSON payload');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.stateJson);
    } catch {
      fail('STATE_CORRUPT', 'official Plugin state JSON cannot be parsed');
    }
    assertOfficialState(parsed);
    return parsed;
  }

  saveOfficialState(scope: PluginRepositoryScope, state: OfficialPluginRepositoryState): void {
    assertScope(scope);
    assertOfficialState(state);
    const stateJson = JSON.stringify(state);
    const updatedAtMs = this.nowMs();
    this.db
      .insert(pluginOfficialStates)
      .values({
        principalId: scope.principalId,
        deployment: scope.deployment,
        stateJson,
        updatedAtMs,
      })
      .onConflictDoUpdate({
        target: [pluginOfficialStates.principalId, pluginOfficialStates.deployment],
        set: { stateJson, updatedAtMs },
      })
      .run();
  }

  deleteOfficialState(scope: PluginRepositoryScope): void {
    assertScope(scope);
    this.db
      .delete(pluginOfficialStates)
      .where(
        and(
          eq(pluginOfficialStates.principalId, scope.principalId),
          eq(pluginOfficialStates.deployment, scope.deployment),
        ),
      )
      .run();
  }

  listReferencedOfficialCacheKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    const rows = this.db
      .select({ stateJson: pluginOfficialStates.stateJson })
      .from(pluginOfficialStates)
      .all();
    for (const row of rows) {
      if (typeof row.stateJson !== 'string') {
        fail('STATE_CORRUPT', 'official Plugin state row has no JSON payload');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.stateJson);
      } catch {
        fail('STATE_CORRUPT', 'official Plugin state JSON cannot be parsed');
      }
      assertOfficialState(parsed);
      for (const installation of parsed.installations) {
        for (const cached of installation.cachedPackages) keys.add(cached.cacheKey);
      }
    }
    return keys;
  }

  isLocalPluginEnabled(canonicalRoot: string): boolean {
    const identity = assertCanonicalRoot(canonicalRoot);
    const row = this.db
      .select({ canonicalRoot: pluginDisabledLocalRoots.canonicalRoot })
      .from(pluginDisabledLocalRoots)
      .where(eq(pluginDisabledLocalRoots.canonicalRoot, identity))
      .get();
    return row === undefined;
  }

  setLocalPluginEnabled(canonicalRoot: string, enabled: boolean): void {
    const identity = assertCanonicalRoot(canonicalRoot);
    if (enabled) {
      this.db
        .delete(pluginDisabledLocalRoots)
        .where(eq(pluginDisabledLocalRoots.canonicalRoot, identity))
        .run();
      return;
    }
    const updatedAtMs = this.nowMs();
    this.db
      .insert(pluginDisabledLocalRoots)
      .values({ canonicalRoot: identity, updatedAtMs })
      .onConflictDoUpdate({
        target: pluginDisabledLocalRoots.canonicalRoot,
        set: { updatedAtMs },
      })
      .run();
  }

  listDisabledLocalPluginRoots(): string[] {
    return this.db
      .select({ canonicalRoot: pluginDisabledLocalRoots.canonicalRoot })
      .from(pluginDisabledLocalRoots)
      .orderBy(asc(pluginDisabledLocalRoots.canonicalRoot))
      .all()
      .map((row) => {
        if (typeof row.canonicalRoot !== 'string') {
          fail('STATE_CORRUPT', 'local disabled Plugin row has an invalid identity');
        }
        return row.canonicalRoot;
      });
  }

  pruneMissingLocalPlugins(existingCanonicalRoots: ReadonlySet<string>): void {
    const existing = new Set([...existingCanonicalRoots].map((root) => assertCanonicalRoot(root)));
    for (const disabledRoot of this.listDisabledLocalPluginRoots()) {
      if (!existing.has(disabledRoot)) {
        this.db
          .delete(pluginDisabledLocalRoots)
          .where(eq(pluginDisabledLocalRoots.canonicalRoot, disabledRoot))
          .run();
      }
    }
  }
}

function assertScope(scope: PluginRepositoryScope): void {
  if (!scope.principalId.trim() || !scope.deployment.trim()) {
    fail('SCOPE_INVALID', 'principal and deployment are required');
  }
}

function assertOfficialState(value: unknown): asserts value is OfficialPluginRepositoryState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.installations)) {
    fail('STATE_CORRUPT', 'official Plugin state has an unsupported schema');
  }
  const installationNames = new Set<string>();
  for (const installation of value.installations) {
    assertInstallation(installation, installationNames);
  }
  if (value.lastSuccessfulFullState !== undefined && !isJsonValue(value.lastSuccessfulFullState)) {
    fail('STATE_CORRUPT', 'last successful full-state is not JSON');
  }
  if (value.currentSnapshot !== undefined) assertSnapshot(value.currentSnapshot);
}

function assertInstallation(value: unknown, installationNames: Set<string>): void {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.name) ||
    typeof value.installed !== 'boolean' ||
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.cachedPackages)
  ) {
    fail('STATE_CORRUPT', 'official Plugin installation record is invalid');
  }
  if (installationNames.has(value.name)) {
    fail('STATE_CORRUPT', 'official Plugin installation names are duplicated');
  }
  if (value.enabled && !value.installed) {
    fail('STATE_CORRUPT', 'an uninstalled official Plugin cannot be enabled');
  }
  assertInstallationPolicy(value.installationPolicy);
  assertCurrentPackage(value.package, value.name);
  installationNames.add(value.name);
  assertCachedPackages(value.name, value.cachedPackages);
}

function assertInstallationPolicy(value: unknown): void {
  if (
    value === undefined ||
    value === 0 ||
    value === PluginInstallationPolicy.USER_MANAGED ||
    value === PluginInstallationPolicy.DEFAULT_INSTALLED_UNREMOVABLE
  ) {
    return;
  }
  fail('STATE_CORRUPT', 'official Plugin installation policy is invalid');
}

function assertCurrentPackage(value: unknown, installationName: string): void {
  if (value === undefined) return;
  assertPackageIdentity(value);
  if (value.name !== installationName) {
    fail('STATE_CORRUPT', 'current Plugin package belongs to another installation');
  }
}

function assertPackageIdentity(value: unknown): asserts value is OfficialPluginPackageIdentity {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.version) ||
    typeof value.archiveSha256 !== 'string' ||
    !ARCHIVE_DIGEST.test(value.archiveSha256) ||
    typeof value.contentDigest !== 'string' ||
    !CONTENT_DIGEST.test(value.contentDigest)
  ) {
    fail('STATE_CORRUPT', 'current Plugin package identity is invalid');
  }
}

function assertCachedPackages(installationName: string, values: readonly unknown[]): void {
  const cachedIdentities = new Set<string>();
  for (const cached of values) {
    assertCachedPackage(cached);
    if (cached.name !== installationName) {
      fail('STATE_CORRUPT', 'cached Plugin package belongs to another installation');
    }
    const identity = `${cached.version}\0${cached.archiveSha256}\0${cached.contentDigest}`;
    if (cachedIdentities.has(identity)) {
      fail('STATE_CORRUPT', 'cached Plugin package identities are duplicated');
    }
    cachedIdentities.add(identity);
  }
}

function assertCachedPackage(value: unknown): asserts value is CachedPluginPackage {
  if (!isRecord(value) || !hasValidCachedPackageFields(value)) {
    fail('STATE_CORRUPT', 'cached Plugin package identity is invalid');
  }
}

function hasValidCachedPackageFields(value: Record<string, unknown>): boolean {
  if (!isNonEmptyString(value.name) || !isNonEmptyString(value.version)) return false;
  if (typeof value.archiveSha256 !== 'string' || !ARCHIVE_DIGEST.test(value.archiveSha256)) {
    return false;
  }
  if (typeof value.contentDigest !== 'string' || !CONTENT_DIGEST.test(value.contentDigest)) {
    return false;
  }
  return (
    typeof value.cacheKey === 'string' &&
    CACHE_KEY.test(value.cacheKey) &&
    value.cacheKey === value.contentDigest.replace(':', '-')
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function assertSnapshot(value: unknown): asserts value is PluginSnapshotMetadata {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'string' ||
    !value.revision.trim() ||
    !Number.isInteger(value.publishedAtMs) ||
    (value.publishedAtMs as number) < 0 ||
    !Array.isArray(value.packageContentDigests) ||
    value.packageContentDigests.some(
      (digest) => typeof digest !== 'string' || !CONTENT_DIGEST.test(digest),
    )
  ) {
    fail('STATE_CORRUPT', 'published Plugin snapshot metadata is invalid');
  }
}

function assertCanonicalRoot(value: string): string {
  if (!path.isAbsolute(value)) fail('LOCAL_IDENTITY_INVALID', 'local Plugin root must be absolute');
  return path.normalize(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: string, detail: string): never {
  throw new PluginRepositoryError(code, detail);
}
