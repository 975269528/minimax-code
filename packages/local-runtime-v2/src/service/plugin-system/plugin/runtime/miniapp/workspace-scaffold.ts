import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Rasterized from the UI UsageIcon so the runtime scaffold stays independent of React/UI assets.
const DEFAULT_MINIAPP_ICON_PNG = Buffer.from(
  [
    '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',
  ].join(''),
  'base64',
);

interface WorkspaceScaffoldFile {
  readonly relativePath: string;
  readonly content: string | Buffer;
}

/** Writes the deterministic, reader-valid starting point for one workspace MiniApp. */
export async function writeWorkspaceMiniAppScaffold(
  packageRoot: string,
  pluginId: string,
): Promise<void> {
  for (const file of workspaceScaffoldFiles(pluginId)) {
    const target = path.join(packageRoot, ...file.relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { flag: 'wx' });
  }
}

function workspaceScaffoldFiles(pluginId: string): readonly WorkspaceScaffoldFile[] {
  return [
    {
      relativePath: '.minimax-plugin/plugin.json',
      content: json({
        schemaVersion: 1,
        name: pluginId,
        displayName: pluginId,
        version: '1.0.0',
        description: `${pluginId} Mini App`,
        author: 'User',
        icon: 'icon.png',
        category: 'Other',
        exampleQueries: [],
        apps: [],
        mcpServers: [],
        skills: [],
      }),
    },
    {
      relativePath: 'package.json',
      content: json({
        mcode: {
          schemaVersion: 2,
          miniApp: './miniapp/miniapp.json',
        },
      }),
    },
    { relativePath: 'icon.png', content: DEFAULT_MINIAPP_ICON_PNG },
    {
      relativePath: 'miniapp/miniapp.json',
      content: json({
        schemaVersion: 1,
        artifacts: {
          client: ['./miniapp/client'],
          node: ['./miniapp/node'],
        },
        runtime: {
          kind: 'process',
          entry: './miniapp/node/server.mjs',
          lifecycle: 'on-demand',
        },
        surface: { path: '/dashboard' },
        mcpEndpoints: [],
      }),
    },
    {
      relativePath: 'miniapp/client/index.html',
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pluginId}</title>
  </head>
  <body>
    <main id="app">${pluginId}</main>
  </body>
</html>
`,
    },
    {
      relativePath: 'miniapp/node/server.mjs',
      content: NODE_ENTRY,
    },
  ];
}

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

const NODE_ENTRY = `import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

export async function start(context) {
  const clientEntry = await readFile(join(context.pluginRoot, 'miniapp/client/index.html'));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    if (request.method === 'GET' && url.pathname === '/dashboard') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(clientEntry);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  let disposal;
  const dispose = () => {
    if (disposal) return disposal;
    context.signal.removeEventListener('abort', onAbort);
    disposal = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return disposal;
  };
  const onAbort = () => {
    void dispose().catch(() => undefined);
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}
`;
