/**
 * Built-in PostToolUse hook: Computer Use (CU) image injector.
 *
 * When an agent invokes a CU MCP tool via bash (`mavis mcp call cu ...`),
 * the CLI saves any returned image data to a temp file and outputs a marker
 * line: `[image saved: /path/to/file.jpg (image/jpeg)]`. This hook detects
 * that marker, reads the file, compresses it for model consumption, and
 * injects it as an attachment so the LLM receives the screenshot natively
 * instead of just a text placeholder.
 *
 * Without this hook, CU screenshots are silently lost — the CLI cannot
 * embed base64 data in its stdout (it would be enormous), and the bash
 * tool result that reaches the LLM is just text.
 *
 * Flow:
 *   Agent calls bash("mavis mcp call cu desktop_screenshot")
 *     → CLI saves image to /tmp/mavis-mcp-images/mcp-image-*.jpg
 *     → CLI outputs "[image saved: /path (mime)]"
 *     → This hook fires on the Bash PostToolUse
 *     → Reads temp file, compresses via buildCompressedModelImageFromFile
 *     → Sets output.toolResult with attachments[]
 *     → LLM receives the image natively
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../host-utils.js';
import { buildCompressedModelImageFromFile } from '../../../utils/model-image-preprocess.js';
import type {
  HookHandler,
  HookRegistration,
  PostToolUseInput,
  PostToolUseOutput,
} from '../types.js';

export const CU_IMAGE_INJECTOR_ID = 'builtin:cu-image-injector';

/**
 * Pattern to extract saved image paths from CLI output.
 * Matches: [image saved: /path/to/file.jpg (image/jpeg)]
 */
const IMAGE_SAVED_PATTERN = /\[image saved: (.+?) \(([^)]+)\)\]/g;

/**
 * Detect whether a tool call is a CU MCP invocation via bash.
 *
 * Recognised shapes:
 *   - bash/shell command containing `mavis mcp call cu`
 */
export function isCuToolInvocation(toolName: string, toolArgs: unknown): boolean {
  const lower = toolName.toLowerCase();
  if (lower !== 'bash' && lower !== 'shell') return false;
  if (!toolArgs || typeof toolArgs !== 'object') return false;
  const cmd = (toolArgs as Record<string, unknown>).command;
  return typeof cmd === 'string' && /\bmavis\s+mcp\s+call\s+cu\b/u.test(cmd);
}

interface StructuredToolResult {
  content: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  output: string;
}

/**
 * Try to clean up the temp file after we've read it. Best-effort — if
 * deletion fails (e.g. permission, already gone), we just log and move on.
 */
function tryCleanup(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Temp files in /tmp are cleaned by the OS eventually — not critical.
  }
}

export const cuImageInjectorHandler: HookHandler<PostToolUseInput, PostToolUseOutput> = async (
  input,
  output,
) => {
  if (!isCuToolInvocation(input.toolName, input.toolArgs)) return;

  const resultText =
    typeof input.toolResult === 'string'
      ? input.toolResult
      : JSON.stringify(input.toolResult ?? '');

  // Extract all saved image paths from the CLI output
  const savedImages: Array<{ filePath: string; mime: string }> = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex for the global regex
  IMAGE_SAVED_PATTERN.lastIndex = 0;
  while ((match = IMAGE_SAVED_PATTERN.exec(resultText)) !== null) {
    const filePath = match[1]!;
    const mime = match[2]!;
    if (fs.existsSync(filePath)) {
      savedImages.push({ filePath, mime });
    }
  }

  if (savedImages.length === 0) return;

  logger.info(
    `[cu-image-injector] found ${savedImages.length} saved image(s) in CU bash result sessionId=${input.sessionId}`,
  );

  const attachments: Array<Record<string, unknown>> = [];

  for (const { filePath } of savedImages) {
    try {
      const compressed = await buildCompressedModelImageFromFile(filePath, path.basename(filePath));
      if (compressed) {
        attachments.push(compressed.filePart);
        logger.info(
          `[cu-image-injector] compressed CU image filePath=${filePath} bytes=${compressed.sizeBytes} ${compressed.width}x${compressed.height}`,
        );
      } else {
        logger.warn(`[cu-image-injector] compression returned null for filePath=${filePath}`);
      }
    } catch (err) {
      logger.warn(`[cu-image-injector] failed to compress ${filePath}: ${(err as Error).message}`);
    } finally {
      tryCleanup(filePath);
    }
  }

  if (attachments.length === 0) return;

  // Build the rewritten tool result text — strip the [image saved: ...] markers
  // and replace with a concise description for the LLM.
  let cleanedText = resultText;
  IMAGE_SAVED_PATTERN.lastIndex = 0;
  cleanedText = cleanedText.replace(IMAGE_SAVED_PATTERN, '').trim();
  const desc =
    attachments.length === 1
      ? 'CU screenshot attached as image below.'
      : `${attachments.length} CU screenshots attached as images below.`;
  const finalText = cleanedText ? `${cleanedText}\n${desc}` : desc;

  const toolResult: StructuredToolResult = {
    content: [{ type: 'text', text: finalText }],
    attachments,
    output: finalText,
  };
  output.toolResult = toolResult;
  output.metadata.cuImageInjected = true;
  output.metadata.cuImageCount = attachments.length;
};

/**
 * Construct the HookRegistration consumed by HookRegistry.registerBuiltin().
 * Priority 10 — runs early in the internal tool-result processing chain so
 * the image attachment is visible to the LLM in the same turn.
 */
export function createCuImageInjectorRegistration(): HookRegistration<
  PostToolUseInput,
  PostToolUseOutput
> {
  return {
    id: CU_IMAGE_INJECTOR_ID,
    hookEvent: 'PostToolUse',
    matcher: '^[Bb]ash$',
    priority: 10,
    timeout: 15_000,
    handler: cuImageInjectorHandler,
  };
}
