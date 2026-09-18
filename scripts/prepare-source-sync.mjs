import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExtraction, readInventory } from './lib/release-metadata.mjs';

function git(directory, args, options = {}) {
  const result = spawnSync('git', ['-C', directory, ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`Git operation failed: ${args[0]}`);
  return result.stdout;
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value) && value.split('/').every(p => p && p !== '.' && p !== '..');
}
function tree(directory, revision, roots) {
  const records = git(directory, ['ls-tree', '-r', '-z', revision, '--', ...roots]).toString('utf8').split('\0').filter(Boolean);
  return new Map(records.map(record => {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (!safePath(file)) throw new Error('Unsafe source path');
    return [file, { mode, type, oid }];
  }));
}
const same = (left, right) => left?.oid === right?.oid && left?.mode === right?.mode;
const regular = entry => entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode);

export function prepareSourceSync({ root, source, ref, out }) {
  root = realpathSync(root);
  source = realpathSync(source);
  out = path.resolve(out);
  out = path.join(realpathSync(path.dirname(out)), path.basename(out));
  if (within(root, source) || within(source, root)) throw new Error('Source and public repository must be separate');
  if (within(root, out) || within(source, out) || existsSync(out)) throw new Error('Output must be new and outside both repositories');
  const metadata = readExtraction(root);
  const inventory = readInventory(root).files;
  if (!Array.isArray(inventory) || !inventory.every(safePath) || !metadata.packageRoots.every(safePath)) throw new Error('Unsafe inventory');
  const resolve = revision => git(source, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]).toString('utf8').trim();
  const baseRevision = resolve(metadata.sourceRevision);
  const targetRevision = resolve(ref);
  const oldTree = tree(source, baseRevision, metadata.packageRoots);
  const newTree = tree(source, targetRevision, metadata.packageRoots);
  const inScope = file => metadata.packageRoots.some(p => file.startsWith(`${p}/`));
  const reviewed = new Set(inventory.filter(inScope));
  mkdirSync(out, { mode: 0o700 });
  writeFileSync(path.join(out, '.private-review'), 'Unreviewed source candidates. Do not publish this directory.\n', { mode: 0o600 });
  const entries = [];
  const blob = entry => git(source, ['cat-file', 'blob', entry.oid]);
  const save = (file, bytes, executable = false) => {
    const target = path.join(out, 'candidates', file);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: executable ? 0o700 : 0o600 });
  };
  for (const file of [...reviewed].sort()) {
    const before = oldTree.get(file), after = newTree.get(file);
    if (!before && !after) continue; // Public-only adaptation.
    if (same(before, after)) continue;
    const entry = { path: file, status: 'review-required' };
    if ((before && !regular(before)) || (after && !regular(after))) {
      entry.status = 'non-regular-review';
    } else if (!before) {
      entry.status = 'source-added-over-public-file';
    } else if (!existsSync(path.join(root, file))) {
      entry.status = 'public-file-missing';
    } else {
      const currentPath = path.join(root, file);
      if (!within(root, realpathSync(currentPath))) throw new Error('Public file resolves outside repository');
      const current = readFileSync(currentPath), original = blob(before);
      if (!after) entry.status = current.equals(original) ? 'delete-candidate' : 'delete-conflict';
      else {
        const next = blob(after);
        if (current.equals(next)) entry.status = 'already-synchronized';
        else if (current.equals(original)) {
          save(file, next, after.mode === '100755');
          entry.status = 'update-candidate';
        } else if ([current, original, next].some(buffer => buffer.includes(0))) {
          entry.status = 'binary-conflict';
        } else {
          // Git merges files only; no source hooks, scripts, credentials or history are executed/copied.
          const scratch = path.join(out, '.merge');
          mkdirSync(scratch, { recursive: true, mode: 0o700 });
          for (const [name, bytes] of [['public', current], ['base', original], ['source', next]]) writeFileSync(path.join(scratch, name), bytes, { mode: 0o600 });
          const merged = spawnSync('git', ['merge-file', '-p', '-L', 'public', '-L', 'base', '-L', 'source', ...['public', 'base', 'source'].map(name => path.join(scratch, name))], { maxBuffer: 64 * 1024 * 1024 });
          if (merged.error || merged.status === null || merged.status < 0 || merged.status > 127) throw new Error('Three-way merge failed');
          save(file, merged.stdout, after.mode === '100755');
          entry.status = merged.status === 0 ? 'merged-candidate' : 'merge-conflict';
        }
        if (before.mode !== after.mode) entry.modeChange = { before: before.mode, after: after.mode };
      }
    }
    entries.push(entry);
  }
  for (const file of [...newTree.keys()].sort()) {
    if (!reviewed.has(file) && !same(oldTree.get(file), newTree.get(file))) entries.push({ path: file, status: 'unlisted-source-review' });
  }
  const report = { schemaVersion: 1, baseRevision, targetRevision, entries };
  writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source', '--ref', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/prepare-source-sync.mjs --source <repository> --ref <commit> --out <new-private-directory>');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.source || !options.ref || !options.out) throw new Error('source, ref and out are required');
  const report = prepareSourceSync({ root: fileURLToPath(new URL('../', import.meta.url)), ...options });
  console.log(`Prepared ${report.entries.length} private review entries. Public source and baseline were not modified.`);
}
