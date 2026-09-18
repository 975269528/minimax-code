/**
 * Main/preload/renderer result for the direct utility-runtime transport.
 *
 * The union keeps a live port and a terminal supervisor verdict mutually
 * exclusive: once Main latches terminal failure there is no connection to
 * deliver, while a connected result must never tell the renderer to stop it.
 */
export type RuntimeTransportDirectConnectionResult =
  | { enabled: true; connected: true; terminal?: never }
  | { enabled: true; connected: false; terminal?: false }
  | { enabled: true; connected: false; terminal: true };

/** Selected runtime transport mode returned across the Electron IPC bridge. */
export type RuntimeTransportPortResult =
  | ({ mode: 'direct' } & RuntimeTransportDirectConnectionResult)
  | { mode: 'protocol'; enabled: false; connected: false; terminal?: never };
