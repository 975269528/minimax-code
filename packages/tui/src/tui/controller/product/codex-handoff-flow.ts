import {
  findRecentCodexSession,
  type RecentCodexSession,
} from '../../../host/recent-codex-session.js';
import type { CreateTuiAppOptions } from '../../../types/tui-app.js';
import type { TuiComposerDraft } from '../../features/composer/draft.js';
import { formatTuiKeybinding } from '../../shell/keybindings.js';
import type { TranscriptStore } from '../../transcript/store.js';
import type { Editor } from '../../widgets/editor/editor.js';
import type { TuiChatController } from '../chat-controller.js';
import type { TuiChromeFlow } from './chrome-flow.js';
import type { TuiFeatureFlow } from './feature-flow.js';

interface TuiCodexHandoffFlowOptions {
  readonly app: Pick<
    CreateTuiAppOptions,
    'workspaceDir' | 'homeDir' | 'keybindings' | 'findRecentCodexSession'
  >;
  readonly skills: Pick<TuiFeatureFlow, 'refreshSkillCommands' | 'skillCommands'>;
  readonly controller: Pick<TuiChatController, 'snapshot'>;
  readonly liveRunId: () => string | undefined;
  readonly transcript: Pick<TranscriptStore, 'snapshot'>;
  readonly editor: Pick<Editor, 'getExpandedText'>;
  readonly composerDraft: Pick<TuiComposerDraft, 'hasContent'>;
  readonly isStopped: () => boolean;
  readonly chrome: () => Pick<TuiChromeFlow, 'setWelcomeTip'> | undefined;
  readonly onChanged: () => void;
}

export class TuiCodexHandoffFlow {
  private pristine = true;
  private recentSession: RecentCodexSession | undefined;

  constructor(private readonly options: TuiCodexHandoffFlowOptions) {}

  take(): RecentCodexSession | undefined {
    if (!this.isEligible()) return undefined;
    const session = this.recentSession;
    if (!session) return undefined;
    this.recentSession = undefined;
    this.pristine = false;
    this.options.chrome()?.setWelcomeTip(undefined);
    return session;
  }

  restore(session: RecentCodexSession): void {
    if (!this.isEligible(true)) return;
    this.recentSession = session;
    this.pristine = true;
    this.showTip();
  }

  dismiss(): void {
    if (!this.pristine && !this.recentSession) return;
    this.pristine = false;
    this.recentSession = undefined;
    this.options.chrome()?.setWelcomeTip(undefined);
  }

  async detect(): Promise<void> {
    await this.options.skills.refreshSkillCommands();
    if (!this.options.skills.skillCommands().some((command) => command.name === 'resume-codex')) {
      return;
    }
    const session = await (this.options.app.findRecentCodexSession ?? findRecentCodexSession)({
      workspaceDir: this.options.app.workspaceDir,
      ...(this.options.app.homeDir ? { homeDir: this.options.app.homeDir } : {}),
    });
    if (!session || !this.isEligible()) return;
    this.recentSession = session;
    this.showTip();
  }

  private isEligible(ignorePristine = false): boolean {
    return (
      (ignorePristine || this.pristine) &&
      !this.options.isStopped() &&
      !this.options.controller.snapshot().session &&
      !this.options.liveRunId() &&
      this.options.transcript.snapshot().length === 0 &&
      this.options.editor.getExpandedText().length === 0 &&
      !this.options.composerDraft.hasContent()
    );
  }

  private showTip(): void {
    const resumeKey = formatTuiKeybinding('welcome.resume-codex', this.options.app.keybindings);
    this.options.chrome()?.setWelcomeTip({
      id: 'codex-handoff',
      command: 'resume-codex',
      text: `Tip: ${resumeKey} resumes your recent Codex session`,
      shortText: `Tip: ${resumeKey} resumes Codex`,
    });
    this.options.onChanged();
  }
}
