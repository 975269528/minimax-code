import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const desktopMocks = vi.hoisted(() => ({
  createMatrixMcpRuntime: vi.fn(
    (options: { workspaceRoot: string }) =>
      ({
        tools: [],
        workspaceRoot: options.workspaceRoot,
        createContext: () => ({
          sessionId: 'test',
          turnId: 'test',
          workspaceRoot: options.workspaceRoot,
        }),
      }) as unknown,
  ),
  buildMatrixMcpToolDescriptors: vi.fn(() => [
    {
      name: 'web_search',
      description: 'Matrix web search',
      inputSchema: { type: 'object' },
    },
  ]),
  // Spread of importOriginal()'s `actual` does not cover this when the
  // dist build is stale (dist/desktop/ missing matrix-env.js after the
  // PI MCP src split) — declare an explicit mock so the test does not
  // depend on dist freshness.
  getDesktopMatrixEndpoint: vi.fn((env: NodeJS.ProcessEnv = {}) => {
    const region = env.MAVIS_REGION === 'cn' ? 'cn' : 'en';
    const buildEnv = env.MAVIS_BUILD_ENV === 'prod' ? 'prod' : 'test';
    const managed: Record<'en' | 'cn', Record<'test' | 'prod', string>> = {
      en: {
        test: 'https://matrix-overseas-test.example.invalid',
        prod: 'https://matrix-overseas.example.invalid',
      },
      cn: {
        test: 'https://matrix-test.example.invalid',
        prod: 'https://matrix.example.invalid',
      },
    };
    return { baseUrl: managed[region][buildEnv], managed: true };
  }),
}));

vi.mock('@mavis/agent-tools/desktop', () => ({
  createMatrixMcpRuntime: desktopMocks.createMatrixMcpRuntime,
  buildMatrixMcpToolDescriptors: desktopMocks.buildMatrixMcpToolDescriptors,
  getDesktopMatrixEndpoint: desktopMocks.getDesktopMatrixEndpoint,
}));

const ORIGINAL_ENV = {
  MAVIS_REGION: process.env.MAVIS_REGION,
  MAVIS_BUILD_ENV: process.env.MAVIS_BUILD_ENV,
  MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT: process.env.MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT,
};

