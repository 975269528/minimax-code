export interface PluginSystemErrorOptions extends ErrorOptions {
  readonly reasonCode?: string;
}

export class PluginSystemError extends Error {
  declare readonly reasonCode?: string;

  constructor(
    readonly code: string,
    message: string,
    options?: PluginSystemErrorOptions,
  ) {
    super(message, options);
    this.name = 'PluginSystemError';
    if (options?.reasonCode !== undefined) this.reasonCode = options.reasonCode;
  }
}
