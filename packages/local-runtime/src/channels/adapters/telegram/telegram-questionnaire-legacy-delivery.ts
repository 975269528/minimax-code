import type { AskQuestionnaireRequest } from '@mavis/shared/questionnaire';

import { toRenderableQuestionnaire } from '../../questionnaire-bridge.js';
import {
  buildTelegramQuestionnaireKeyboard,
  formatTelegramQuestionnairePrompt,
} from './telegram-questionnaire.js';
import type { TelegramSender } from './telegram-sender.js';

/**
 * Fallback for legacy clients constructed without a `TelegramPlatformAdapter`.
 * It renders the questionnaire keyboard but cannot register pending state, so
 * production wiring must prefer adapter delegation for clickable replies.
 */
export async function sendTelegramQuestionnaireFallback(input: {
  sender: TelegramSender;
  chatId: string;
  request: AskQuestionnaireRequest;
}): Promise<void> {
  const renderable = toRenderableQuestionnaire(input.request);
  await input.sender.sendText(
    input.chatId,
    formatTelegramQuestionnairePrompt(renderable),
    buildTelegramQuestionnaireKeyboard(renderable),
  );
}
