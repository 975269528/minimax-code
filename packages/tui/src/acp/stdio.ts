import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import { createTuiAcpAgent } from './agent.js';
import type { TuiAcpRuntime } from './runtime.js';

export interface ServeTuiAcpStdioOptions {
  readonly runtime: TuiAcpRuntime;
  readonly version: string;
  readonly input: Readable;
  readonly output: Writable;
  readonly signal?: AbortSignal;
}

export async function serveTuiAcpStdio(options: ServeTuiAcpStdioOptions): Promise<void> {
  const stream = acp.ndJsonStream(Writable.toWeb(options.output), Readable.toWeb(options.input));
  const connection = createTuiAcpAgent({
    runtime: options.runtime,
    version: options.version,
  }).connect(stream);
  const close = () => connection.close(options.signal?.reason);
  options.signal?.addEventListener('abort', close, { once: true });
  if (options.signal?.aborted) close();
  try {
    await connection.closed;
  } finally {
    options.signal?.removeEventListener('abort', close);
  }
}
