/**
 * Where a queued message originated from. Channel-sourced items carry the
 * originating IM platform so the dispatcher can:
 *   1. Skip non-channel dispatchers (api / cron).
 *   2. Locate the originating channel binding / context for delivery.
 *
 * Kept in sync with the upstream UI contract `daemonQueueSource`:
 *   api | cron | thread-goal | channel:wechat | channel:feishu | channel:telegram
 */
export type LocalQueuedMessageSource =
  | 'api'
  | 'cron'
  | 'thread-goal'
  | 'channel:wechat'
  | 'channel:feishu'
  | 'channel:telegram';
