import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Parser } from 'tar';

export const MCODE_TOOLS_ARTIFACT = Object.freeze({
  url: 'https://registry.npmjs.org/@minimax-ai/code/-/code-0.3.11.tgz',
  integrity: 'sBOd8yvQRVuQNoGvzCDwXKaj5rQxLI3gKnojWS4+0wnMU9IXtxObSqbfBxz30Lze/zitRtSG2v76iJGHOmHRUA==',
  version: '0.0.4',
  sha256: 'e5a59ec5362e395b519317ad6fecd99f6e92308b9d985be44b64eb2f2b73a722',
});

// Extract unchanged artifacts from the public release package without running package scripts or extracting other files to disk.
export async function extractMcodeToolsArtifact(bytes) {
  if (createHash('sha512').update(bytes).digest('base64') !== MCODE_TOOLS_ARTIFACT.integrity)
    throw new Error('Public MCode archive integrity mismatch.');
  const files = new Map();
  const prefix = 'package/embedded/mcode-tools/';
  await new Promise((resolve, reject) => {
    const parser = new Parser({
      strict: true,
      onReadEntry(entry) {
        if (![`${prefix}cli.mjs`, `${prefix}manifest.json`, 'package/THIRD_PARTY_NOTICES.md'].includes(entry.path)) {
          entry.resume();
          return;
        }
        if (entry.type !== 'File' || files.has(entry.path)) {
          reject(new Error('Unexpected mcode-tools archive entry.'));
          entry.resume();
          return;
        }
        const chunks = [];
        entry.on('data', chunk => chunks.push(chunk));
        entry.on('end', () => files.set(entry.path, Buffer.concat(chunks)));
      },
    });
    parser.on('error', reject);
    parser.on('end', resolve);
    Readable.from([bytes]).pipe(parser);
  });
  const cli = files.get(`${prefix}cli.mjs`);
  const manifestBytes = files.get(`${prefix}manifest.json`);
  const notices = files.get('package/THIRD_PARTY_NOTICES.md');
  if (!cli || !manifestBytes || !notices) throw new Error('Public archive is missing mcode-tools or its notices.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.version !== MCODE_TOOLS_ARTIFACT.version || manifest.buildEnv !== 'prod' ||
      manifest.entry !== 'cli.mjs' || manifest.packageName !== '@minimax/mcode-tools' ||
      createHash('sha256').update(cli).digest('hex') !== MCODE_TOOLS_ARTIFACT.sha256)
    throw new Error('Embedded mcode-tools manifest or entry integrity mismatch.');
  return { cli, manifest: manifestBytes, notices };
}

export async function copyMcodeToolsArtifact(root, outdir, fetchImpl = fetch) {
  const cache = path.join(root, '.cache', 'artifacts', 'code-0.3.11.tgz');
  let bytes;
  try { bytes = await readFile(cache); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetchImpl(MCODE_TOOLS_ARTIFACT.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Cannot download public mcode-tools artifact: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const artifact = await extractMcodeToolsArtifact(bytes);
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, bytes);
  const destination = path.join(outdir, 'embedded', 'mcode-tools');
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'cli.mjs'), artifact.cli);
  await writeFile(path.join(destination, 'manifest.json'), artifact.manifest);
  await writeFile(path.join(outdir, 'MCODE_TOOLS_NOTICES.md'), artifact.notices);
}
