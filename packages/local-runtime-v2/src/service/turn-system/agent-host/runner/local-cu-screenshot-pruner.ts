import type {
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
} from '@mavis/agent-core/pi-turn-runner';

const SCREENSHOT_TOOLS = new Set([
  'desktop_screenshot',
  'desktop_screenshot_region',
  'desktop_zoom',
]);

/** Keeps only the newest inline CU screenshots in each LLM context. */
export function createLocalCuScreenshotPruner(maxScreenshots: number): PiBeforeLlmCallHook {
  return async (
    input: PiBeforeLlmCallHookInput,
  ): Promise<PiBeforeLlmCallHookDecision | undefined> => {
    if (maxScreenshots <= 0) return undefined;
    const locations = input.messages.reduceRight<Array<{ message: number; content: number }>>(
      (found, message, messageIndex) => {
        const record: Record<string, unknown> = isRecord(message) ? message : {};
        const name = record.tool_name ?? record.name ?? record.toolName;
        if (
          (record.role !== 'tool' && record.role !== 'toolResult') ||
          typeof name !== 'string' ||
          !SCREENSHOT_TOOLS.has(name)
        ) {
          return found;
        }
        const content = Array.isArray(record.content) ? record.content : [];
        content.reduceRight<undefined>((_, part: unknown, contentIndex: number) => {
          if (Reflect.get(Object(part), 'type') === 'image') {
            found.push({ message: messageIndex, content: contentIndex });
          }
          return undefined;
        }, undefined);
        return found;
      },
      [],
    );
    const toPrune = locations.slice(maxScreenshots);
    if (toPrune.length === 0) return undefined;
    const pruned = structuredClone(input.messages);
    toPrune.forEach(({ message, content }) => {
      const record = pruned[message];
      if (!isRecord(record) || !Array.isArray(record.content)) return;
      const parts = record.content;
      parts[content] = {
        type: 'text',
        text: '[CU screenshot pruned from context. Take a new screenshot if current visual state is needed.]',
      };
    });
    return {
      type: 'replaceMessages',
      messages: pruned,
      metadata: {
        replacementId: `cu-screenshot-prune-${Date.now()}`,
        strategyVersion: 'cu-screenshot-pruner-v1',
        summary: `Pruned ${toPrune.length} old CU screenshot(s).`,
        compactedMessages: [],
        keptMessages: pruned,
        firstKeptIndex: 0,
        replacementSourceIndexes: pruned.map((_, index) => index),
      },
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
