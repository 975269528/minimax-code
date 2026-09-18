/**
 * Compatibility view of the one authoritative BrowserTransport contract.
 *
 * CDPHelper only needs page commands/events and does not own provider
 * lifecycle. Keeping this as a Pick prevents a second transport contract from
 * drifting while preserving the narrow dependency used by Electron.
 */
import type { BrowserTransport } from './browser-transport.js';

export type {
  BrowserEvaluateOptions,
  BrowserTransportCommandOptions,
  BrowserTransportEvent,
  BrowserTransportEventListener,
} from './browser-transport.js';

export type BrowserPageTransport = Pick<
  BrowserTransport,
  | 'send'
  | 'evaluate'
  | 'evaluateInAllFrames'
  | 'listAttachedFrames'
  | 'onEvent'
  | 'stopLoading'
  | 'close'
>;
