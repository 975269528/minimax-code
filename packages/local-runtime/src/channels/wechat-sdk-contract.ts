/**
 * Neutral WeChat runtime SDK contract shared by host wiring and the concrete
 * WeChat adapter. Keep this file free of platform adapter imports so runtime
 * factories can accept an injected SDK without depending on concrete channel
 * implementations.
 */

/** Opaque handle to an `ILinkClient` instance. */
export interface WeChatClientHandle {
  setToken(token: string): void;
  getToken(): string | undefined;
  getBaseUrl(): string;
}

/**
 * Inbound message envelope emitted by the monitor. Intentionally a structural
 * `unknown`-typed alias on the contract side so the host wire layer can pass
 * the SDK's `WeixinMessage` through without the contract module needing to
 * import any SDK types. The adapter parses the raw shape via the existing
 * `parseLocalWeChatEvent` helper.
 */
export type WeChatInboundMessage = unknown;

/**
 * Status updates emitted by the monitor loop. Mirrors the underlying
 * `ILinkMonitor`'s `MonitorStatus` union, kept inline so callers do not
 * have to import the SDK directly to react to status changes.
 */
export type WeChatMonitorStatus = 'polling' | 'reconnecting' | 'stopped' | 'session_expired';

/**
 * Event names + payload tuples for {@link WeChatMonitorHandle}. Wider type
 * (`unknown`) than the SDK's `MonitorEvents` so the contract module does not
 * need to import the SDK — concrete handles round-trip the values through.
 */
export interface WeChatMonitorEventMap {
  message: [msg: WeChatInboundMessage];
  error: [err: Error];
  status: [status: WeChatMonitorStatus];
  connected: [];
  disconnected: [reason: string];
}

export type WeChatMonitorEventName = keyof WeChatMonitorEventMap;

/**
 * Opaque handle to an `ILinkMonitor` instance. The handle is a minimal
 * structural projection of `EventEmitter<MonitorEvents>` so the adapter can
 * subscribe / unsubscribe without naming the SDK type directly, plus the
 * lifecycle methods the adapter drives on bind/unbind.
 *
 * `getState()` returns the current `get_updates_buf` cursor — the adapter
 * persists it across desktop restarts so a reconnect can resume after the
 * last delivered update instead of replaying the entire backlog (or worse,
 * starting from "now" and silently dropping messages enqueued while the
 * desktop was closed).
 */
export interface WeChatMonitorHandle {
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
  /** Current `get_updates_buf` value (for persistence across restarts). */
  getState(): string;
  /** Subscribe to a monitor event; returns the handle for chaining. */
  on<E extends WeChatMonitorEventName>(
    event: E,
    listener: (...args: WeChatMonitorEventMap[E]) => void,
  ): this;
  /** Unsubscribe a previously-registered listener. */
  off<E extends WeChatMonitorEventName>(
    event: E,
    listener: (...args: WeChatMonitorEventMap[E]) => void,
  ): this;
}

export interface WeChatUploadedFile {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

export interface WeChatSendParams {
  client: WeChatClientHandle;
  to: string;
  contextToken: string;
  text?: string;
}

export interface WeChatSendMediaParams extends WeChatSendParams {
  uploaded: WeChatUploadedFile;
  fileName: string;
  mimeType: string;
}

export interface WeChatUploadParams {
  client: WeChatClientHandle;
  buf: Buffer;
  toUserId: string;
  cdnBaseUrl: string;
}

/**
 * Parameters for {@link WeChatRuntimeSdk.createMonitor}. The `client` is the
 * authenticated `WeChatClientHandle` for the binding (so the monitor reuses
 * the bound token). `getUpdatesBuf` resumes from a previously-persisted
 * cursor; omit on a fresh start. `botId` is the bot's own iLink user id —
 * inbound messages from this id are silently dropped (avoids the bot
 * round-tripping its own outbound).
 */
export interface WeChatMonitorCreateParams {
  client: WeChatClientHandle;
  getUpdatesBuf?: string;
  botId?: string;
}

/**
 * SDK contract the adapter depends on. Production wires this to the vendored
 * iLink SDK; tests provide an in-memory fake.
 */
export interface WeChatRuntimeSdk {
  createClient(opts: { token: string; baseUrl?: string }): WeChatClientHandle;
  sendText(params: WeChatSendParams): Promise<{ messageId: string }>;
  sendMediaFile(params: WeChatSendMediaParams): Promise<{ messageId: string }>;
  uploadImage(params: WeChatUploadParams): Promise<WeChatUploadedFile>;
  uploadVideo(params: WeChatUploadParams): Promise<WeChatUploadedFile>;
  uploadFile(params: WeChatUploadParams): Promise<WeChatUploadedFile>;
  downloadAndDecrypt(input: {
    encryptedQueryParam: string;
    aesKey: string;
    cdnBaseUrl: string;
    token?: string;
  }): Promise<Buffer>;
  /**
   * Construct an iLink message monitor. The adapter starts it on bind and
   * stops it on unbind; the host never touches the monitor directly. Returns
   * a {@link WeChatMonitorHandle} the adapter can subscribe to and drive.
   *
   * Optional so existing test wiring that only exercises outbound paths
   * (no inbound) can pass an SDK stub that does not provide a monitor.
   * Callers that need inbound MUST check for presence before invoking.
   */
  createMonitor?(params: WeChatMonitorCreateParams): WeChatMonitorHandle;
  /**
   * Fetch the per-user iLink bot config — used by the typing-indicator
   * flow to obtain a `typing_ticket`. Optional so SDK stubs that don't
   * exercise typing can omit it; the adapter degrades gracefully when
   * absent (no typing dots, but turns still complete).
   */
  getConfig?(params: {
    client: WeChatClientHandle;
    ilinkUserId: string;
    contextToken?: string;
  }): Promise<{ typingTicket?: string }>;
  /**
   * Push a typing indicator update for a given user. `status` mirrors the
   * iLink SDK's `TypingStatus` enum (1 = typing, 2 = cancel). Optional for
   * the same reason as `getConfig`.
   */
  sendTyping?(params: {
    client: WeChatClientHandle;
    ilinkUserId: string;
    typingTicket: string;
    status: 1 | 2;
  }): Promise<void>;
}
