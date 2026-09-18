/**
 * In-memory bookkeeping for a Feishu questionnaire card we have rendered
 * but not yet received a submit for. The host card-action handler uses
 * `request` to call `mapFormValueToAnswers` after Feishu posts the form
 * `form_value` back.
 */
export interface FeishuPendingQuestionnaire {
  request: import('@mavis/shared/questionnaire').AskQuestionnaireRequest;
  /** Exact Feishu client that rendered this card; never infer from host default. */
  clientName: string;
  chatId: string;
  messageId: string;
  createdAtMs: number;
}

/**
 * In-memory bookkeeping for a Feishu **permission** card we have rendered but
 * not yet received a click for. Keyed by `requestId` (the button value carries
 * it), so the card-action HTTP handler can resolve the click without the
 * bridge's chatId-keyed pending map — the Feishu card-action path does not flow
 * through the runner. `renderable` feeds the terminal card's tool label;
 * `messageId` is the PATCH target.
 */
export interface FeishuPendingPermission {
  renderable: import('../channels/permission-bridge.js').ChannelRenderablePermission;
  /** Exact Feishu client that rendered this card; never infer from host default. */
  clientName: string;
  chatId: string;
  messageId: string;
  createdAtMs: number;
}