function restoreEnv(key: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('builtin Matrix MCP server config', () => {
  beforeEach(() => {
    vi.resetModules();
    desktopMocks.createMatrixMcpRuntime.mockClear();
    desktopMocks.buildMatrixMcpToolDescriptors.mockClear();
    process.env.MAVIS_REGION = 'en';
    process.env.MAVIS_BUILD_ENV = 'test';
    process.env.MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT = process.execPath;
  });

  afterEach(() => {
    restoreEnv('MAVIS_REGION');
    restoreEnv('MAVIS_BUILD_ENV');
    restoreEnv('MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT');
  });

  it('marks the stdio child so packaged Electron runs it as Node', async () => {
    const { buildBuiltinMatrixServerConfig } = await import('./builtin-matrix.js');

    const config = buildBuiltinMatrixServerConfig({ workspaceRoot: '/workspace/current' });

    expect(config.env).toMatchObject({
      MAVIS_REGION: 'en',
      MAVIS_BUILD_ENV: 'test',
      MAVIS_MATRIX_WORKSPACE_ROOT: '/workspace/current',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it.each([undefined, 'qa'])(
    'omits an invalid raw build env from the Matrix child (%s)',
    async (buildEnv) => {
      if (buildEnv === undefined) delete process.env.MAVIS_BUILD_ENV;
      else process.env.MAVIS_BUILD_ENV = buildEnv;

      const { buildBuiltinMatrixServerConfig } = await import('./builtin-matrix.js');
      const config = buildBuiltinMatrixServerConfig({
        workspaceRoot: '/workspace/current',
        routingContext: { bedrockLane: 'lane-a' },
      });

      expect(config.env?.MAVIS_BUILD_ENV).toBeUndefined();
      expect(config.env?.MAVIS_MATRIX_BEDROCK_LANE).toBe('lane-a');
    },
  );

  it('uses the same Matrix runtime env for cached tool descriptors', async () => {
    const { buildBuiltinMatrixServerConfig } = await import('./builtin-matrix.js');

    buildBuiltinMatrixServerConfig({ workspaceRoot: '/workspace/current' });

    expect(desktopMocks.createMatrixMcpRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/workspace/current',
        baseUrl: 'https://matrix-overseas-test.example.invalid',
      }),
    );
  });

  it('keeps the Builtin Matrix web search name unprefixed for Local model tools', async () => {
    const { buildBuiltinMatrixServerConfig } = await import('./builtin-matrix.js');
    const { buildNativeToolName } = await import('./config.js');
    const config = buildBuiltinMatrixServerConfig({ workspaceRoot: '/workspace/current' });

    expect(config.tools?.map((tool) => tool.name)).toContain('web_search');
    expect(buildNativeToolName('matrix', 'web_search', config)).toBe('web_search');
  });

  it('narrows the built-in Matrix tools to web_search when webSearchOnly is set', async () => {
    // mcode-tools owns the media/generation Matrix tools but not web_search, so
    // the Matrix MCP is narrowed to web_search only. The descriptor list is
    // cached on first build, so a single mocked return covers both calls.
    desktopMocks.buildMatrixMcpToolDescriptors.mockReturnValueOnce([
      { name: 'web_search', description: 'Matrix web search', inputSchema: { type: 'object' } },
      {
        name: 'image_synthesize',
        description: 'Matrix image synthesize',
        inputSchema: { type: 'object' },
      },
    ]);
    const { buildBuiltinMatrixServerConfig } = await import('./builtin-matrix.js');

    const full = buildBuiltinMatrixServerConfig({ workspaceRoot: '/workspace/current' });
    expect(full.tools?.map((tool) => tool.name)).toEqual(['web_search', 'image_synthesize']);

    const narrowed = buildBuiltinMatrixServerConfig(
      { workspaceRoot: '/workspace/current' },
      { webSearchOnly: true },
    );
    expect(narrowed.tools?.map((tool) => tool.name)).toEqual(['web_search']);
  });

  it('injects the dataDir assets subtree — never the dataDir root — as extra input root (TS-10)', async () => {
    const { buildBuiltinMatrixServerConfig, buildBuiltinMatrixTokenOverrides } =
      await import('./builtin-matrix.js');
    const dataDir = join(tmpdir(), 'matrix-builtin-data');
    const expectedAssets = join(dataDir, 'v2', 'assets');

    const config = buildBuiltinMatrixServerConfig({ workspaceRoot: '/workspace/current', dataDir });
    const overrides = buildBuiltinMatrixTokenOverrides({
      workspaceRoot: '/workspace/current',
      dataDir,
      authContext: { accessToken: 'token' },
    });

    expect(config.env?.MAVIS_MATRIX_EXTRA_INPUT_ROOTS).toBe(expectedAssets);
    expect(overrides.env?.MAVIS_MATRIX_EXTRA_INPUT_ROOTS).toBe(expectedAssets);
  });

  it('omits the extra input root without dataDir and keeps connectionKey dataDir-free (TS-10)', async () => {
    const { buildBuiltinMatrixServerConfig, buildBuiltinMatrixTokenOverrides } =
      await import('./builtin-matrix.js');

    const config = buildBuiltinMatrixServerConfig({ workspaceRoot: '/workspace/current' });
    const without = buildBuiltinMatrixTokenOverrides({ workspaceRoot: '/workspace/current' });
    const withDataDir = buildBuiltinMatrixTokenOverrides({
      workspaceRoot: '/workspace/current',
      dataDir: join(tmpdir(), 'matrix-builtin-data'),
    });

    expect(config.env?.MAVIS_MATRIX_EXTRA_INPUT_ROOTS).toBeUndefined();
    expect(without.env?.MAVIS_MATRIX_EXTRA_INPUT_ROOTS).toBeUndefined();
    expect(withDataDir.connectionKey).toBe(without.connectionKey);
  });

  it('scopes the built-in Matrix child key by the managed routing lane', async () => {
    const { buildBuiltinMatrixTokenOverrides } = await import('./builtin-matrix.js');
    const base = { workspaceRoot: '/workspace/current', authContext: { accessToken: 'token' } };
    const clear = buildBuiltinMatrixTokenOverrides(base).connectionKey;
    const laneA = buildBuiltinMatrixTokenOverrides({
      ...base,
      routingContext: { bedrockLane: 'lane-a' },
    }).connectionKey;
    const laneB = buildBuiltinMatrixTokenOverrides({
      ...base,
      routingContext: { bedrockLane: 'lane-b' },
    }).connectionKey;

    expect(laneA).not.toBe(clear);
    expect(laneB).not.toBe(laneA);
    expect(laneB).not.toBe(clear);
  });

  it('does not resolve a missing Matrix stdio entrypoint', async () => {
    process.env.MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT = join(
      tmpdir(),
      `missing-matrix-mcp-stdio-${process.pid}.js`,
    );
    const { resolveMatrixMcpStdioEntrypoint } = await import('./builtin-matrix.js');

    expect(resolveMatrixMcpStdioEntrypoint()).toBeUndefined();
    expect(resolveMatrixMcpStdioEntrypoint()).toBeUndefined();
  });

  it('resolves an override Matrix stdio entrypoint when the file exists', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'matrix-mcp-entrypoint-'));
    try {
      const entrypoint = join(tmp, 'matrix-mcp-stdio.js');
      await writeFile(entrypoint, '#!/usr/bin/env node\n', 'utf8');
      process.env.MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT = entrypoint;
      const { resolveMatrixMcpStdioEntrypoint } = await import('./builtin-matrix.js');

      expect(resolveMatrixMcpStdioEntrypoint()).toBe(entrypoint);
      expect(resolveMatrixMcpStdioEntrypoint()).toBeTruthy();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('resolves the standalone Matrix stdio entrypoint next to cli.js', async () => {
    delete process.env.MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT;
    const tmp = await mkdtemp(join(tmpdir(), 'matrix-mcp-bundled-entrypoint-'));
    try {
      const cliEntry = join(tmp, 'cli.js');
      const entrypoint = join(tmp, 'matrix-mcp-stdio.js');
      await writeFile(cliEntry, '#!/usr/bin/env node\n', 'utf8');
      await writeFile(entrypoint, '#!/usr/bin/env node\n', 'utf8');
      const { resolveMatrixMcpStdioEntrypoint } = await import('./builtin-matrix.js');

      expect(resolveMatrixMcpStdioEntrypoint(pathToFileURL(cliEntry).href)).toBe(entrypoint);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps resolving the packaged Electron Matrix stdio entrypoint from agent-tools', async () => {
    delete process.env.MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT;
    const tmp = await mkdtemp(join(tmpdir(), 'matrix-mcp-electron-entrypoint-'));
    try {
      const runtimeEntry = join(
        tmp,
        'node_modules/@mavis/local-runtime-v2/dist/service/mcp/runtime/builtin-matrix.js',
      );
      const entrypoint = join(
        tmp,
        'node_modules/@mavis/agent-tools/dist/desktop/matrix-mcp-stdio.js',
      );
      await mkdir(dirname(entrypoint), { recursive: true });
      await writeFile(entrypoint, '#!/usr/bin/env node\n', 'utf8');
      const { resolveMatrixMcpStdioEntrypoint } = await import('./builtin-matrix.js');

      expect(resolveMatrixMcpStdioEntrypoint(pathToFileURL(runtimeEntry).href)).toBe(entrypoint);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
