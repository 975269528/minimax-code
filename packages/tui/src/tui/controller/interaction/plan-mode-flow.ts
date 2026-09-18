import type { TuiPlanClientIntent, TuiSession } from '../../../runtime/port.js';

export type TuiPlanDisplayMode = 'default' | 'plan';
export type TuiPlanTransition = 'next-message' | 'submitting';

export interface TuiPlanModeSnapshot {
  readonly displayMode: TuiPlanDisplayMode;
  readonly transition?: TuiPlanTransition;
}

export interface TuiPlanModeFlowOptions {
  readonly currentSession: () => TuiSession | undefined;
  readonly loadEntryEnabled?: () => Promise<boolean>;
  readonly append: (content: string, kind?: 'final-summary' | 'warning' | 'error') => void;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  readonly isStopped?: () => boolean;
}

interface LocalPlanIntent {
  readonly intent: TuiPlanClientIntent;
  readonly draftKey: string;
}

interface SubmittingPlanIntent extends LocalPlanIntent {
  readonly submissionId: string;
}

export class TuiPlanModeFlow {
  private armed: LocalPlanIntent | undefined;
  private submitting: SubmittingPlanIntent | undefined;
  private acceptedExitDraftKey: string | undefined;
  private entryEnabled: boolean;
  private stopped = false;

  constructor(private readonly options: TuiPlanModeFlowOptions) {
    this.entryEnabled = options.loadEntryEnabled === undefined;
  }

  async refreshCapabilities(): Promise<void> {
    if (!this.options.loadEntryEnabled || this.isStopped()) return;
    this.entryEnabled = false;
    this.clearDisabledEntryIntent();
    this.options.onChanged();
    const entryEnabled = await this.options.loadEntryEnabled();
    if (this.isStopped()) return;
    this.entryEnabled = entryEnabled;
    if (!entryEnabled) this.clearDisabledEntryIntent();
    this.options.onChanged();
  }

  snapshot(): TuiPlanModeSnapshot {
    const session = this.options.currentSession();
    this.dropLocalStateForOtherSession(session);
    const mode = authoritativeMode(session);
    if (this.acceptedExitDraftKey && mode === 'default') {
      this.acceptedExitDraftKey = undefined;
    }
    if (this.submitting && mode === targetMode(this.submitting.intent)) {
      this.submitting = undefined;
      this.options.setHint(undefined);
    }
    if (this.acceptedExitDraftKey) return { displayMode: 'default' };
    const transition = this.armed ?? this.submitting;
    return {
      displayMode: transition ? targetMode(transition.intent) : mode,
      ...(this.armed
        ? { transition: 'next-message' as const }
        : this.submitting
          ? { transition: 'submitting' as const }
          : {}),
    };
  }

  captureClientIntent(): TuiPlanClientIntent | undefined {
    this.dropLocalStateForOtherSession(this.options.currentSession());
    return this.armed?.intent;
  }

  reserveClientIntent(submissionId: string): TuiPlanClientIntent | undefined {
    const session = this.options.currentSession();
    this.dropLocalStateForOtherSession(session);
    if (!this.armed || this.submitting) return undefined;
    const intent = this.armed.intent;
    this.submitting = { ...this.armed, submissionId };
    this.armed = undefined;
    this.options.setHint(`${modeLabel(targetMode(intent))} Mode change submitting…`);
    this.options.onChanged();
    return intent;
  }

  bindSubmissionToSession(submissionId: string, sessionId: string): void {
    const submitting = this.submitting;
    if (
      !submitting ||
      submitting.submissionId !== submissionId ||
      submitting.draftKey !== NEW_SESSION_DRAFT_KEY
    ) {
      return;
    }
    this.submitting = { ...submitting, draftKey: sessionId };
  }

  acceptDirect(
    intent: TuiPlanClientIntent | undefined,
    sessionId: string,
    submissionId?: string,
  ): void {
    if (!intent || this.isStopped()) return;
    const accepted = this.takeSubmitting(intent, submissionId);
    if (!accepted || this.options.currentSession()?.sessionId !== sessionId) return;
    if (intent === 'plan-exit' && authoritativeMode(this.options.currentSession()) === 'plan') {
      this.acceptedExitDraftKey = sessionId;
    }
    this.options.setHint(undefined);
    this.options.onChanged();
  }

  rejectSubmission(submissionId: string): void {
    const rejected = this.submitting;
    if (!rejected || rejected.submissionId !== submissionId) return;
    this.submitting = undefined;
    const session = this.options.currentSession();
    if (rejected.draftKey !== currentDraftKey(session)) return;
    if (authoritativeMode(session) === targetMode(rejected.intent)) {
      this.options.setHint(undefined);
      this.options.onChanged();
      return;
    }
    this.arm(rejected.intent, session);
  }

  acceptQueued(
    intent: TuiPlanClientIntent | undefined,
    sessionId: string,
    _itemId: string,
    submissionId?: string,
  ): void {
    if (!intent || this.isStopped()) return;
    const accepted = this.takeSubmitting(intent, submissionId);
    if (!accepted || this.options.currentSession()?.sessionId !== sessionId) return;
    if (intent === 'plan-exit' && authoritativeMode(this.options.currentSession()) === 'plan') {
      this.acceptedExitDraftKey = sessionId;
    }
    this.options.setHint(undefined);
    this.options.onChanged();
  }

