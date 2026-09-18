import type {
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';

import type {
  ChannelOutboundResult,
  ChannelQuestionnaire,
  LocalChannelPlatformAdapter,
} from './adapter.js';
import type { LocalChannelContext } from './infra.js';
import type { ChannelPlatform } from './route-api.js';

/**
 * Platform-agnostic questionnaire bridge for the IM channel layer.
 *
 * MR-C §D4 splits the `ask_user` round-trip across two seams:
 *
 *   1. The **core** (this file) owns the lifecycle. It tells an adapter to
 *      `present()` a {@link ChannelQuestionnaire} and, after the user picks an
 *      answer, accepts a structured {@link AskQuestionnaireReplyPayload}
 *      (already decoded by the adapter) and forwards it to the host-supplied
 *      `onSubmit` continuation. The host wires `onSubmit` to the existing
 *      questionnaire store + session continuation hook, so the bridge never
 *      imports the questionnaire api or the session controller directly.
 *
 *   2. The **adapter** owns the wire-format. A Feishu adapter encodes the
 *      questionnaire as an interactive card and decodes Feishu's
 *      card-action callback back into {@link AskQuestionnaireReplyPayload};
 *      a Telegram / WeChat adapter is free to either render numbered-text
 *      fallback or ignore the payload entirely (the `present` method is a
 *      pure pass-through so adapters control the rendering, the bridge does
 *      not branch per platform).
 *
 * The bridge intentionally does NOT import any concrete platform
 * (`./feishu*`, `./telegram*`, `./wechat*`). The IM architecture guard
 * (`scripts/quality/im-architecture-guard.mjs`) does not enforce this on the
 * bridge today, but the same contract that keeps `runner.ts` adapter-agnostic
 * applies here — adding a platform import would force the bridge to grow a
 * per-platform branch and break the §D4 split.
 *
 * Multi-instance is a first-class concern: every call site carries an
 * explicit `(adapter, ctx)` pair, so two Feishu bots bound under different
 * `clientName`s never share questionnaire state through this layer.
 */

/**
 * Continuation hook the host wires to its questionnaire store / session
 * controller. The bridge invokes it once a structured reply has been
 * received from an adapter; the host owns the side-effects (persist reply,
 * resume the suspended turn, emit `questionnaire.answer`).
 *
 * MUST tolerate concurrent calls for distinct `requestId`s — two users
 * answering two different cards on the same Feishu bot at the same time is a
 * normal load pattern.
 */
export interface ChannelQuestionnaireSubmitHandler {
  (input: { ctx: LocalChannelContext; reply: AskQuestionnaireReplyPayload }): Promise<void>;
}

export interface LocalChannelQuestionnaireBridgeOptions {
  /**
   * Called when an adapter has fully decoded an answer into the structured
   * reply payload. Default behaviour when omitted: no-op (useful in unit
   * tests that only assert the encode → decode round-trip).
   */
  onSubmit?: ChannelQuestionnaireSubmitHandler;
  /**
   * Time source for `submittedAt` defaults. Defaults to `Date.now`. Tests
   * inject a frozen clock so the asserted `submittedAt` is deterministic.
   */
  nowMs?: () => number;
}

/**
 * Bridge instance. Stateless apart from the injected hooks — safe to share
 * across all platform adapters and all clientNames.
 */
export class LocalChannelQuestionnaireBridge {
  private readonly onSubmit: ChannelQuestionnaireSubmitHandler;
  private readonly nowMs: () => number;

  constructor(options: LocalChannelQuestionnaireBridgeOptions = {}) {
    this.onSubmit = options.onSubmit ?? (async () => undefined);
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Render a questionnaire by handing it to the adapter's unified outbound
   * channel. The bridge does NOT translate the payload — it stays in
   * {@link ChannelQuestionnaire} (= {@link AskQuestionnaireRequest}) form so
   * the adapter's wire-encoder consumes the same value object the rest of
   * the runtime (UI composer, questionnaire store) already speaks.
   *
   * The optional `text` is sent alongside the questionnaire so platforms
   * that ignore the structured field (numbered-text fallback) still receive
   * the human-readable form. Defaults to the questionnaire title, or to an
   * empty string when no title is set.
   */
  present(input: {
    adapter: LocalChannelPlatformAdapter;
    ctx: LocalChannelContext;
    questionnaire: ChannelQuestionnaire;
    text?: string;
    sessionId?: string;
    queueItemId?: string;
  }): Promise<ChannelOutboundResult> {
    const text =
      input.text ?? input.questionnaire.title ?? input.questionnaire.steps[0]?.question ?? '';
    if (input.adapter.renderQuestionnaire) {
      return input.adapter
        .renderQuestionnaire({
          ctx: input.ctx,
          renderable: toRenderableQuestionnaire(input.questionnaire),
        })
        .then((result) => ({
          id: result.outboundMessageId ?? '',
          status: 'sent',
        }));
    }
    return input.adapter.sendMessage({
      ctx: input.ctx,
      text,
      questionnaire: input.questionnaire,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
    });
  }

  /**
   * Accept a decoded reply from an adapter and hand it to the host's
   * continuation. Adapters call this after they have parsed their native
   * action payload (Feishu card action, Telegram numbered text reply, …)
   * into the canonical {@link AskQuestionnaireReplyPayload} shape — the
   * bridge never inspects the wire format itself.
   *
   * `submittedAt` is filled in from {@link LocalChannelQuestionnaireBridgeOptions.nowMs}
   * if the adapter did not provide one, so the reply payload is always
   * well-formed even when the platform callback omits a timestamp.
   */
  async submit(input: {
    ctx: LocalChannelContext;
    reply: AskQuestionnaireReplyPayload;
  }): Promise<void> {
    const reply = input.reply.submittedAt
      ? input.reply
      : { ...input.reply, submittedAt: this.nowMs() };
    await this.onSubmit({ ctx: input.ctx, reply });
  }

  /**
   * Build a canonical {@link AskQuestionnaireReplyPayload} from a flat list
   * of per-step selections. Adapters that receive a structured option-id
   * payload (Feishu card action, Telegram callback_query) call this helper
   * so the schema-version + tail invariants stay centralised.
   *
   * Each `answer` MAY carry its own `selectedOther` / `otherText` /
   * `skipped` flags; defaults match the V2 schema (no Others, not skipped).
   * Unknown extra keys are dropped — only the well-known fields survive.
   */
  buildReply(input: {
    requestId: string;
    answers: ReadonlyArray<Partial<AskQuestionnaireReplyAnswer> & { stepId: string }>;
    submittedAt?: number;
  }): AskQuestionnaireReplyPayload {
    return {
      schemaVersion: 2,
      requestId: input.requestId,
      answers: input.answers.map((raw) => ({
        stepId: raw.stepId,
        selectedOptionIds: Array.isArray(raw.selectedOptionIds) ? [...raw.selectedOptionIds] : [],
        selectedOther: raw.selectedOther === true,
        ...(typeof raw.otherText === 'string' ? { otherText: raw.otherText } : {}),
        ...(raw.skipped === true ? { skipped: true } : {}),
      })),
      submittedAt: input.submittedAt ?? this.nowMs(),
    };
  }
}

export function toRenderableQuestionnaire(
  questionnaire: AskQuestionnaireRequest,
): ChannelRenderableQuestionnaire {
  return {
    requestId: questionnaire.id,
    ...(questionnaire.title ? { title: questionnaire.title } : {}),
    steps: questionnaire.steps.map((step) => ({
      stepId: step.id,
      question: step.question,
      ...(step.description ? { description: step.description } : {}),
      selectionMode: step.selectionMode,
      allowOther: true,
      options: step.options.map((option) => ({
        optionId: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    })),
  };
}

/**
 * Encoded "value" payload an adapter must round-trip on every interactive
 * element so a platform callback can be decoded back into a structured
 * answer without a server-side lookup. Adapters embed one of these on each
 * card button / inline keyboard entry / numbered option.
 *
 * Kept tiny by design — Feishu interactive card values cap around 1024 chars
 * and Telegram callback_data caps at 64 bytes, so we avoid free-form fields
 * here and let the adapter compress / split when it hits a wire limit.
 */
export interface ChannelQuestionnaireOptionToken {
  /** Schema discriminator so two coexisting questionnaire schemas can fan-out. */
  v: 1;
  /** AskQuestionnaireRequest.id — the questionnaire instance. */
  r: string;
  /** AskQuestionStep.id — which step this option belongs to. */
  s: string;
  /** AskQuestionOption.id — the picked option, or `null` for the Others chip. */
  o: string | null;
}

/**
 * Renderable view of a questionnaire that platform adapters convert into
 * platform-native UI (Feishu interactive card / Telegram inline keyboard /
 * WeChat numbered-text). This shape is intentionally narrower than the raw
 * {@link AskQuestionnaireRequest} — adapters need only what the wire form
 * actually renders, not the full continuation metadata.
 *
 * MR-D1 adds this type alongside {@link ChannelQuestionnairePending} so the
 * WeChat numbered-text helpers can stay platform-agnostic without
 * inventing their own private types.
 */
export interface ChannelRenderableQuestionnaire {
  requestId: string;
  title?: string;
  steps: ChannelRenderableStep[];
}

export interface ChannelRenderableStep {
  stepId: string;
  question: string;
  description?: string;
  selectionMode: 'single' | 'multiple';
  options: ChannelRenderableOption[];
  /** Always true — the shared schema pins `allowOther` to true on every step. */
  allowOther: boolean;
}

export interface ChannelRenderableOption {
  optionId: string;
  label: string;
  description?: string;
}

/**
 * Adapter-owned bookkeeping for an outstanding questionnaire. Each adapter
 * keeps a per-chat map of these so an inbound reply can be matched back to
 * the original request without a server-side lookup.
 */
export interface ChannelQuestionnairePending {
  requestId: string;
  platform: ChannelPlatform;
  clientName: string;
  chatId: string;
  /** Feishu card message_id / numbered-text message id, for inbound reply correlation. */
  outboundMessageId?: string;
  request: AskQuestionnaireRequest;
  createdAt: number;
  /** True after a complete reply is forwarded and before host settlement. */
  inFlight?: boolean;
}

/**
 * Decoder for a single Feishu card-action payload that an adapter has already
 * extracted from the wire shape. Centralised here so the same decode logic
 * stays test-covered independently of the SDK transport.
 *
 * Feishu interactive card action callback shape (simplified):
 *
 *   {
 *     token: '...',
 *     action: { value: '<json>' | { ... }, tag: 'button' | 'select' | 'overflow' },
 *     ...
 *   }
 *
 * The adapter passes `action.value` (already JSON-parsed if it was a string)
 * and the questionnaire instance the bridge should match against. Returns
 * `undefined` when the value does not look like a questionnaire-option token
 * — the adapter then treats the click as an unrelated card and ignores it,
 * which is the safer default than throwing.
 */
export function decodeQuestionnaireOptionToken(
  value: unknown,
): ChannelQuestionnaireOptionToken | undefined {
  const parsed = parseTokenLike(value);
  if (!parsed) return undefined;
  if (parsed.v !== 1) return undefined;
  if (typeof parsed.r !== 'string' || !parsed.r) return undefined;
  if (typeof parsed.s !== 'string' || !parsed.s) return undefined;
  if (parsed.o !== null && typeof parsed.o !== 'string') return undefined;
  return { v: 1, r: parsed.r, s: parsed.s, o: parsed.o };
}

/** Strict serialiser used by every adapter — matches {@link decodeQuestionnaireOptionToken}. */
export function encodeQuestionnaireOptionToken(token: ChannelQuestionnaireOptionToken): string {
  return JSON.stringify({ v: token.v, r: token.r, s: token.s, o: token.o });
}

function parseTokenLike(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
