/** Stable provenance stored with display messages. */
export type MessageSource =
  | 'api'
  | 'cron'
  | 'thread-goal'
  | 'im'
  | `channel:${string}`
  | 'team'
  | 'background-task'
  | 'system'
  | (string & { readonly __messageSourceBrand?: never });

/** Optional source-specific identity kept as message metadata, never as metric tags. */
export interface MessageSourceContext {
  readonly channel?: string;
  readonly channel_id?: string;
  readonly platform?: string;
  readonly chatType?: string;
  readonly chatId?: string;
  readonly threadId?: string;
  readonly clientName?: string;
  readonly senderId?: string;
  readonly [key: string]: unknown;
}
