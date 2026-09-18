export class PluginReaderError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PluginReaderError';
  }
}

export function readerFail(code: string, detail: string): never {
  throw new PluginReaderError(code, detail);
}
