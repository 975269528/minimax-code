import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McodeUpdateService, type McodeUpdateDependencies } from '../../src/update/service.js';
import type { McodeReleaseManifestV1 } from '../../src/update/release.js';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mcode-update-test-'));
  temporaryRoots.push(root);
  return root;
}

function releaseFixture(version = '1.2.4', artifact = Buffer.from('signed artifact bytes')) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: McodeReleaseManifestV1 = {
    schemaVersion: 1,
    product: 'minimax-code',
    channel: 'stable',
    version,
    publishedAt: '2026-07-27T00:00:00.000Z',
    minNodeVersion: '22.19.0',
    registry: 'https://registry.example.test/',
    installArtifact: {
      url: `https://downloads.example.test/releases/${version}/mcode.tgz`,
      sha256: createHash('sha256').update(artifact).digest('hex'),
      size: artifact.length,
    },
    targets: {
      'darwin-arm64': { sha256: 'a'.repeat(64), size: 1 },
      'darwin-x64': { sha256: 'b'.repeat(64), size: 1 },
      'linux-x64': { sha256: 'c'.repeat(64), size: 1 },
      'windows-x64': { sha256: 'd'.repeat(64), size: 1 },
      'windows-arm64': { sha256: 'e'.repeat(64), size: 1 },
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    manifest,
    manifestBytes,
    signature: sign(null, manifestBytes, privateKey).toString('base64'),
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    artifact,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('McodeUpdateService', () => {
  it('checks a signed channel manifest without mutating the install root', async () => {
    const root = temporaryRoot();
    const fixture = releaseFixture();
    const fetchBytes = vi.fn(async (url: string) =>
      url.endsWith('.sig') ? Buffer.from(fixture.signature) : fixture.manifestBytes,
    );
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: { fetchBytes },
    });

    await expect(service.check({ channel: 'stable' })).resolves.toMatchObject({
      status: 'available',
      currentVersion: '1.2.3',
      latestVersion: '1.2.4',
      channel: 'stable',
    });
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(root, 'update.json'))).toBe(false);
  });

  it.each([
    new Error('offline'),
    Object.assign(new Error('timed out'), { name: 'AbortError' }),
    new Error('release server returned HTTP 503'),
  ])(
    'reports network and service failures without changing the active version',
    async (failure) => {
      const root = temporaryRoot();
      const currentFile = path.join(root, 'current');
      const dependencies: Partial<McodeUpdateDependencies> = {
        fetchBytes: vi.fn(async () => {
          throw failure;
        }),
      };
      const service = new McodeUpdateService({
        currentVersion: '1.2.3',
        installRoot: root,
        dependencies,
      });

      await expect(service.check({ channel: 'stable', timeoutMs: 100 })).rejects.toThrow();
      expect(() => readFileSync(currentFile, 'utf8')).toThrow();
    },
  );

  it('keeps the previous current pointer when install validation fails', async () => {
    const root = temporaryRoot();
    const fixture = releaseFixture();
    const dependencies: Partial<McodeUpdateDependencies> = {
      fetchBytes: vi.fn(async (url: string) =>
        url.endsWith('.sig')
          ? Buffer.from(fixture.signature)
          : url.endsWith('.tgz')
            ? Buffer.from('wrong bytes')
            : fixture.manifestBytes,
      ),
      installArtifact: vi.fn(async () => undefined),
      validateInstalledVersion: vi.fn(async () => undefined),
    };
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies,
    });

    await expect(service.apply({ channel: 'stable' })).rejects.toThrow(/checksum/i);
    expect(() => readFileSync(path.join(root, 'current'), 'utf8')).toThrow();
    expect(dependencies.installArtifact).not.toHaveBeenCalled();
  });

  it('activates only after staging installation and validation succeed', async () => {
    const root = temporaryRoot();
    const fixture = releaseFixture();
    const installArtifact = vi.fn(async () => undefined);
    const validateInstalledVersion = vi.fn(async () => undefined);
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
        installArtifact,
        validateInstalledVersion,
      },
    });

    await expect(service.apply({ channel: 'stable' })).resolves.toMatchObject({
      applied: true,
      latestVersion: '1.2.4',
    });
    expect(installArtifact).toHaveBeenCalledOnce();
    expect(validateInstalledVersion).toHaveBeenCalled();
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.4\n');
    expect(existsSync(path.join(root, 'versions', '1.2.4'))).toBe(true);
  });

  it('preserves an existing active pointer when staged install validation fails', async () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'current'), '1.2.3\n');
    const fixture = releaseFixture();
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
        installArtifact: vi.fn(async () => undefined),
        validateInstalledVersion: vi.fn(async () => {
          throw new Error('installed binary smoke failed');
        }),
      },
    });

    await expect(service.apply({ channel: 'stable' })).rejects.toThrow(/previous version/i);
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n');
    expect(existsSync(path.join(root, 'versions', '1.2.4'))).toBe(false);
  });

  it('requires the explicit --to option before downgrading from a channel', async () => {
    const root = temporaryRoot();
    const fixture = releaseFixture('1.2.2');
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig') ? Buffer.from(fixture.signature) : fixture.manifestBytes,
        ),
      },
    });

    await expect(service.apply({ channel: 'stable' })).rejects.toThrow(/--to/);
  });

  it('cancels before activation and keeps the previous active version unchanged', async () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'current'), '1.2.3\n');
    const fixture = releaseFixture();
    const controller = new AbortController();
    const phases: string[] = [];
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
      },
    });

    await expect(
      service.apply({
        channel: 'stable',
        signal: controller.signal,
        onPhase: (event) => {
          phases.push(`${event.phase}:${String(event.cancellable)}`);
          if (event.phase === 'downloading') controller.abort();
        },
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(phases).toContain('downloading:true');
    expect(phases).not.toContain('activating:false');
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n');
    expect(existsSync(path.join(root, 'versions', '1.2.4'))).toBe(false);
  });

  it('locks cancellation at atomic activation and completes the pointer swap', async () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'current'), '1.2.3\n');
    const fixture = releaseFixture();
    const controller = new AbortController();
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
        installArtifact: vi.fn(async () => undefined),
        validateInstalledVersion: vi.fn(async () => undefined),
      },
    });

    await expect(
      service.apply({
        channel: 'stable',
        signal: controller.signal,
        onPhase: (event) => {
          if (event.phase === 'activating') {
            expect(event.cancellable).toBe(false);
            controller.abort();
          }
        },
      }),
    ).resolves.toMatchObject({ applied: true, latestVersion: '1.2.4' });
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.4\n');
  });

  it('waits for installation to finish naturally before honoring cancellation', async () => {
    const root = temporaryRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'current'), '1.2.3\n');
    const fixture = releaseFixture();
    const controller = new AbortController();
    let finishInstall: (() => void) | undefined;
    const installArtifact = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    );
    const service = new McodeUpdateService({
      currentVersion: '1.2.3',
      installRoot: root,
      publicKey: fixture.publicKey,
      dependencies: {
        fetchBytes: vi.fn(async (url: string) =>
          url.endsWith('.sig')
            ? Buffer.from(fixture.signature)
            : url.endsWith('.tgz')
              ? fixture.artifact
              : fixture.manifestBytes,
        ),
        installArtifact,
        validateInstalledVersion: vi.fn(async () => undefined),
      },
    });

    const apply = service.apply({
      channel: 'stable',
      signal: controller.signal,
      onPhase: (event) => {
        if (event.phase === 'installing') {
          expect(event.cancellable).toBe(false);
          controller.abort();
        }
      },
    });
    await vi.waitFor(() => expect(installArtifact).toHaveBeenCalledOnce());
    expect(installArtifact).toHaveBeenCalledWith(
      expect.not.objectContaining({ signal: expect.anything() }),
    );
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n');

    finishInstall?.();
    await expect(apply).rejects.toThrow(/cancelled/i);
    expect(readFileSync(path.join(root, 'current'), 'utf8')).toBe('1.2.3\n');
    expect(existsSync(path.join(root, 'versions', '1.2.4'))).toBe(false);
  });
});
