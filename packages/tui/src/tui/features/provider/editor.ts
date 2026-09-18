import type {
  McodeProviderView,
  McodeSaveProviderCandidateInput,
  McodeSaveProviderCandidateResult,
} from '../../../provider/contract.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import { getKeybindings, Input, Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth } from '../../rendering/text.js';
import { sanitizeTuiUrl } from '../../rendering/url.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';

const FIELDS = ['API Key', 'Base URL', 'Models', 'Alias', 'Test and save'] as const;

export class TuiProviderEditor implements Component, Focusable {
  private selected = 0;
  private editing = false;
  private readonly textInput = new Input({ prompt: '' });
  private readonly secretInput = new Input({ prompt: '', mask: '•' });
  private apiKey = '';
  private baseUrl: string;
  private modelIds: string[];
  private name: string;
  private modelsEdited = false;
  private busy = false;
  private disposed = false;
  private status = '';
  private _focused = false;

  constructor(
    private readonly options: {
      readonly provider: McodeProviderView;
      readonly onSave: (
        input: McodeSaveProviderCandidateInput,
      ) => Promise<McodeSaveProviderCandidateResult>;
      readonly onSaved: (keyChanged: boolean) => void;
      readonly onCancel: () => void;
      readonly requestRender: () => void;
    },
  ) {
    this.baseUrl = options.provider.baseUrl ?? '';
    this.modelIds = options.provider.models.map((model) => model.modelId);
    this.name = options.provider.name;
    this.textInput.onSubmit = (value) => this.commitField(value);
    this.secretInput.onSubmit = (value) => this.commitField(value);
    this.textInput.onEscape = this.secretInput.onEscape = () => this.cancelField();
  }

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.syncFocus();
  }

  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    if (this.editing) {
      (this.selected === 0 ? this.secretInput : this.textInput).handleInput(data);
    } else if (getKeybindings().matches(data, 'tui.select.cancel')) {
      this.options.onCancel();
    } else if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, Key.down) || matchesKey(data, 'tab')) {
      this.selected = (this.selected + 1) % FIELDS.length;
    } else if (matchesKey(data, Key.enter)) {
      if (this.selected === 4) void this.save();
      else this.editField();
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const values = [
      this.apiKey
        ? 'Replacement entered'
        : this.options.provider.hasApiKey
          ? 'Saved key (unchanged)'
          : 'Not configured',
      sanitizeTuiUrl(this.baseUrl),
      this.modelIds.join(', ') || 'No models',
      this.name,
      '',
    ];
    const rows = FIELDS.map((field, index) => {
      const label = `${this.selected === index ? '→' : ' '} ${field}: ${sanitizeTerminalText(values[index] ?? '')}`;
      return this.selected === index ? chalk.hex(colors.signal)(label) : label;
    });
    return [
      chalk.bold.hex(colors.signal)(`Edit ${sanitizeTerminalText(this.options.provider.name)}`),
      chalk.hex(colors.muted)(
        'Changes apply to all models in this connection after a successful test.',
      ),
      '',
      ...rows,
      ...(this.editing
        ? ['', ...(this.selected === 0 ? this.secretInput : this.textInput).render(width)]
        : []),
      ...(this.selected === 2
        ? [
            chalk.hex(colors.dim)(
              'Model IDs separated by commas; remove an ID to remove that model.',
            ),
          ]
        : []),
      ...(this.status ? ['', chalk.hex(colors.error)(sanitizeTerminalText(this.status))] : []),
      '',
      chalk.hex(colors.dim)(
        this.busy
          ? 'Testing and saving…'
          : this.editing
            ? 'Enter keep change · Esc cancel edit'
            : '↑↓ move · Enter edit / save · Esc cancel',
      ),
    ].map((line) => truncateToWidth(line, Math.max(0, width), '…'));
  }

  invalidate(): void {
    this.textInput.invalidate();
    this.secretInput.invalidate();
  }
  dispose(): void {
    this.disposed = true;
    this.apiKey = '';
    this.secretInput.setValue('');
    this.focused = false;
  }

  private editField(): void {
    this.editing = true;
    this.status = '';
    const values = ['', this.baseUrl, this.modelIds.join(', '), this.name];
    const input = this.selected === 0 ? this.secretInput : this.textInput;
    input.setValue(values[this.selected] ?? '');
    input.moveCursorToEnd();
    this.syncFocus();
  }

  private commitField(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
      this.status = 'A value is required. Press Esc to keep the saved value.';
      return;
    }
    if (this.selected === 0) this.apiKey = trimmed;
    if (this.selected === 1) {
      try {
        const url = new URL(trimmed);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
      } catch {
        this.status = 'Base URL must use http or https.';
        return;
      }
      this.baseUrl = trimmed;
    }
    if (this.selected === 2) {
      const ids = [
        ...new Set(
          trimmed
            .split(/[,\n]/u)
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ];
      if (!ids.length) {
        this.status = 'At least one model is required for the connection test.';
        return;
      }
      this.modelIds = ids;
      this.modelsEdited = true;
    }
    if (this.selected === 3) this.name = trimmed;
    this.cancelField();
  }

  private cancelField(): void {
    this.editing = false;
    this.secretInput.setValue('');
    this.status = '';
    this.syncFocus();
  }

  private async save(): Promise<void> {
    const provider = this.options.provider;
    const modelId =
      provider.models.find((model) => model.selected && this.modelIds.includes(model.modelId))
        ?.modelId ?? this.modelIds[0];
    if (!provider.configRevision || !modelId) {
      this.status = !modelId
        ? 'Add a model before testing and saving.'
        : 'Connection details are stale. Reopen /provider.';
      return;
    }
    if (!provider.hasApiKey && !this.apiKey) {
      this.status = 'API Key is required.';
      return;
    }
    this.busy = true;
    this.status = '';
    this.syncFocus();
    try {
      const result = await this.options.onSave({
        providerId: provider.providerId,
        expectedRevision: provider.configRevision,
        name: this.name,
        baseUrl: this.baseUrl,
        ...(provider.apiFormat ? { apiFormat: provider.apiFormat } : {}),
        ...(this.apiKey ? { apiKey: this.apiKey } : {}),
        ...(this.modelsEdited ? { models: this.modelIds.map((id) => ({ modelId: id })) } : {}),
        modelId,
        saveAndUse: false,
      });
      if (this.disposed) return;
      if (!result.success)
        throw new Error(result.status?.lastErrorMessage ?? 'Connection test failed.');
      this.options.onSaved(Boolean(this.apiKey));
    } catch (error) {
      if (this.disposed) return;
      const message = formatTuiActionFailure(error, {
        summary: 'Changes were not saved. The previous connection remains in use.',
        nextStep: 'Check the connection and retry. If it changed elsewhere, reopen /provider.',
      });
      this.status = this.apiKey ? message.split(this.apiKey).join('[redacted]') : message;
    } finally {
      this.busy = false;
      this.syncFocus();
      if (!this.disposed) this.options.requestRender();
    }
  }

  private syncFocus(): void {
    this.secretInput.focused = this._focused && this.editing && !this.busy && this.selected === 0;
    this.textInput.focused = this._focused && this.editing && !this.busy && this.selected !== 0;
  }
}
