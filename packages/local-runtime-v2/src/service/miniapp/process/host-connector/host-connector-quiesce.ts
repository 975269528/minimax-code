import type { HostProcessConnectorGateway } from '../../../host-connector-system/index.js';
import type { MiniAppHostConnectorQuiesceAttempt } from '../../contracts.js';
import { HostConnectorProtocolError } from './host-connector-ndjson.js';

type HostConnectorSessionState =
  | 'candidate'
  | 'active'
  | 'quiescing'
  | 'stale'
  | 'draining'
  | 'retired';

type HostConnectorSessionGate = 'open' | 'unavailable' | 'service-restarted';

export class HostConnectorSessionLifecycle {
  #state: HostConnectorSessionState = 'candidate';
  #everActivated = false;
  #activeQuiesce: symbol | undefined;

  isRetired(): boolean {
    return this.#state === 'retired';
  }

  isActive(): boolean {
    return this.#state === 'active';
  }

  gate(): HostConnectorSessionGate {
    if (this.#state === 'candidate' || this.#state === 'active') return 'open';
    return this.#everActivated ? 'service-restarted' : 'unavailable';
  }

  activate(): void {
    if (this.#state !== 'candidate') {
      throw new HostConnectorProtocolError('Host Connector cannot activate');
    }
    this.#everActivated = true;
    this.#state = 'active';
  }

  beginRetirement(): boolean {
    if (this.#state === 'retired') return false;
    this.#activeQuiesce = undefined;
    this.#state = 'draining';
    return true;
  }

  markRetired(): void {
    this.#state = 'retired';
  }

  beginQuiesce(input: {
    readonly pending: readonly Promise<void>[];
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
    readonly commit: () => void;
  }): MiniAppHostConnectorQuiesceAttempt {
    if (this.#state !== 'active') {
      throw new HostConnectorProtocolError('Host Connector cannot quiesce');
    }
    const token = Symbol('host-connector-quiesce');
    this.#activeQuiesce = token;
    this.#state = 'quiescing';
    let drained = false;
    const result = this.#recordQuiescence({
      token,
      pending: Promise.allSettled(input.pending),
      deadlineMs: input.deadlineMs,
      signal: input.signal,
      markDrained: () => {
        drained = true;
      },
    });
    return {
      result,
      resume: () => {
        if (!this.#ownsQuiesce(token)) return false;
        this.#activeQuiesce = undefined;
        this.#state = 'active';
        return true;
      },
      commit: async () => {
        if (!drained || !this.#ownsQuiesce(token)) {
          throw new HostConnectorProtocolError('Host Connector quiesce is not drained');
        }
        this.#activeQuiesce = undefined;
        this.#state = 'stale';
        input.commit();
      },
    };
  }

  #ownsQuiesce(token: symbol): boolean {
    return this.#activeQuiesce === token && this.#state === 'quiescing';
  }

  async #recordQuiescence(input: {
    readonly token: symbol;
    readonly pending: Promise<unknown>;
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
    readonly markDrained: () => void;
  }): Promise<'drained' | 'busy'> {
    const outcome = await waitForHostConnectorQuiescence(
      input.pending,
      input.deadlineMs,
      input.signal,
    );
    if (outcome !== 'drained' || !this.#ownsQuiesce(input.token)) return 'busy';
    input.markDrained();
    return 'drained';
  }
}

export function createHostConnectorGatewayRelease(
  gateway: Pick<HostProcessConnectorGateway, 'releaseHostProcess'>,
  identity: { readonly pluginId: string; readonly processGeneration: string },
): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gateway.releaseHostProcess({
      pluginId: identity.pluginId,
      processGeneration: identity.processGeneration,
    });
  };
}

async function waitForHostConnectorQuiescence(
  operation: Promise<unknown>,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<'drained' | 'busy'> {
  if (signal?.aborted || deadlineMs <= Date.now()) return 'busy';
  let timer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      resolvesDrained(operation),
      new Promise<'busy'>((resolve) => {
        timer = setTimeout(() => resolve('busy'), Math.max(0, deadlineMs - Date.now()));
        timer.unref();
      }),
      ...(signal
        ? [
            new Promise<'busy'>((resolve) => {
              const onAbort = () => resolve('busy');
              signal.addEventListener('abort', onAbort, { once: true });
              removeAbortListener = () => signal.removeEventListener('abort', onAbort);
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

async function resolvesDrained(operation: Promise<unknown>): Promise<'drained'> {
  await operation;
  return 'drained';
}
