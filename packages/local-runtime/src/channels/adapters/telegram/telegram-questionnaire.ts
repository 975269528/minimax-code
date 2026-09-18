import type { ChannelRenderableQuestionnaire } from '../../questionnaire-bridge.js';
import { TELEGRAM_CALLBACK_DATA_MAX_BYTES, utf8ByteLength } from './telegram-keyboard.js';

/**
 * Compact Telegram `callback_data` codec for questionnaire option buttons.
 *
 * Telegram caps `callback_data` at **64 UTF-8 bytes**. The shared
 * {@link encodeQuestionnaireOptionToken} JSON token (used by Feishu, whose
 * card value cap is ~1024) carries the full requestId (`ask_` + 32 hex) plus
 * step/option ids and overflows 64 bytes on its own — every button would fail
 * with `BUTTON_DATA_INVALID` and the whole questionnaire message would never
 * send. So Telegram uses an index-based layout instead:
 *
 *   `q:<rid6>:<stepIdx>:<opt>`
 *
 *   - `rid6`    = requestId with the `ask_` prefix stripped, first 6 hex chars
 *                 (a cheap anti-cross-talk / anti-stale check — the adapter
 *                 reconciles against its per-chat pending on decode).
 *   - `stepIdx` = 0-based index into `steps[]`.
 *   - `opt`     = 0-based index into `step.options[]`, or the literal `x` for
 *                 the Others row.
 *
 * Example: `q:37161e:0:2` (12 bytes), Others `q:37161e:0:x` — far under 64.
 */

/** Strip the `ask_` prefix (if present) and take the first 6 hex chars. */
function ridShort(requestId: string): string {
  const hex = requestId.startsWith('ask_') ? requestId.slice(4) : requestId;
  return hex.slice(0, 6);
}

/**
 * Encode a questionnaire option button into the compact `q:` layout. Returns
 * `null` when the result would exceed 64 UTF-8 bytes — the index scheme is so
 * short this never triggers in practice, but the caller degrades that button
 * defensively (mirrors the permission codec's oversize handling).
 *
 * `optionIndex === null` encodes the Others row as the literal `x`.
 */
export function encodeTelegramQuestionnaireCallback(input: {
  requestId: string;
  stepIndex: number;
  optionIndex: number | null;
}): string | null {
  const opt = input.optionIndex === null ? 'x' : String(input.optionIndex);
  const data = `q:${ridShort(input.requestId)}:${input.stepIndex}:${opt}`;
  if (utf8ByteLength(data) > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;
  return data;
}

/**
 * Decode a compact `q:` callback_data. Returns `null` for any non-matching or
 * malformed payload (wrong prefix, wrong arity, non-numeric indices). The
 * adapter reconciles `rid6` / `stepIndex` / `optionIndex` against its per-chat
 * pending to recover the full requestId and option id.
 */
export function decodeTelegramQuestionnaireCallback(
  data: string,
): { rid6: string; stepIndex: number; optionIndex: number | null } | null {
  const parts = data.split(':');
  if (parts.length !== 4 || parts[0] !== 'q') return null;
  const [, rid6, stepRaw, optRaw] = parts;
  if (!rid6 || stepRaw === undefined || optRaw === undefined) return null;
  if (!/^\d+$/.test(stepRaw)) return null;
  const stepIndex = Number(stepRaw);
  let optionIndex: number | null;
  if (optRaw === 'x') {
    optionIndex = null;
  } else if (/^\d+$/.test(optRaw)) {
    optionIndex = Number(optRaw);
  } else {
    return null;
  }
  return { rid6, stepIndex, optionIndex };
}

export function formatTelegramQuestionnairePrompt(
  renderable: ChannelRenderableQuestionnaire,
): string {
  const lines: string[] = [];
  lines.push(renderable.title ? `Questionnaire: ${renderable.title}` : 'Questionnaire');
  for (const [index, step] of renderable.steps.entries()) {
    lines.push('');
    lines.push(`Q${index + 1}: ${step.question}`);
    if (step.description) lines.push(step.description);
    if (step.selectionMode === 'multiple') lines.push('Choose one or more options below.');
  }
  return lines.join('\n').trim();
}

export function formatTelegramStepPrompt(
  renderable: ChannelRenderableQuestionnaire,
  stepIndex: number,
): string {
  const step = renderable.steps[stepIndex];
  if (!step) return formatTelegramQuestionnairePrompt(renderable);
  const lines: string[] = [];
  if (renderable.title) {
    lines.push(`问卷：${renderable.title}`);
    lines.push('');
  }
  lines.push(`问题 ${stepIndex + 1}/${renderable.steps.length}`);
  lines.push('');
  lines.push(step.question);
  if (step.description) lines.push(step.description);
  if (step.selectionMode === 'multiple') {
    lines.push('（Telegram 目前按单选逐题处理，请先选择一个最合适的选项）');
  }
  return lines.join('\n').trim();
}

export function buildTelegramQuestionnaireKeyboard(renderable: ChannelRenderableQuestionnaire): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const [stepIndex, step] of renderable.steps.entries()) {
    for (const [optionIndex, option] of step.options.entries()) {
      const callback_data = encodeTelegramQuestionnaireCallback({
        requestId: renderable.requestId,
        stepIndex,
        optionIndex,
      });
      // Defensive: index scheme is tiny so this never trips, but skip any
      // button whose callback_data somehow overflowed 64 bytes rather than
      // emit an invalid one Telegram would reject.
      if (callback_data === null) continue;
      rows.push([{ text: option.label, callback_data }]);
    }
    const othersData = encodeTelegramQuestionnaireCallback({
      requestId: renderable.requestId,
      stepIndex,
      optionIndex: null,
    });
    if (othersData !== null) {
      rows.push([{ text: 'Others...', callback_data: othersData }]);
    }
  }
  return { inline_keyboard: rows };
}

export function buildTelegramStepKeyboard(
  renderable: ChannelRenderableQuestionnaire,
  stepIndex: number,
): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const step = renderable.steps[stepIndex];
  if (!step) return { inline_keyboard: rows };
  for (const [optionIndex, option] of step.options.entries()) {
    const callback_data = encodeTelegramQuestionnaireCallback({
      requestId: renderable.requestId,
      stepIndex,
      optionIndex,
    });
    if (callback_data === null) continue;
    rows.push([{ text: option.label, callback_data }]);
  }
  const othersData = encodeTelegramQuestionnaireCallback({
    requestId: renderable.requestId,
    stepIndex,
    optionIndex: null,
  });
  if (othersData !== null) {
    rows.push([{ text: 'Others...', callback_data: othersData }]);
  }
  return { inline_keyboard: rows };
}
