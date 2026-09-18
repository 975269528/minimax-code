/**
 * CU screenshot context pruner — beforeLlmCall hook.
 *
 * Scans the conversation message array for CU screenshot tool results
 * (desktop_screenshot / desktop_screenshot_region / desktop_zoom) that
 * contain ImageContent. Keeps only the N most recent screenshots with
 * inline images; older ones have their ImageContent replaced with a
 * text placeholder containing the saved file path.
 *
 * This prevents CU sessions from filling the context window with stale
 * screenshots. Each screenshot costs ~1000-1800 tokens; limiting to 3
 * keeps the overhead under ~5400 tokens while retaining the most
 * relevant visual context.
 */
import type {
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
} from '@mavis/agent-core/pi-turn-runner';
import type { MetricsClient } from '../common/metrics.js';

function recordMetric(record: () => void): void {
  try {
    record();
  } catch {
    // Observability must never abort the before-LLM hook or provider request.
  }
}

const CU_SCREENSHOT_TOOLS = new Set([
  'desktop_screenshot',
  'desktop_screenshot_region',
  'desktop_zoom',
]);

interface MessageContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

/**
 * Create a beforeLlmCall hook that prunes old CU screenshot images
 * from the conversation context, keeping at most `maxScreenshots`.
 */
export function createCuScreenshotPrunerHook(
  maxScreenshots: number,
  metrics?: Pick<MetricsClient, 'counter' | 'histogram'>,
): PiBeforeLlmCallHook {
  return async (
    input: PiBeforeLlmCallHookInput,
  ): Promise<PiBeforeLlmCallHookDecision | undefined> => {
    if (maxScreenshots <= 0) return undefined; // disabled

    // Collect indices of messages that contain CU screenshot image content.
    // Walk backwards so we can identify the N most recent.
    const screenshotLocations: Array<{
      msgIndex: number;
      contentPartIndex: number;
    }> = [];

    for (let i = input.messages.length - 1; i >= 0; i--) {
      const msg = input.messages[i] as unknown as Record<string, unknown>;
      // Pi's ToolResultMessage uses role 'toolResult' / 'toolName'. Keep the
      // legacy role/name aliases too because persisted histories can contain
      // the older shape.
      const role = msg?.role as string | undefined;
      if (role !== 'toolResult' && role !== 'tool') continue;

      // Check if this is a CU screenshot tool result
      const toolName = (msg?.toolName ?? msg?.tool_name ?? msg?.name) as string | undefined;
      if (!toolName || !CU_SCREENSHOT_TOOLS.has(toolName)) continue;

      // Find image content parts in this message
      const content = msg?.content as MessageContentPart[] | undefined;
      if (!Array.isArray(content)) continue;

      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j]?.type === 'image') {
          screenshotLocations.push({ msgIndex: i, contentPartIndex: j });
        }
      }
    }

    recordMetric(() =>
      metrics?.histogram(
        'cu_screenshot_resident_count',
        Math.min(screenshotLocations.length, maxScreenshots),
      ),
    );

    // If within limit, nothing to prune
    if (screenshotLocations.length <= maxScreenshots) return undefined;

    // screenshotLocations is newest-first (we walked backwards).
    // Keep the first `maxScreenshots` entries, prune the rest.
    const toPrune = screenshotLocations.slice(maxScreenshots);
    if (toPrune.length === 0) return undefined;

    // Deep-clone messages so we don't mutate the original array
    const pruned = input.messages.map((msg) =>
      JSON.parse(JSON.stringify(msg)),
    ) as typeof input.messages;

    for (const { msgIndex, contentPartIndex } of toPrune) {
      const msg = pruned[msgIndex] as unknown as Record<string, unknown>;
      const content = msg.content as MessageContentPart[];
      const imagePart = content[contentPartIndex]!;
      recordMetric(() =>
        metrics?.counter(
          'cu_screenshot_pruned_payload_bytes_total',
          typeof imagePart.data === 'string' ? Buffer.byteLength(imagePart.data, 'utf8') : 0,
        ),
      );

      // Replace image with text placeholder
      content[contentPartIndex] = {
        type: 'text',
        text: `[CU screenshot pruned from context to save tokens. ${
          imagePart.mimeType ? `Original: ${imagePart.mimeType}. ` : ''
        }Use desktop_screenshot to take a new screenshot if needed.]`,
      };
    }

    return {
      type: 'replaceMessages',
      messages: pruned,
      metadata: {
        replacementId: `cu-screenshot-prune-${Date.now()}`,
        strategyVersion: 'cu-screenshot-pruner-v1',
        summary: `Pruned ${toPrune.length} old CU screenshot(s), keeping ${maxScreenshots} most recent.`,
        compactedMessages: [],
        keptMessages: pruned,
        firstKeptIndex: 0,
      },
    };
  };
}