  restoreQueued(intent: TuiPlanClientIntent, sessionId: string): void {
    if (this.isStopped() || this.options.currentSession()?.sessionId !== sessionId) return;
    this.acceptedExitDraftKey = undefined;
    this.armed = { intent, draftKey: currentDraftKey(this.options.currentSession()) };
    this.options.setHint(
      intent === 'plan-entry'
        ? 'Plan Mode · restored message will enter Plan'
        : 'Default Mode · restored message will exit Plan',
    );
    this.options.onChanged();
  }

  toggle(): void {
    if (this.isStopped()) return;
    const session = this.options.currentSession();
    this.dropLocalStateForOtherSession(session);
    // Once a plan-exit has been accepted by the Runtime, the Composer projection
    // is locked to the "accepted-exit" state until authoritative Session
    // metadata catches up. Ignore subsequent toggles so the next user input
    // never re-enters Plan against the still-updating Session.
    if (this.acceptedExitDraftKey) return;
    if (this.submitting) {
      this.options.setHint('Plan mode change is already being submitted.');
      this.options.onChanged();
      return;
    }
    if (this.armed) {
      this.armed = undefined;
      this.options.setHint(undefined);
      this.options.onChanged();
      return;
    }
    const intent: TuiPlanClientIntent =
      authoritativeMode(session) === 'plan' ? 'plan-exit' : 'plan-entry';
    if (intent === 'plan-entry' && !this.entryEnabled) {
      this.options.append('Plan Mode entry is disabled by the Runtime configuration.', 'warning');
      this.options.setHint(undefined);
      this.options.onChanged();
      return;
    }
    this.acceptedExitDraftKey = undefined;
    this.arm(intent, session);
  }

  set(mode: TuiPlanDisplayMode): void {
    if (this.isStopped()) return;
    const snapshot = this.snapshot();
    if (snapshot.displayMode === mode) {
      this.options.setHint(`${modeLabel(mode)} Mode is selected`);
      this.options.onChanged();
      return;
    }
    this.toggle();
  }

  showStatus(): void {
    const snapshot = this.snapshot();
    const suffix =
      snapshot.transition === 'next-message'
        ? ' on the next message'
        : snapshot.transition === 'submitting'
          ? ' while the current message is admitted'
          : '';
    this.options.append(`${modeLabel(snapshot.displayMode)} Mode${suffix}.`);
  }

  stop(): void {
    this.stopped = true;
    this.armed = undefined;
    this.submitting = undefined;
    this.acceptedExitDraftKey = undefined;
  }

  private arm(intent: TuiPlanClientIntent, session: TuiSession | undefined): void {
    this.armed = { intent, draftKey: currentDraftKey(session) };
    this.options.setHint(
      intent === 'plan-entry'
        ? 'Plan Mode · next message enters Plan'
        : 'Default Mode · next message exits Plan',
    );
    this.options.onChanged();
  }

  private takeSubmitting(
    intent: TuiPlanClientIntent,
    submissionId?: string,
  ): SubmittingPlanIntent | undefined {
    const submitting = this.submitting;
    if (
      !submitting ||
      submitting.intent !== intent ||
      (submissionId !== undefined && submitting.submissionId !== submissionId)
    ) {
      return undefined;
    }
    this.submitting = undefined;
    return submitting;
  }

  private dropLocalStateForOtherSession(session: TuiSession | undefined): void {
    const draftKey = currentDraftKey(session);
    const dropArmed = Boolean(this.armed && this.armed.draftKey !== draftKey);
    const dropSubmitting = Boolean(this.submitting && this.submitting.draftKey !== draftKey);
    const dropAcceptedExit = Boolean(
      this.acceptedExitDraftKey && this.acceptedExitDraftKey !== draftKey,
    );
    if (dropArmed) this.armed = undefined;
    if (dropSubmitting) this.submitting = undefined;
    if (dropAcceptedExit) this.acceptedExitDraftKey = undefined;
    if (dropArmed || dropSubmitting || dropAcceptedExit) this.options.setHint(undefined);
  }

  private isStopped(): boolean {
    return this.stopped || Boolean(this.options.isStopped?.());
  }

  private clearDisabledEntryIntent(): void {
    if (this.armed?.intent !== 'plan-entry') return;
    this.armed = undefined;
    this.options.setHint(undefined);
  }
}

const NEW_SESSION_DRAFT_KEY = 'new-session-draft';

function currentDraftKey(session: TuiSession | undefined): string {
  return session?.sessionId ?? NEW_SESSION_DRAFT_KEY;
}

function authoritativeMode(session: TuiSession | undefined): TuiPlanDisplayMode {
  return session?.interactionMode === 'plan' ? 'plan' : 'default';
}

function targetMode(intent: TuiPlanClientIntent): TuiPlanDisplayMode {
  return intent === 'plan-entry' ? 'plan' : 'default';
}

function modeLabel(mode: TuiPlanDisplayMode): 'Plan' | 'Default' {
  return mode === 'plan' ? 'Plan' : 'Default';
}
