/**
 * Default WeChat runtime SDK stub.
 *
 * Slice 2 ships the {@link WeChatRuntimeSdk} *contract* but defers the
 * production wiring (which depends on `sdk/index.ts`, which in turn
 * uses Electron's `net` module) to a follow-up MR. Until then, the host
 * registers this no-op stub so:
 *
 *   1. The unified adapter contract is in place on day one — questionnaire
 *      bridge / channel runner can call into `wechat` adapters from
 *      synchronous code paths without dynamic-import gymnastics.
 *   2. Unit tests that don't bind an iLink credential never go through the
 *      stub's throwing code paths.
 *   3. Production Electron main can `import('./sdk/index.js')` and
 *      construct a real {@link WeChatRuntimeSdk} on top of `ILinkClient` /
 *      `sendTextMessage` / `uploadImage` / etc. as a single later patch
 *      without touching any caller.
 *
 * Every method throws a clearly-labelled error so a misconfigured
 * production setup (binding present but no real SDK injected) surfaces
 * immediately rather than silently dropping outbound traffic.
 */
import { EventEmitter } from 'node:events';

import type {
  WeChatClientHandle,
  WeChatMonitorCreateParams,
  WeChatMonitorEventMap,
  WeChatMonitorEventName,
  WeChatMonitorHandle,
  WeChatRuntimeSdk,
  WeChatSendMediaParams,
  WeChatSendParams,
  WeChatUploadParams,
  WeChatUploadedFile,
} from '../../wechat-sdk-contract.js';

const STUB_ERROR_MSG =
  'WeChat runtime SDK not wired — host must inject a real WeChatRuntimeSdk (slice 2 backlog)';

class StubClient implements WeChatClientHandle {
  private token: string;
  constructor(
    token: string,
    private readonly baseUrl: string,
  ) {
    this.token = token;
  }
  setToken(token: string): void {
    this.token = token;
  }
  getToken(): string | undefined {
    return this.token;
  }
  getBaseUrl(): string {
    return this.baseUrl;
  }
}

export const stubWeChatRuntimeSdk: WeChatRuntimeSdk = {
  createClient(opts: { token: string; baseUrl?: string }): WeChatClientHandle {
    return new StubClient(opts.token, opts.baseUrl ?? '');
  },
  sendText(_params: WeChatSendParams): Promise<{ messageId: string }> {
    return Promise.reject(new Error(STUB_ERROR_MSG));
  },
  sendMediaFile(_params: WeChatSendMediaParams): Promise<{ messageId: string }> {
    return Promise.reject(new Error(STUB_ERROR_MSG));
  },
  uploadImage(_params: WeChatUploadParams): Promise<WeChatUploadedFile> {
    return Promise.reject(new Error(STUB_ERROR_MSG));
  },
  uploadVideo(_params: WeChatUploadParams): Promise<WeChatUploadedFile> {
    return Promise.reject(new Error(STUB_ERROR_MSG));
  },
  uploadFile(_params: WeChatUploadParams): Promise<WeChatUploadedFile> {
    return Promise.reject(new Error(STUB_ERROR_MSG));
  },
  downloadAndDecrypt(_input: {
    encryptedQueryParam: string;
    aesKey: string;
    cdnBaseUrl: string;
    token?: string;
  }): Promise<Buffer> {
    return Promise.reject(new Error(STUB_ERROR_MSG));
  },
  createMonitor(_params: WeChatMonitorCreateParams): WeChatMonitorHandle {
    return new StubMonitorHandle();
  },
};

/**
 * Inert monitor handle used when no real SDK is wired (unit tests, missing
 * production wiring). `start()` resolves immediately, `getState()` always
 * returns the empty cursor, no messages are ever emitted. Tests that need
 * to drive inbound traffic substitute their own fake — see
 * `test/unit/local-wechat-monitor.test.ts`.
 */
class StubMonitorHandle implements WeChatMonitorHandle {
  private readonly emitter = new EventEmitter();
  private running = false;
  async start(): Promise<void> {
    this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  isRunning(): boolean {
    return this.running;
  }
  getState(): string {
    return '';
  }
  on<E extends WeChatMonitorEventName>(
    event: E,
    listener: (...args: WeChatMonitorEventMap[E]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
  off<E extends WeChatMonitorEventName>(
    event: E,
    listener: (...args: WeChatMonitorEventMap[E]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }
}
