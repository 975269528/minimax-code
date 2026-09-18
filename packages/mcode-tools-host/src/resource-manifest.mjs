import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const NATIVE_PATHS = [
  'native/registry-js.LICENSE',
  'native/win32-arm64/registry.node',
  'native/win32-ia32/registry.node',
  'native/win32-x64/registry.node',
];

/**
 * Shared by runtime validation and source-based packaging scripts. Schema 3
 * remains valid for existing staging/prod locks; schema 4 permits only the
 * registry-js prebuilds needed by the CLI's own system proxy discovery.
 * @param {unknown} value
 * @returns {{ path: string, sha256: string }[]}
 */
export function validateEmbeddedResourceManifest(value) {
  if (!value || typeof value !== 'object') throw new Error('mcode-tools manifest is invalid');
  const manifest = /** @type {Record<string, unknown>} */ (value);
  const native = manifest.nativePackages;
  if (
    (manifest.schemaVersion !== 3 && manifest.schemaVersion !== 4) ||
    manifest.entry !== 'cli.mjs'
  ) {
    throw new Error('mcode-tools resource manifest schema is incompatible');
  }
  const modern = manifest.schemaVersion === 4;
  if (!Array.isArray(native) || (modern ? native.length !== 1 : native.length !== 0)) {
    throw new Error('mcode-tools manifest contains unsupported native resources');
  }
  if (
    modern &&
    (native[0]?.name !== 'registry-js' ||
      native[0]?.napiVersion !== 3 ||
      typeof native[0]?.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/u.test(native[0].version))
  ) {
    throw new Error('mcode-tools manifest contains unsupported native resources');
  }
  const resources = manifest.resources;
  const expected = ['cli.mjs', ...(modern ? NATIVE_PATHS : [])].sort();
  if (
    !Array.isArray(resources) ||
    resources.length !== expected.length ||
    resources.some(
      (item) =>
        !item ||
        typeof item.path !== 'string' ||
        typeof item.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(item.sha256),
    ) ||
    resources[0]?.path !== 'cli.mjs' ||
    JSON.stringify(resources.map((item) => item.path).sort()) !== JSON.stringify(expected)
  ) {
    throw new Error('mcode-tools resource manifest paths or hashes are invalid');
  }
  return resources;
}

/** @param {string} rootDir @param {unknown} manifest */
export function validateEmbeddedResourceFiles(rootDir, manifest) {
  const resources = validateEmbeddedResourceManifest(manifest);
  const expected = ['manifest.json', ...resources.map((item) => item.path)].sort();
  const actual = listFiles(rootDir).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('mcode-tools embedded output must contain only declared resources');
  }
  for (const resource of resources) {
    const bytes = readFileSync(path.join(rootDir, resource.path));
    if (createHash('sha256').update(bytes).digest('hex') !== resource.sha256) {
      throw new Error(`mcode-tools ${resource.path} sha256 does not match its manifest`);
    }
  }
}

/** @param {string} rootDir @param {string} [relativeDir] @returns {string[]} */
function listFiles(rootDir, relativeDir = '') {
  const directory = path.join(rootDir, relativeDir);
  if (lstatSync(directory).isSymbolicLink())
    throw new Error('mcode-tools resources must not use symlinks');
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('mcode-tools resources must not use symlinks');
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!NATIVE_PATHS.some((file) => file.startsWith(`${relative}/`))) {
        throw new Error('mcode-tools resource directory is not allowed');
      }
      return listFiles(rootDir, relative);
    }
    if (!entry.isFile()) throw new Error('mcode-tools resources must be regular files');
    return [relative];
  });
}
