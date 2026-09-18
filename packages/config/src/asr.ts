// ── ASR (Cloud Speech Recognition) ───────────────────────────────
//
// Types and config parsers split out from `config.ts` to keep that file
// under the 2000-line gate. Re-exported by `config.ts` so callers continue
// to import from `@mavis/config` exactly as before.
//
// ## Provider policy (post Seed/Qwen retirement)
//
// The daemon no longer speaks to the legacy shared asr-proxy WebSocket.
// Amadeus uses a separate authenticated HTTP+SSE proxy endpoint.
// Both the Seed and Qwen providers were retired; the only remaining
// vendor is Amadeus. Web uses the shared authenticated upload transport,
// while Electron delegates the same WAV upload + SSE flow to its main
// process. Because the daemon has no upstream credentials or endpoints
// to configure any more, this schema collapses to a single `enabled`
// master switch. The parser still recognises the
// removed keys (`mode`, `proxyBaseUrl`, `primaryProvider`,
// `fallbackProvider`, and any legacy `asr.{seed,qwen}.*` credential
// slots) and drops them with a warn so operators upgrading from an older
// config.yaml notice their file has dead fields — the values are never
// echoed back into the parsed shape.

/**
 * Structured warn line — config package has no pino instance, so we write
 * directly to stderr in a JSON shape the daemon log pipeline can parse.
 * Used only when legacy vendor credentials are detected in config.yaml.
 */
function warnLegacy(message: string): void {
  // Keep this tiny + dependency-free: stringify a {level,time,msg} record so
  // it interleaves cleanly with pino lines in stderr-captured daemon logs.
  const line = JSON.stringify({
    level: 40, // pino warn level
    time: Date.now(),
    name: 'config.asr',
    msg: message,
  });
  process.stderr.write(`${line}\n`);
}

/**
 * Logical identifier for an ASR provider implementation. Seed and Qwen
 * were retired; only Amadeus remains. The type stays a named alias so
 * future providers can extend the union without touching callers.
 */
export type AsrProviderName = 'amadeus';

/**
 * Cloud ASR (speech-to-text) configuration.
 *
 * The daemon side no longer owns any streaming ASR transport. Web and
 * Electron use the managed Amadeus HTTP proxy, so this record now carries
 * a single `enabled` toggle. It is kept as a dedicated interface so future
 * providers can extend the schema without a breaking rename.
 */
export interface AsrConfig {
  /**
   * Master switch for cloud ASR. When false, Web/Electron hide the mic
   * button and the Electron main process refuses to open a desktop session.
   * Default: true.
   */
  enabled: boolean;
}

/** Defaults used by parser and consumed by DEFAULTS in `config.ts`. */
export const ASR_DEFAULTS: Pick<AsrConfig, 'enabled'> = {
  enabled: true,
};

/**
 * Returns true if the given raw `asr.{seed,qwen}` slot carries any vendor
 * credential field (apiKey / resourceId). Used to emit a single warn line
 * when legacy config is detected, without echoing the secret. Both
 * providers have been retired; the check exists purely to help operators
 * clean up an upgraded `config.yaml`.
 */
function rawSlotHasCredential(slot: unknown): boolean {
  if (slot == null || typeof slot !== 'object' || Array.isArray(slot)) return false;
  const obj = slot as Record<string, unknown>;
  const hasApiKey = typeof obj.apiKey === 'string' && obj.apiKey.trim().length > 0;
  const hasResourceId = typeof obj.resourceId === 'string' && obj.resourceId.trim().length > 0;
  return hasApiKey || hasResourceId;
}

/**
 * Returns true if the given raw slot has a non-empty string value. Used
 * to detect legacy `asr.mode` / `asr.proxyBaseUrl` fields that no longer
 * live in the schema.
 */
function rawHasString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseAsrConfig(raw: Record<string, unknown>): AsrConfig {
  const rawAsr = raw.asr;
  if (rawAsr == null || typeof rawAsr !== 'object' || Array.isArray(rawAsr)) {
    return { ...ASR_DEFAULTS };
  }
  const obj = rawAsr as Record<string, unknown>;

  // Legacy credential drop — Seed and Qwen were retired and the daemon no
  // longer speaks to the asr-proxy. Any of the following legacy fields
  // are silently ignored, with a warn so operators notice the dead
  // config. Secret VALUES are never echoed.
  if (rawSlotHasCredential(obj.seed)) {
    warnLegacy(
      'Ignoring legacy `asr.seed.*` in config — Seed ASR was retired from the daemon; only Amadeus remains. Remove `asr.seed` from config.yaml.',
    );
  }
  if (rawSlotHasCredential(obj.qwen)) {
    warnLegacy(
      'Ignoring legacy `asr.qwen.apiKey` in config — Qwen ASR was retired from the daemon; only Amadeus remains. Remove `asr.qwen` from config.yaml.',
    );
  }
  if (rawHasString(obj.mode) || rawHasString(obj.proxyBaseUrl)) {
    warnLegacy(
      'Ignoring legacy `asr.mode` / `asr.proxyBaseUrl` in config — the daemon no longer runs the shared asr-proxy WebSocket path. The Amadeus HTTP proxy is managed by the application environment. Remove these keys from config.yaml.',
    );
  }
  if (rawHasString(obj.primaryProvider) || rawHasString(obj.fallbackProvider)) {
    warnLegacy(
      'Ignoring legacy `asr.primaryProvider` / `asr.fallbackProvider` in config — only Amadeus remains and provider selection is no longer configurable. Remove these keys from config.yaml.',
    );
  }

  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : ASR_DEFAULTS.enabled,
  };
}
