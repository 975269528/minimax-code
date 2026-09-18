import { createHash } from 'node:crypto';

import type { LocalBrowserScreenshotPreprocessor } from '@mavis/agent-tools/desktop';

import type { BrowserUseServiceOptions } from './contracts.js';

type BrowserScreenshotCompressionPort = BrowserUseServiceOptions['compressScreenshot'];
type BrowserGeneratedAssetRegistrar = BrowserUseServiceOptions['registerGeneratedAsset'];
type BrowserScreenshotVisualBudget = Parameters<BrowserScreenshotCompressionPort>[0]['budget'];
type BrowserCompressedScreenshot = NonNullable<ReturnType<BrowserScreenshotCompressionPort>>;

const MAX_POST_ACTION_VISUAL_DEDUP_SESSIONS = 128;
const EXPLICIT_SCREENSHOT_BUDGET = {
  maxBytes: 5 * 1024 * 1024,
  maxEdgePx: 1_920,
} as const satisfies BrowserScreenshotVisualBudget;
const POST_ACTION_SCREENSHOT_BUDGET = {
  maxBytes: 1024 * 1024,
  maxEdgePx: 1_280,
} as const satisfies BrowserScreenshotVisualBudget;

export interface BrowserScreenshotPreprocessor extends LocalBrowserScreenshotPreprocessor {
  clearSession(sessionId: string): void;
  clear(): void;
}

export function createBrowserScreenshotPreprocessor(options: {
  readonly compressScreenshot: BrowserScreenshotCompressionPort;
  readonly registerGeneratedAsset: BrowserGeneratedAssetRegistrar;
}): BrowserScreenshotPreprocessor {
  const lastPostActionFingerprintBySession = new Map<string, string>();
  const preprocess: LocalBrowserScreenshotPreprocessor = async (
    result,
    ctx,
    signal,
    preprocessOptions,
  ) => {
    throwIfAborted(signal);
    const screenshot = readScreenshot(result);
    if (!screenshot) return result;

    const budget =
      preprocessOptions?.purpose === 'post-action'
        ? POST_ACTION_SCREENSHOT_BUDGET
        : EXPLICIT_SCREENSHOT_BUDGET;
    const prepared = prepareScreenshot(options.compressScreenshot, screenshot, budget);
    throwIfAborted(signal);
    if (preprocessOptions?.purpose === 'post-action') {
      return preprocessPostActionScreenshot(
        prepared,
        ctx.sessionId,
        lastPostActionFingerprintBySession,
      );
    }
    return registerExplicitScreenshot(prepared, ctx, options.registerGeneratedAsset, signal);
  };
  return Object.assign(preprocess, {
    clearSession: (sessionId: string) => lastPostActionFingerprintBySession.delete(sessionId),
    clear: () => lastPostActionFingerprintBySession.clear(),
  });
}

interface PreparedScreenshot {
  readonly compressed: BrowserCompressedScreenshot;
  readonly decoded: Buffer;
  readonly result: Readonly<Record<string, unknown>>;
}

function readScreenshot(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  const screenshot = result as Record<string, unknown>;
  return typeof screenshot.data === 'string' && screenshot.data.length > 0 ? screenshot : undefined;
}

function prepareScreenshot(
  compressScreenshot: BrowserScreenshotCompressionPort,
  screenshot: Record<string, unknown> & { readonly data?: unknown },
  budget: BrowserScreenshotVisualBudget,
): PreparedScreenshot {
  let compressed: BrowserCompressedScreenshot | undefined;
  try {
    compressed = compressScreenshot({
      bytes: Buffer.from(screenshot.data as string, 'base64'),
      fileName: 'browser-screenshot.png',
      budget,
    });
  } catch {
    compressed = undefined;
  }
  const decoded = compressed ? decodeDataUrl(compressed.dataUrl) : undefined;
  if (!compressed || !decoded) {
    throw new Error(
      'BROWSER_SCREENSHOT_PREPROCESS_FAILED: Browser screenshot could not be compressed',
    );
  }
  return {
    compressed,
    decoded,
    result: {
      ...screenshot,
      format: 'jpeg',
      width: compressed.width,
      height: compressed.height,
      bytes: decoded.byteLength,
      data: decoded.toString('base64'),
      visualBudget: budget,
    },
  };
}

function preprocessPostActionScreenshot(
  prepared: PreparedScreenshot,
  sessionId: string,
  fingerprints: Map<string, string>,
): Readonly<Record<string, unknown>> {
  const fingerprint = createHash('sha256').update(prepared.decoded).digest('hex');
  if (fingerprints.get(sessionId) === fingerprint) {
    const metadata: Record<string, unknown> = { ...prepared.result };
    delete metadata.data;
    return { ...metadata, deduplicated: true };
  }
  fingerprints.set(sessionId, fingerprint);
  trimOldestEntries(fingerprints);
  return prepared.result;
}

async function registerExplicitScreenshot(
  prepared: PreparedScreenshot,
  ctx: { readonly sessionId: string; readonly turnId: string },
  registerGeneratedAsset: BrowserGeneratedAssetRegistrar,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const asset = await registerGeneratedAsset({
      fileName: 'browser-screenshot.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
      sourceKind: 'generated',
      dataUrl: prepared.compressed.dataUrl,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      generatedBy: 'browser_screenshot',
    });
    throwIfAborted(signal);
    return {
      ...prepared.result,
      userDelivery: {
        available: true,
        requiresExplicitUserRequest: true,
        assetId: asset.assetId,
        filePath: asset.absolutePath,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        mediaMarkup: `<media src="${escapeMediaAttribute(asset.absolutePath)}" caption="Browser screenshot" />`,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...prepared.result,
      userDelivery: {
        available: false,
        requiresExplicitUserRequest: true,
        code: 'SCREENSHOT_ASSET_WRITE_FAILED',
      },
    };
  }
}

function decodeDataUrl(dataUrl: string): Buffer | undefined {
  const match = /^data:[^;,]*(?:;charset=[^;,]+)?;base64,(.+)$/s.exec(dataUrl);
  if (!match?.[1]) return undefined;
  return Buffer.from(match[1], 'base64');
}

function trimOldestEntries(values: Map<string, string>): void {
  while (values.size > MAX_POST_ACTION_VISUAL_DEDUP_SESSIONS) {
    const oldest = values.keys().next().value;
    if (typeof oldest !== 'string') return;
    values.delete(oldest);
  }
}

function escapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}
