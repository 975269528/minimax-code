import type { Component } from '../../rendering/component.js';

import type { TuiConfigurationPort, TuiFeedbackPort } from '../../../runtime/port.js';
import {
  TuiLoginRequiredError,
  requireTuiInteractiveAccountLogin,
} from '../../../application/login-gate.js';
import { TuiFeedbackPanel } from '../../features/feedback/panel.js';
import type { TuiChatController } from '../chat-controller.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

type AppendFeedbackNotice = (content: string, kind?: 'warning' | 'error') => void;

export const MINIMAX_CODE_TUI_FEEDBACK_LOGIN_REQUIRED_MESSAGE =
  'Sign in to MiniMax to submit feedback. Run /login, then retry.';

export class FeedbackFlow {
  private activeDraftId: string | undefined;
  private panel: Component | undefined;
  private requestSequence = 0;
  private stopped = false;

  constructor(
    private readonly runtime: TuiFeedbackPort &
      Partial<Pick<TuiConfigurationPort, 'getAccountStatus'>>,
    private readonly controller: TuiChatController,
    private readonly appendNotice: AppendFeedbackNotice,
    private readonly showPanel: (panel: Component) => void,
    private readonly closePanel: (panel?: Component) => boolean,
    private readonly requestRender: () => void,
    private readonly maxRows: () => number,
  ) {}

  async show(description: string): Promise<void> {
    if (this.stopped) return;
    if (!description) {
      this.appendNotice('Usage: /feedback <message>');
      return;
    }
    const requestSequence = ++this.requestSequence;
    this.retireActiveDraft();
    try {
      const sessionId = this.controller.snapshot().session?.sessionId;
      await requireTuiInteractiveAccountLogin(this.runtime, sessionId, () => undefined);
      const preview = await this.runtime.prepareFeedback({
        description,
        ...(sessionId ? { sessionId } : {}),
      });
      if (this.stopped || requestSequence !== this.requestSequence) {
        void this.runtime.cancelFeedback(preview.draftId).catch(() => undefined);
        return;
      }
      this.activeDraftId = preview.draftId;
      const panel = new TuiFeedbackPanel({
        preview,
        maxRows: this.maxRows,
        submit: (draftId, options) => this.runtime.submitFeedback(draftId, options),
        cancel: (draftId) => this.cancelDraft(draftId),
        requestRender: this.requestRender,
        onClose: () => this.close(preview.draftId, panel),
      });
      this.panel = panel;
      this.showPanel(panel);
    } catch (error) {
      if (this.stopped || requestSequence !== this.requestSequence) return;
      const loginRequired = error instanceof TuiLoginRequiredError;
      this.appendNotice(
        loginRequired
          ? MINIMAX_CODE_TUI_FEEDBACK_LOGIN_REQUIRED_MESSAGE
          : formatTuiActionFailure(error, {
              summary: "Couldn't prepare feedback.",
              nextStep: 'Retry /feedback.',
            }),
        loginRequired ? 'warning' : 'error',
      );
    }
  }

  stop(): void {
    this.stopped = true;
    this.requestSequence += 1;
    this.retireActiveDraft();
  }

  private async cancelDraft(draftId: string): Promise<boolean> {
    try {
      return await this.runtime.cancelFeedback(draftId);
    } finally {
      if (this.activeDraftId === draftId) this.activeDraftId = undefined;
    }
  }

  private close(draftId: string, panel: Component): void {
    if (this.activeDraftId === draftId) this.activeDraftId = undefined;
    this.closePanel(panel);
    if (this.panel === panel) this.panel = undefined;
  }

  private retireActiveDraft(): void {
    const draftId = this.activeDraftId;
    const panel = this.panel;
    this.activeDraftId = undefined;
    this.panel = undefined;
    if (panel) this.closePanel(panel);
    if (draftId) void this.runtime.cancelFeedback(draftId).catch(() => undefined);
  }
}
