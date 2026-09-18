import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  CanonicalHistoryScannerPaths,
  CanonicalHistoryScannerResult,
  HistoryCatalogArtifactV1,
  HistoryCatalogV1,
  UserMessageLocatorV1,
} from './canonical-history-scanner.js';

const CATALOG_FILE = 'history-catalog.json';
const LOCATORS_FILE = 'user-message-locators.jsonl';

type Scanner = (paths: CanonicalHistoryScannerPaths) => Promise<CanonicalHistoryScannerResult>;

interface CanonicalHistoryIndexPaths {
  readonly catalog: string;
  readonly locators: string;
}

interface CanonicalHistoryIndexExpectation {
  readonly sessionId: string;
  readonly activeGeneration: number;
  readonly activeRevision: string;
}

interface CanonicalHistoryIndex {
  readonly catalog: HistoryCatalogV1;
  readonly locators: readonly UserMessageLocatorV1[];
  readonly rebuilt: boolean;
}

export interface CanonicalHistoryIndexAdapter {
  readonly paths: CanonicalHistoryIndexPaths;
  readonly isDirty: boolean;
  loadOrRebuild(
    expectation: CanonicalHistoryIndexExpectation,
    scanner: Scanner,
    canonicalPaths: CanonicalHistoryScannerPaths,
  ): Promise<CanonicalHistoryIndex>;
  rebuild(result: CanonicalHistoryScannerResult): Promise<CanonicalHistoryIndex>;
}

function resolveCanonicalHistoryIndexPaths(sessionDir: string): CanonicalHistoryIndexPaths {
  return { catalog: join(sessionDir, CATALOG_FILE), locators: join(sessionDir, LOCATORS_FILE) };
}

export function createCanonicalHistoryIndexAdapter(
  sessionDir: string,
): CanonicalHistoryIndexAdapter {
  const paths = resolveCanonicalHistoryIndexPaths(sessionDir);
  let dirty = false;

  return {
    paths,
    get isDirty() {
      return dirty;
    },
    async loadOrRebuild(expectation, scanner, canonicalPaths) {
      try {
        const index = await readIndex(paths);
        validateIndex(index, expectation);
        return { ...index, rebuilt: false };
      } catch {
        const result = await scanner(canonicalPaths);
        return persist(result);
      }
    },
    rebuild: persist,
  };

  async function persist(result: CanonicalHistoryScannerResult): Promise<CanonicalHistoryIndex> {
    const catalogData = `${JSON.stringify(result.catalog, null, 2)}\n`;
    const locatorData =
      result.locators.map((locator) => JSON.stringify(locator)).join('\n') +
      (result.locators.length ? '\n' : '');
    const token = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const catalogTmp = `${paths.catalog}.${token}.tmp`;
    const locatorsTmp = `${paths.locators}.${token}.tmp`;
    let previousCatalog: string | undefined;
    try {
      await mkdir(dirname(paths.catalog), { recursive: true });
      previousCatalog = await readOptional(paths.catalog);
      await writeFile(catalogTmp, catalogData, { encoding: 'utf8', mode: 0o600 });
      await writeFile(locatorsTmp, locatorData, { encoding: 'utf8', mode: 0o600 });
      await rename(catalogTmp, paths.catalog);
      try {
        await rename(locatorsTmp, paths.locators);
      } catch (error) {
        await restore(paths.catalog, previousCatalog, `${paths.catalog}.${token}.restore`);
        throw error;
      }
      dirty = false;
      return { catalog: result.catalog, locators: result.locators, rebuilt: true };
    } catch (error) {
      dirty = true;
      await Promise.all([removeIfPresent(catalogTmp), removeIfPresent(locatorsTmp)]);
      throw new CanonicalHistoryIndexWriteError(error);
    }
  }

  async function restore(
    path: string,
    previous: string | undefined,
    temporary: string,
  ): Promise<void> {
    if (previous === undefined) {
      await removeIfPresent(path);
      return;
    }
    await writeFile(temporary, previous, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Index cleanup and rollback are idempotent.
  }
}

async function readIndex(
  paths: CanonicalHistoryIndexPaths,
): Promise<Omit<CanonicalHistoryIndex, 'rebuilt'>> {
  const [catalogRaw, locatorsRaw] = await Promise.all([
    readFile(paths.catalog, 'utf8'),
    readFile(paths.locators, 'utf8'),
  ]);
  const catalog = JSON.parse(catalogRaw) as unknown;
  const locators = locatorsRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  if (!isCatalog(catalog) || !locators.every(isLocator))
    throw new Error('Invalid canonical history index');
  return { catalog, locators };
}

function validateIndex(
  index: Omit<CanonicalHistoryIndex, 'rebuilt'>,
  expectation: CanonicalHistoryIndexExpectation,
): void {
  const { catalog, locators } = index;
  if (
    catalog.sessionId !== expectation.sessionId ||
    catalog.activeGeneration !== expectation.activeGeneration ||
    catalog.activeRevision !== expectation.activeRevision
  ) {
    throw new Error('Stale canonical history index');
  }
  const artifacts = new Map(
    catalog.artifacts.map((artifact) => [`${artifact.generation}:${artifact.kind}`, artifact]),
  );
  for (const locator of locators) {
    const artifact = artifacts.get(
      `${locator.generation}:${locator.generation === catalog.activeGeneration ? 'active' : 'snapshot'}`,
    );
    if (!artifact || artifact.revision !== locator.artifactRevision)
      throw new Error('Stale canonical history locator index');
  }
}

function isCatalog(value: unknown): value is HistoryCatalogV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== 'string' ||
    !Number.isInteger(value.activeGeneration) ||
    typeof value.activeRevision !== 'string' ||
    !Array.isArray(value.artifacts)
  )
    return false;
  return value.artifacts.every(isArtifact);
}
function isArtifact(value: unknown): value is HistoryCatalogArtifactV1 {
  return (
    isRecord(value) &&
    Number.isInteger(value.generation) &&
    (value.kind === 'active' || value.kind === 'snapshot') &&
    typeof value.fileName === 'string' &&
    typeof value.revision === 'string' &&
    Number.isInteger(value.byteLength) &&
    Number.isInteger(value.messageCount)
  );
}
function isLocator(value: unknown): value is UserMessageLocatorV1 {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.messageId === 'string' &&
    value.messageId.startsWith('msg-user-v1-') &&
    Number.isInteger(value.generation) &&
    Number.isInteger(value.lineNumber) &&
    typeof value.byteOffset === 'number' &&
    Number.isInteger(value.byteOffset) &&
    value.byteOffset >= 0 &&
    typeof value.artifactRevision === 'string'
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class CanonicalHistoryIndexWriteError extends Error {
  constructor(cause: unknown) {
    super('Canonical history index write failed', { cause });
    this.name = 'CanonicalHistoryIndexWriteError';
  }
}
