import type {
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';

import type { LocalChannelContext } from '../../infra.js';
import type { QuestionnaireReplyOutcome } from '../../../questionnaire/reply-outcome.js';
import {
  type ChannelRenderableQuestionnaire,
  toRenderableQuestionnaire,
} from '../../questionnaire-bridge.js';
import {
  buildTelegramStepKeyboard,
  decodeTelegramQuestionnaireCallback,
  formatTelegramStepPrompt,
} from './telegram-questionnaire.js';
import type { TelegramSender } from './telegram-sender.js';
import { imLogger as logger } from '../../../common/im-logger.js';

type TelegramQuestionnaireSender = { sender: TelegramSender; chatId: string } | null;

interface TelegramQuestionnairePending {
  requestId: string;
  rid6: string;
  chatId: string;
  messageId?: number;
  request: AskQuestionnaireRequest;
  renderable: ChannelRenderableQuestionnaire;
  currentStepIndex: number;
  answers: Map<string, AskQuestionnaireReplyAnswer>;
  createdAt: number;
  inFlight?: boolean;
}

export class TelegramQuestionnaireRuntime {
  /**
   * Pending questionnaires keyed by chatId. Telegram inline buttons can only
   * carry one step/option per click, so this pending is a per-chat accumulator:
   * each callback records one step answer and advances the original message to
   * the next step; only the final step returns a complete reply to the runner.
   */
  private readonly pendingByChat = new Map<string, TelegramQuestionnairePending>();

  constructor(
    private readonly resolveSender: (
      ctx: LocalChannelContext,
    ) => Promise<TelegramQuestionnaireSender>,
  ) {}

  async sendInitial(input: {
    ctx: LocalChannelContext;
    request: AskQuestionnaireRequest;
    sender: TelegramSender;
  }): Promise<void> {
    const renderable = toRenderableQuestionnaire(input.request);
    const sent = await input.sender.sendText(
      input.ctx.chatId,
      formatTelegramStepPrompt(renderable, 0),
      buildTelegramStepKeyboard(renderable, 0),
      input.ctx.threadId,
    );
    this.pendingByChat.set(input.ctx.chatId, {
      requestId: input.request.id,
      rid6: telegramRidShort(input.request.id),
      chatId: input.ctx.chatId,
      ...(sent?.messageId !== undefined ? { messageId: sent.messageId } : {}),
      request: input.request,
      renderable,
      currentStepIndex: 0,
      answers: new Map(),
      createdAt: Date.now(),
    });
  }

  async tryHandleReply(input: {
    ctx: LocalChannelContext;
    raw?: unknown;
  }): Promise<
    { ctx: LocalChannelContext; reply: AskQuestionnaireReplyPayload } | { handled: true } | null
  > {
    const raw = isRecord(input.raw) ? input.raw : {};
    const update = isRecord(raw.update) ? raw.update : raw;
    const callbackQuery = isRecord(update.callback_query) ? update.callback_query : undefined;
    if (!callbackQuery || typeof callbackQuery.data !== 'string') return null;
    const decoded = decodeTelegramQuestionnaireCallback(callbackQuery.data);
    if (!decoded) return null;

    const callbackQueryId = typeof callbackQuery.id === 'string' ? callbackQuery.id : undefined;
    const sender = await this.resolveSender(input.ctx);
    const pending = this.pendingByChat.get(input.ctx.chatId);
    if (!pending) {
      await answerQuestionnaireCallback(sender, callbackQueryId, '这个问卷已提交或过期');
      return { handled: true };
    }
    if (decoded.rid6 !== pending.rid6) {
      await answerQuestionnaireCallback(sender, callbackQueryId, '这个问卷已过期');
      return { handled: true };
    }
    if (pending.inFlight) {
      await answerQuestionnaireCallback(sender, callbackQueryId, '正在提交，请稍候');
      return { handled: true };
    }
    if (decoded.stepIndex !== pending.currentStepIndex) {
      await answerQuestionnaireCallback(sender, callbackQueryId, '请按当前题目作答');
      return { handled: true };
    }

    const step = pending.request.steps[decoded.stepIndex];
    if (!step) {
      await answerQuestionnaireCallback(sender, callbackQueryId, '这个选项不可用');
      return { handled: true };
    }
    if (decoded.optionIndex === null) {
      await answerQuestionnaireCallback(
        sender,
        callbackQueryId,
        'Telegram 暂不支持 Others，请选择上方选项',
      );
      return { handled: true };
    }
    const option = step.options[decoded.optionIndex];
    if (!option) {
      await answerQuestionnaireCallback(sender, callbackQueryId, '这个选项不可用');
      return { handled: true };
    }

    pending.answers.set(step.id, {
      stepId: step.id,
      selectedOptionIds: [option.id],
      selectedOther: false,
    });
    const nextStepIndex = nextUnansweredStepIndex(pending, decoded.stepIndex + 1);
    if (nextStepIndex === null) {
      // Mark before the callback acknowledgement await so two concurrent
      // final callbacks cannot both produce a host reply.
      pending.inFlight = true;
    }
    await answerQuestionnaireCallback(sender, callbackQueryId, `✓ 已选 ${option.label}`);

    if (nextStepIndex !== null) {
      pending.currentStepIndex = nextStepIndex;
      await editQuestionnaireMessage(
        sender,
        pending,
        formatTelegramStepPrompt(pending.renderable, nextStepIndex),
        buildTelegramStepKeyboard(pending.renderable, nextStepIndex),
      );
      return { handled: true };
    }

    const reply: AskQuestionnaireReplyPayload = {
      schemaVersion: 2,
      requestId: pending.requestId,
      submittedAt: Date.now(),
      answers: orderedAnswers(pending),
    };
    return { ctx: input.ctx, reply };
  }

  async settleReply(input: {
    ctx: LocalChannelContext;
    requestId: string;
    outcome: QuestionnaireReplyOutcome;
  }): Promise<void> {
    const pending = this.pendingByChat.get(input.ctx.chatId);
    if (!pending || pending.requestId !== input.requestId) return;

    if (input.outcome.status === 'retryable') {
      // Restore the retryable state before any Telegram API call. A failed
      // edit must not strand the request in-flight.
      pending.inFlight = false;
      try {
        const sender = await this.resolveSender(input.ctx);
        await editQuestionnaireMessage(
          sender,
          pending,
          formatTelegramStepPrompt(pending.renderable, pending.currentStepIndex),
          buildTelegramStepKeyboard(pending.renderable, pending.currentStepIndex),
        );
      } catch (err) {
        logger.warn(
          { err, requestId: input.requestId },
          'Telegram questionnaire retry edit failed',
        );
      }
      return;
    }

    // Accepted and terminal outcomes consume the in-memory pending before the
    // best-effort terminal card edit.
    this.pendingByChat.delete(input.ctx.chatId);
    try {
      const sender = await this.resolveSender(input.ctx);
      const submitted =
        input.outcome.status === 'accepted' ||
        (input.outcome.status === 'terminal' &&
          input.outcome.code === 'QUESTIONNAIRE_ALREADY_ANSWERED');
      await editQuestionnaireMessage(
        sender,
        pending,
        submitted ? formatTelegramSubmittedText(pending) : '问卷已过期',
        { inline_keyboard: [] },
      );
    } catch (err) {
      logger.warn({ err, requestId: input.requestId }, 'Telegram questionnaire settle edit failed');
    }
  }
}

async function answerQuestionnaireCallback(
  resolved: TelegramQuestionnaireSender,
  callbackQueryId: string | undefined,
  text: string,
): Promise<void> {
  if (!resolved || !callbackQueryId) return;
  try {
    await resolved.sender.answerCallbackQuery(callbackQueryId, { text });
  } catch (err) {
    logger.warn({ err }, 'Telegram answerCallbackQuery failed');
  }
}

async function editQuestionnaireMessage(
  resolved: TelegramQuestionnaireSender,
  pending: TelegramQuestionnairePending,
  text: string,
  replyMarkup?: ReturnType<typeof buildTelegramStepKeyboard>,
): Promise<void> {
  if (!resolved || pending.messageId === undefined) return;
  try {
    await resolved.sender.editMessageText(resolved.chatId, pending.messageId, text, replyMarkup);
  } catch (err) {
    logger.warn(
      { err, chatId: resolved.chatId, messageId: pending.messageId },
      'Telegram editMessageText failed',
    );
  }
}

function telegramRidShort(requestId: string): string {
  const hex = requestId.startsWith('ask_') ? requestId.slice(4) : requestId;
  return hex.slice(0, 6);
}

function nextUnansweredStepIndex(
  pending: TelegramQuestionnairePending,
  startIndex: number,
): number | null {
  for (let index = Math.max(0, startIndex); index < pending.request.steps.length; index += 1) {
    const step = pending.request.steps[index];
    if (!step) continue;
    if (!pending.answers.has(step.id)) return index;
  }
  return null;
}

function orderedAnswers(pending: TelegramQuestionnairePending): AskQuestionnaireReplyAnswer[] {
  const answers: AskQuestionnaireReplyAnswer[] = [];
  for (const step of pending.request.steps) {
    const answer = pending.answers.get(step.id);
    if (answer) answers.push(answer);
  }
  return answers;
}

function formatTelegramSubmittedText(pending: TelegramQuestionnairePending): string {
  const lines: string[] = ['✅ 已提交'];
  if (pending.request.title) {
    lines.push('');
    lines.push(`问卷：${pending.request.title}`);
  }
  for (const [index, step] of pending.request.steps.entries()) {
    const answer = pending.answers.get(step.id);
    const labels = (answer?.selectedOptionIds ?? [])
      .map((id) => step.options.find((option) => option.id === id)?.label)
      .filter((label): label is string => Boolean(label));
    lines.push('');
    lines.push(`${index + 1}. ${step.question}`);
    lines.push(`已选：${labels.join(', ') || '—'}`);
  }
  return lines.join('\n').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
