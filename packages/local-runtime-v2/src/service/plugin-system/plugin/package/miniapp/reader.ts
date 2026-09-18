import {
  canonicalizePluginRoot,
  isRecord,
  readPluginJsonObject,
  type CanonicalPluginRoot,
} from '../filesystem.js';
import { PluginReaderError, readerFail } from '../reader-errors.js';
import type { MiniAppContribution } from '../types.js';
import { readMiniAppManifest } from './validation.js';

const PACKAGE_JSON_PATH = 'package.json';
const LEGACY_MANIFEST_LITERAL = './liveboard/liveboard.json';
const LEGACY_MANIFEST_PATH = 'liveboard/liveboard.json';
const MINIAPP_MANIFEST_LITERAL = './miniapp/miniapp.json';
const MINIAPP_MANIFEST_PATH = 'miniapp/miniapp.json';
const MCODE_V1_FIELDS = new Set(['schemaVersion', 'liveboard']);
const MCODE_V2_FIELDS = new Set(['schemaVersion', 'miniApp']);

export async function readOptionalMiniAppContribution(
  packageRoot: string,
  mcpServerNames: readonly string[],
): Promise<MiniAppContribution | undefined> {
  const root = await canonicalizePluginRoot(packageRoot, { rejectSymlink: true });
  const packageJson = await readOptionalPackageJson(root);
  if (!packageJson || packageJson.mcode === undefined) return undefined;
  const manifestRelativePath = readMiniAppMcode(packageJson.mcode);
  const { path: manifestPath, value } = await readMiniAppJson(root, manifestRelativePath);
  const payloadDirectory = manifestRelativePath === LEGACY_MANIFEST_PATH ? 'liveboard' : 'miniapp';
  return {
    manifestPath,
    ...(await readMiniAppManifest(root, value, mcpServerNames, payloadDirectory)),
  };
}

async function readMiniAppJson(root: CanonicalPluginRoot, relativePath: string) {
  try {
    return await readPluginJsonObject(root, relativePath, { portable: true });
  } catch (error) {
    if (error instanceof PluginReaderError) {
      miniAppFail('MANIFEST_INVALID', 'the referenced Mini App manifest is invalid or unavailable');
    }
    throw error;
  }
}

async function readOptionalPackageJson(
  root: CanonicalPluginRoot,
): Promise<Record<string, unknown> | undefined> {
  try {
    return (await readPluginJsonObject(root, PACKAGE_JSON_PATH, { portable: true })).value;
  } catch (error) {
    if (error instanceof PluginReaderError) return undefined;
    throw error;
  }
}

/** Reads the strict package authoring declaration shared by package scan and workspace update. */
export function readMiniAppMcode(value: unknown): string {
  if (!isRecord(value)) invalidMcode();
  if (value.schemaVersion === 1) {
    if (hasUnknownField(value, MCODE_V1_FIELDS)) invalidMcode();
    if (value.liveboard !== LEGACY_MANIFEST_LITERAL) {
      miniAppFail(
        'MCODE_SCHEMA_INVALID',
        `package.json#mcode.liveboard must equal ${LEGACY_MANIFEST_LITERAL}`,
      );
    }
    return LEGACY_MANIFEST_PATH;
  }
  if (value.schemaVersion === 2) {
    if (hasUnknownField(value, MCODE_V2_FIELDS)) invalidMcode();
    if (value.miniApp === MINIAPP_MANIFEST_LITERAL) return MINIAPP_MANIFEST_PATH;
    if (value.miniApp === LEGACY_MANIFEST_LITERAL) return LEGACY_MANIFEST_PATH;
    miniAppFail(
      'MCODE_SCHEMA_INVALID',
      `package.json#mcode.miniApp must equal ${MINIAPP_MANIFEST_LITERAL} or ${LEGACY_MANIFEST_LITERAL}`,
    );
  }
  invalidMcode();
}

function invalidMcode(): never {
  miniAppFail('MCODE_SCHEMA_INVALID', 'package.json#mcode must use strict schemaVersion 1 or 2');
}

function hasUnknownField(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !fields.has(key));
}

function miniAppFail(code: string, detail: string): never {
  readerFail(`MINIAPP_${code}`, detail);
}
