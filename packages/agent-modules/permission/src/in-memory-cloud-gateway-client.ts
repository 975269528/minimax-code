/**
 * InMemoryCloudGatewayClient — deterministic test double for
 * {@link CloudGatewayClient}.
 *
 * Used by:
 *   - unit tests exercising the on-request-llm code path without hitting
 *     the real cloud endpoint
 *   - E2E archon-real-chain when running in CI without a managed token
 *   - dev / non-managed daemons as a "fail open to ask-user" default
 *
 * Two construction modes:
 *
 *   1. Static verdict: every classify() returns the same verdict
 *      (typical for unit tests asserting "gateway said allow / confirm /
 *       block / timeout, what does service do?").
 *
 *   2. Function verdict: a callable that inspects the request and picks a
 *      verdict (typical for matrix tests covering multiple commands in one
 *      describe block).
 *
 * Records every request so tests can assert:
 *   - the gateway was (or was not) called
 *   - the conversationContext field is populated
 *   - the request payload matches the expected shape
 */

import type {
  CloudClassifyRequest,
  CloudClassifyVerdict,
  CloudGatewayClient,
} from './cloud-gateway.js';

type VerdictPicker = (req: CloudClassifyRequest) => CloudClassifyVerdict;

export interface InMemoryCloudGatewayClientOptions {
  /** Static verdict OR a function that decides per request. */
  verdict?: CloudClassifyVerdict | VerdictPicker;
  /** Synthesize a delay (ms) before resolving — for timeout testing. */
  delayMs?: number;
}

export class InMemoryCloudGatewayClient implements CloudGatewayClient {
  /** All requests seen, in order. Test assertion surface. */
  readonly requests: CloudClassifyRequest[] = [];

  private readonly picker: VerdictPicker;
  private readonly delayMs: number;

  constructor(opts: InMemoryCloudGatewayClientOptions = {}) {
    const v = opts.verdict ?? defaultTimeout();
    this.picker = typeof v === 'function' ? v : () => v;
    this.delayMs = opts.delayMs ?? 0;
  }

  async classify(req: CloudClassifyRequest): Promise<CloudClassifyVerdict> {
    this.requests.push(req);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return this.picker(req);
  }

  /** Reset the recorded request log. */
  clear(): void {
    this.requests.length = 0;
  }
}

function defaultTimeout(): CloudClassifyVerdict {
  return {
    kind: 'timeout',
    reasonLocalized: 'in-memory cloud gateway default: no verdict configured',
  };
}
