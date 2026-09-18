import {
  parsePluginHookDocuments,
  type PluginHookCommandHandler,
  type PluginHookSourceFormat,
} from '@mavis/plugin-hooks';

import type { CanonicalPluginRoot } from '../filesystem.js';
import type { PluginReaderDiagnostic } from '../types.js';
import { projectPluginHookDiagnostics } from './diagnostics.js';
import { loadPluginHookDocuments } from './documents.js';

export async function readPluginHooks(
  root: CanonicalPluginRoot,
  input: {
    readonly pluginName: string;
    readonly declared: unknown;
    readonly sourceFormat: PluginHookSourceFormat;
    readonly defaultPath?: string;
    readonly manifestPath?: string;
  },
): Promise<{ hooks: readonly PluginHookCommandHandler[]; diagnostics: PluginReaderDiagnostic[] }> {
  const documents = await loadPluginHookDocuments(root, input.declared, {
    ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}),
    ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
  });
  const parsed = parsePluginHookDocuments({
    pluginName: input.pluginName,
    pluginRoot: root.path,
    sourceFormat: input.sourceFormat,
    documents,
  });
  return {
    hooks: parsed.handlers,
    diagnostics: projectPluginHookDiagnostics(parsed.diagnostics),
  };
}
