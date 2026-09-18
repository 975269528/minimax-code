import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validateEmbeddedResourceFiles,
  validateEmbeddedResourceManifest,
} from '../../src/resource-manifest.mjs';

const names = [
  'cli.mjs',
  'native/registry-js.LICENSE',
  ...['arm64', 'ia32', 'x64'].map((arch) => `native/win32-${arch}/registry.node`),
];
let root: string;
let manifest: {
  schemaVersion: number;
  entry: string;
  nativePackages: { name: string; version: string; napiVersion: number }[];
  resources: { path: string; sha256: string }[];
};
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcode-manifest-'));
  manifest = {
    schemaVersion: 4,
    entry: 'cli.mjs',
    nativePackages: [{ name: 'registry-js', version: '1.16.1', napiVersion: 3 }],
    resources: [],
  };
  for (const name of names) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), name);
    manifest.resources.push({
      path: name,
      sha256: createHash('sha256').update(name).digest('hex'),
    });
  }
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('embedded native resource contract', () => {
  it('accepts declared registry-js resources', () =>
    expect(() => validateEmbeddedResourceFiles(root, manifest)).not.toThrow());
  it('rejects native corruption before the CLI is started', () => {
    writeFileSync(path.join(root, names[2]!), 'changed');
    expect(() => validateEmbeddedResourceFiles(root, manifest)).toThrow(/sha256/u);
  });
  it.each(['../outside.node', '/absolute.node', 'native/unknown.node', 'cli.mjs'])(
    'rejects unexpected or duplicate path %s',
    (name) => {
      manifest.resources[2]!.path = name;
      expect(() => validateEmbeddedResourceManifest(manifest)).toThrow(/paths/u);
    },
  );
  it('rejects a missing architecture', () => {
    rmSync(path.join(root, names[2]!));
    expect(() => validateEmbeddedResourceFiles(root, manifest)).toThrow(/declared resources/u);
  });
  it('rejects unapproved native packages', () => {
    manifest.nativePackages[0]!.name = '@napi-rs/keyring';
    expect(() => validateEmbeddedResourceManifest(manifest)).toThrow(/native resources/u);
  });
  it.skipIf(process.platform === 'win32')('rejects symlinked native resources', () => {
    rmSync(path.join(root, names[2]!));
    symlinkSync(path.join(root, 'cli.mjs'), path.join(root, names[2]!));
    expect(() => validateEmbeddedResourceFiles(root, manifest)).toThrow(/symlinks/u);
  });
  it('keeps legacy schema 3 valid', () => {
    rmSync(path.join(root, 'native'), { recursive: true });
    manifest.schemaVersion = 3;
    manifest.nativePackages = [];
    manifest.resources = [manifest.resources[0]!];
    expect(() => validateEmbeddedResourceFiles(root, manifest)).not.toThrow();
  });
});
