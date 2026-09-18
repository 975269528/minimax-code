export class LocalMcpSettingsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    message: string,
    readonly code:
      | 'MCP_CONFIG_INVALID'
      | 'MCP_SERVER_NOT_FOUND'
      | 'MCP_SERVER_EXISTS'
      | 'MCP_STORAGE_READ_FAILED'
      | 'MCP_STORAGE_WRITE_FAILED',
  ) {
    super(message);
    this.name = 'LocalMcpSettingsError';
  }
}
