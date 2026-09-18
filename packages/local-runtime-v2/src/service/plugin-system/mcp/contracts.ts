import type { PluginMcpServer, PluginReaderDiagnostic } from '../plugin/package/types.js';

export interface ParsedMcpServers {
  readonly servers: readonly PluginMcpServer[];
  readonly diagnostics: readonly PluginReaderDiagnostic[];
}
