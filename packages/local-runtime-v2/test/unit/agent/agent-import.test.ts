import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);

it('rejects unterminated TOML comments without blocking agent import', () => {
  const serviceUrl = new URL('../../../src/service/agent/application/agent-import.ts', import.meta.url);
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  // A synchronous parser loop cannot be interrupted by a Vitest timeout.
  // Run the real import service in a directly owned, killable child process.
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(require.resolve('tsx')).href,
    '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { AgentImportService } from ${JSON.stringify(serviceUrl.href)};
      const service = new AgentImportService();
      assert.equal(service.preview('codex', 'name="sample"').proposedName, 'sample');
      for (const content of ['a=[1 #', 'a={b=1 #']) {
        assert.throws(() => service.preview('codex', content), {
          code: 'AGENT_CONFIG_INVALID',
        });
      }
      console.log('import-rejected-malformed-toml');
    `,
  ], {
    cwd: root,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../tsconfig.standalone.json', import.meta.url)),
    },
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('import-rejected-malformed-toml');
}, 15_000);
