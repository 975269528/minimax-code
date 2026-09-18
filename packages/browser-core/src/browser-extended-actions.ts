import { BrowserActionSupport } from './browser-actions.js';
import {
  asNumber,
  cdp,
  delay,
  stringArray,
  type BrowserSessionState as SessionState,
} from './browser-state.js';
import { IsolatedClipboardProvider, type ClipboardProvider } from './clipboard.js';

const ACTION_SETTLE_DELAY_MS = 100;

interface CheckableState {
  checkable: boolean;
  checked: boolean;
}

interface SelectMutationState {
  selectable: boolean;
  multiple: boolean;
  missingValues: string[];
  selectedValues: string[];
}

interface SelectState {
  selectable: boolean;
  multiple: boolean;
  selectedValues: string[];
}

export abstract class BrowserExtendedActionSupport extends BrowserActionSupport {
  protected readonly clipboardProvider: ClipboardProvider;

  protected constructor(clipboardProvider: ClipboardProvider = new IsolatedClipboardProvider()) {
    super();
    this.clipboardProvider = clipboardProvider;
  }

  protected async setChecked(
    session: SessionState,
    input: Record<string, unknown>,
    checked: boolean,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const target = await this.resolveTarget(session, input, true, true);
    if (target.backendNodeId === undefined) throw new Error('CHECK_REQUIRES_ELEMENT_REF');
    const before = await this.callBackendNode<CheckableState>(
      session,
      target.backendNodeId,
      `function () {
        const type = this instanceof HTMLInputElement ? String(this.type || '').toLowerCase() : '';
        const checkable = type === 'checkbox' || type === 'radio';
        return { checkable, checked: checkable ? Boolean(this.checked) : false };
      }`,
    );
    if (!before?.checkable) {
      return {
        success: false,
        code: 'TARGET_NOT_CHECKABLE',
        error: 'Browser check target is not a checkbox or radio input.',
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: target.rect },
        effect: { dispatched: false, verified: false },
      };
    }
    if (before.checked !== checked) {
      await session.beforePointerAction?.(
        { action: checked ? 'check' : 'uncheck', point: { x: target.x, y: target.y } },
        session.commandSignal,
      );
      await this.dispatchMouse(session, target.x, target.y, 'mouseMoved');
      await delay(50, session.commandSignal);
      await this.dispatchMouse(session, target.x, target.y, 'mousePressed', {
        button: 'left',
        clickCount: 1,
      });
      await this.dispatchMouse(session, target.x, target.y, 'mouseReleased', {
        button: 'left',
        clickCount: 1,
      });
      await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    }
    const after = await this.callBackendNode<CheckableState>(
      session,
      target.backendNodeId,
      `function () {
        const type = this instanceof HTMLInputElement ? String(this.type || '').toLowerCase() : '';
        const checkable = type === 'checkbox' || type === 'radio';
        return { checkable, checked: checkable ? Boolean(this.checked) : false };
      }`,
    );
    const dispatched = before.checked !== checked;
    const verified = after?.checkable === true && after.checked === checked;
    this.invalidateObservation(session);
    const result = {
      success: verified,
      durationMs: Date.now() - startedAt,
      target: { resolved: true, rect: target.rect },
      effect: { dispatched, verified, checked: after?.checked },
    } as Record<string, unknown>;
    if (!verified) {
      result.code = after?.checkable === false ? 'TARGET_NOT_CHECKABLE' : 'CHECK_STATE_NOT_APPLIED';
      result.error =
        after?.checkable === false
          ? 'Browser check target is no longer a checkbox or radio input.'
          : `Browser ${checked ? 'check' : 'uncheck'} was dispatched, but the requested state was not retained.`;
      result.recovery =
        'Inspect the current target state before retrying; the page may reject or control this field.';
    }
    return result;
  }

  protected async selectOption(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const target = await this.resolveTarget(session, input, true, false);
    if (target.backendNodeId === undefined) throw new Error('SELECT_REQUIRES_ELEMENT_REF');
    const values = Array.from(new Set(stringArray(input.values)));
    if (values.length === 0) throw new Error('SELECT_REQUIRES_VALUES');
    const mutation = await this.callBackendNode<SelectMutationState>(
      session,
      target.backendNodeId,
      `function (wanted) {
        if (!(this instanceof HTMLSelectElement)) {
          return {
            selectable: false,
            multiple: false,
            missingValues: [],
            selectedValues: [],
          };
        }
        const values = Array.from(new Set(Array.isArray(wanted) ? wanted.map(String) : []));
        const options = Array.from(this.options || []);
        const multiple = Boolean(this.multiple);
        if (!multiple && values.length > 1) {
          return {
            selectable: true,
            multiple,
            missingValues: [],
            selectedValues: Array.from(this.selectedOptions, (option) => String(option.value)),
          };
        }
        const available = new Set(options.map((option) => String(option.value)));
        const missingValues = values.filter((value) => !available.has(value));
        if (missingValues.length > 0) {
          return {
            selectable: true,
            multiple,
            missingValues,
            selectedValues: Array.from(this.selectedOptions, (option) => String(option.value)),
          };
        }
        const requested = new Set(values);
        for (const option of options) option.selected = requested.has(String(option.value));
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          selectable: true,
          multiple,
          missingValues: [],
          selectedValues: Array.from(this.selectedOptions, (option) => String(option.value)),
        };
      }`,
      [{ value: values }],
    );
    if (!mutation?.selectable) {
      return {
        success: false,
        code: 'TARGET_NOT_SELECT',
        error: 'Browser select_option target is not a select element.',
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: target.rect },
        effect: { dispatched: false, verified: false, selectedValues: [] },
      };
    }
    if (values.length > 1 && mutation.multiple !== true) {
      return {
        success: false,
        code: 'SELECT_MULTIPLE_VALUES_NOT_ALLOWED',
        error: 'Browser select_option received multiple values for a single-select element.',
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: target.rect },
        effect: {
          dispatched: false,
          verified: false,
          selectedValues: mutation.selectedValues,
        },
        recovery: 'Choose exactly one option value for this select element.',
      };
    }
    if (mutation.missingValues.length > 0) {
      return {
        success: false,
        code: 'SELECT_OPTION_NOT_FOUND',
        error: `Browser select_option could not find requested option value(s): ${mutation.missingValues.join(', ')}`,
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: target.rect },
        effect: {
          dispatched: false,
          verified: false,
          selectedValues: mutation.selectedValues,
        },
      };
    }
    await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    const after = await this.callBackendNode<SelectState>(
      session,
      target.backendNodeId,
      `function () {
        if (!(this instanceof HTMLSelectElement)) {
          return { selectable: false, multiple: false, selectedValues: [] };
        }
        return {
          selectable: true,
          multiple: Boolean(this.multiple),
          selectedValues: Array.from(this.selectedOptions, (option) => String(option.value)),
        };
      }`,
    );
    const selectedValues = after?.selectedValues ?? [];
    const verified =
      after?.selectable === true &&
      after.multiple === mutation.multiple &&
      sameStringSet(selectedValues, values);
    this.invalidateObservation(session);
    const result = {
      success: verified,
      durationMs: Date.now() - startedAt,
      target: { resolved: true, rect: target.rect },
      effect: { dispatched: true, verified, selectedValues },
    } as Record<string, unknown>;
    if (!verified) {
      result.code = after?.selectable === false ? 'TARGET_NOT_SELECT' : 'SELECT_STATE_NOT_APPLIED';
      result.error =
        after?.selectable === false
          ? 'Browser select_option target is no longer a select element.'
          : 'Browser select_option was dispatched, but the requested selection was not retained.';
      result.recovery =
        'Inspect the current selected value before retrying; the page may reject or control this field.';
    }
    return result;
  }

  protected async uploadFiles(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const beforeGeneration = session.generation;
    const target = await this.resolveTarget(session, input, false, false);
    if (target.backendNodeId === undefined) throw new Error('UPLOAD_REQUIRES_ELEMENT_REF');
    const authorizedFiles = Array.isArray(input.files)
      ? input.files
          .filter((file): file is Record<string, unknown> =>
            Boolean(file && typeof file === 'object' && !Array.isArray(file)),
          )
          .map((file) => (typeof file.filePath === 'string' ? file.filePath : ''))
          .filter(Boolean)
      : [];
    const paths = stringArray(input.paths).concat(authorizedFiles);
    if (paths.length === 0) throw new Error('UPLOAD_REQUIRES_PATHS');
    const requestedTimeout = Number(input.timeout);
    const chooserTimeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(120_000, Math.floor(requestedTimeout))
        : 30_000;
    // The mature chooser workflow currently operates on the root CDP session.
    // Preserve the existing session-scoped direct input behavior for OOPIFs;
    // main-frame buttons and custom controls use the chooser-aware path.
    const upload = session.commandSessionId
      ? await this.uploadFilesInAttachedFrame(session, target.backendNodeId, paths)
      : await session.cdpHelper.uploadFilesByBackendNodeId(target.backendNodeId, paths, {
          timeoutMs: chooserTimeoutMs,
          ...(session.commandSignal ? { signal: session.commandSignal } : {}),
        });
    const observedGeneration = session.generation;
    const navigationDetected = observedGeneration !== beforeGeneration;
    const verified = upload.filesAttached === paths.length && !navigationDetected;
    this.invalidateObservation(session);
    const result = {
      success: verified,
      durationMs: Date.now() - startedAt,
      filesAttached: upload.filesAttached,
      chooserOpened: upload.chooserOpened,
      target: { resolved: true, rect: target.rect },
      effect: {
        dispatched: true,
        verified,
        fileCount: upload.filesAttached,
        chooserOpened: upload.chooserOpened,
      },
      navigation: {
        detected: navigationDetected,
        generation: observedGeneration,
      },
    } as Record<string, unknown>;
    if (navigationDetected) {
      result.code = 'UNEXPECTED_NAVIGATION';
      result.error = 'File upload changed the active Browser page unexpectedly.';
      result.retryable = true;
      result.recovery =
        'Inspect the current page before deciding whether the upload should be repeated.';
    }
    return result;
  }

  private async uploadFilesInAttachedFrame(
    session: SessionState,
    backendNodeId: number,
    paths: string[],
  ): Promise<{ filesAttached: number; chooserOpened: false }> {
    await cdp(session, 'DOM.setFileInputFiles', { backendNodeId, files: paths });
    const filesAttached = await this.callBackendNode<number>(
      session,
      backendNodeId,
      'function () { return this.files ? this.files.length : 0; }',
    );
    if (filesAttached !== paths.length) {
      throw new Error('FILE_UPLOAD_NOT_OBSERVED: selected file count did not match');
    }
    return { filesAttached, chooserOpened: false };
  }

  protected async paste(session: SessionState, input: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const targetInput = input.ref || input.selector ? input : undefined;
    const target = targetInput
      ? await this.resolveTarget(session, targetInput, true, false)
      : { x: 0, y: 0, rect: undefined, backendNodeId: undefined };
    if (target.backendNodeId !== undefined) {
      await cdp(session, 'DOM.focus', { backendNodeId: target.backendNodeId });
      if (input.clear === true) {
        await session.cdpHelper.selectAllAtCurrentFocus({
          ...(session.commandSignal ? { signal: session.commandSignal } : {}),
          ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
        });
        await this.dispatchKey(session, 'Backspace', []);
      }
    }
    const explicitText = typeof input.text === 'string' ? input.text : undefined;
    const text = explicitText ?? (await this.clipboardProvider.read()).text;
    if (text.length === 0 && typeof input.html !== 'string') {
      throw new Error('PASTE_REQUIRES_CONTENT');
    }
    if (typeof input.html === 'string' && text.length === 0) {
      throw new Error('PASTE_HTML_REQUIRES_PLAIN_TEXT_FALLBACK');
    }
    await cdp(session, 'Input.insertText', { text });
    const waitMs = Math.max(0, Math.floor(asNumber(input.waitMs, ACTION_SETTLE_DELAY_MS)));
    if (waitMs > 0) await delay(waitMs, session.commandSignal);
    this.invalidateObservation(session);
    return {
      success: true,
      durationMs: Date.now() - startedAt,
      target: { resolved: Boolean(targetInput), ...(target.rect ? { rect: target.rect } : {}) },
      effect: {
        dispatched: true,
        verified: false,
        verificationRequired: true,
        textLength: text.length,
      },
    };
  }

  protected async callBackendNode<T = unknown>(
    session: SessionState,
    backendNodeId: number,
    functionDeclaration: string,
    args: Array<Record<string, unknown>> = [],
  ): Promise<T> {
    const resolved = await cdp<{ object?: { objectId?: string } }>(session, 'DOM.resolveNode', {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error('TARGET_NOT_RESOLVED');
    try {
      const result = await cdp<{
        result?: { value?: unknown };
        exceptionDetails?: { text?: string };
      }>(session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'TARGET_SCRIPT_FAILED');
      }
      return result.result?.value as T;
    } finally {
      await cdp(session, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}
