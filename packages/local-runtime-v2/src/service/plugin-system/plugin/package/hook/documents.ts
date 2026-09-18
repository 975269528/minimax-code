import {
  isRecord,
  pluginPathExists,
  readPluginJsonObject,
  resolvePluginFile,
  type CanonicalPluginRoot,
} from '../filesystem.js';

export interface PluginHookDocument {
  readonly sourcePath: string;
  readonly value: unknown;
}

export async function loadPluginHookDocuments(
  root: CanonicalPluginRoot,
  declared: unknown,
  options: { readonly defaultPath?: string; readonly manifestPath?: string },
): Promise<PluginHookDocument[]> {
  if (isRecord(declared) && !isPathDeclaration(declared)) {
    return [{ sourcePath: options.manifestPath ?? '<manifest>', value: declared }];
  }

  const { paths, invalid } = readPathDeclaration(declared);
  await addDefaultPath(root, declared, options.defaultPath, paths);
  const documents: PluginHookDocument[] = [];
  if (invalid) {
    documents.push({ sourcePath: options.manifestPath ?? '<manifest>', value: undefined });
  }
  const seenFiles = new Set<string>();
  for (const relativePath of paths) {
    try {
      const file = await resolvePluginFile(root, relativePath);
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
    } catch {
      // Preserve the bounded invalid-document diagnostic from readHookDocument.
    }
    documents.push(await readHookDocument(root, relativePath));
  }
  return documents;
}

async function addDefaultPath(
  root: CanonicalPluginRoot,
  declared: unknown,
  defaultPath: string | undefined,
  paths: string[],
): Promise<void> {
  if (paths.length > 0 || declared !== undefined || !defaultPath) return;
  if (await pluginPathExists(root, defaultPath, 'file')) paths.push(defaultPath);
}

async function readHookDocument(
  root: CanonicalPluginRoot,
  relativePath: string,
): Promise<PluginHookDocument> {
  try {
    const { value } = await readPluginJsonObject(root, relativePath);
    return { sourcePath: relativePath, value };
  } catch {
    return { sourcePath: relativePath, value: undefined };
  }
}

function isPathDeclaration(value: Record<string, unknown>): boolean {
  return typeof value.path === 'string';
}

function readPathDeclaration(value: unknown): { paths: string[]; invalid: boolean } {
  if (value === undefined) return { paths: [], invalid: false };
  const direct = declaredPath(value);
  if (direct) return { paths: [direct], invalid: false };
  if (!Array.isArray(value)) return { paths: [], invalid: true };
  const paths: string[] = [];
  let invalid = false;
  for (const item of value) {
    const path = declaredPath(item);
    if (path) paths.push(path);
    else invalid = true;
  }
  return { paths, invalid };
}

function declaredPath(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path.trim()) return undefined;
  return value.path.trim();
}
