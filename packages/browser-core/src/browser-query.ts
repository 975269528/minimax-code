import {
  asNumber,
  asString,
  byteLength,
  evaluate,
  getBrowserSnapshot,
  isRecord,
  type ElementRecord,
  type Snapshot,
  stringArray,
  type BrowserSessionState as SessionState,
} from './browser-state.js';
import { BrowserSnapshotSupport } from './browser-snapshot.js';
import { exposeElement } from './browser-snapshot-helpers.js';
import {
  sanitizeConsoleDiagnosticUrl,
  type CDPConsoleDiagnosticLevelFilter,
  type CDPNetworkDiagnosticResourceType,
  type CDPNetworkDiagnosticStatusFilter,
} from './cdp-helper.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';

const NON_EDITABLE_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'file',
  'hidden',
  'image',
  'radio',
  'reset',
  'submit',
]);

export abstract class BrowserQuerySupport extends BrowserSnapshotSupport {
  protected async query(session: SessionState, input: Record<string, unknown>): Promise<unknown> {
    const kind = asString(input.kind);
    if (kind === 'snapshot') return this.inspect(session, input);
    if (kind === 'semantic') return this.searchSemantic(session, input);
    if (kind === 'editable') {
      const requestedSnapshotId = asString(input.snapshotId);
      if (requestedSnapshotId) {
        const snapshot = getBrowserSnapshot(session, requestedSnapshotId);
        if (!snapshot) {
          throw new Error('STALE_SNAPSHOT: editable query continuation is no longer available');
        }
        if ((snapshot.continuationKind ?? 'inspect') !== 'query-editable') {
          throw new Error(
            'SNAPSHOT_KIND_MISMATCH: continue the snapshot with the action returned by its continuation',
          );
        }
        const current = snapshot.editableQuery;
        if (!current) {
          throw new Error('STALE_SNAPSHOT: editable query continuation is no longer available');
        }
        const offset = Math.max(0, Math.floor(asNumber(input.offset, 0)));
        if (current.nextOffset === null || offset !== current.nextOffset) {
          throw new Error(
            'SNAPSHOT_CONTINUATION_MISMATCH: continue from the exact nextOffset returned by the previous page',
          );
        }
        return editablePage(snapshot, current, offset, input);
      }
      if (asNumber(input.offset, 0) > 0) {
        throw new Error('editable query offset requires snapshotId from a previous query');
      }
      await this.inspect(session, { limit: 1 }, 'query-editable');
      const snapshot = session.snapshot;
      if (!snapshot) throw new Error('EDITABLE_QUERY_FAILED: no current Browser snapshot');
      const elements = snapshot.elements.filter(isEditableElement);
      snapshot.editableQuery = {
        elements,
        nextOffset: 0,
      };
      return editablePage(snapshot, snapshot.editableQuery, 0, input);
    }
    if (kind === 'text') {
      const selector = asString(input.selector, 'body');
      const maxChars = Math.max(1, Math.floor(asNumber(input.maxChars, 20_000)));
      try {
        const result = await evaluate<{
          found: boolean;
          text: string;
          totalLength: number;
          url: string;
          title: string;
        }>(
          session,
          `(() => {
          const element = document.querySelector(${JSON.stringify(selector)});
          if (!element) return { found: false, text: '', totalLength: 0, url: location.href, title: document.title };
          const text = String(element.innerText || element.textContent || '');
          return { found: true, text: text.slice(0, ${maxChars}), totalLength: text.length, url: location.href, title: document.title };
        })()`,
        );
        if (!result.found) return selectorNotFound(selector);
        const { found: _found, ...content } = result;
        return {
          success: true,
          ...content,
          truncated: result.totalLength > result.text.length,
        };
      } catch (error) {
        if (isBrowserOperationInterruption(error)) throw error;
        return browserQueryFailure(error);
      }
    }
    if (kind === 'dom') {
      const selector = asString(input.selector, 'body');
      const maxChars = Math.max(1, Math.min(50_000, Math.floor(asNumber(input.maxChars, 20_000))));
      try {
        const result = await evaluate<{ found: boolean; html: string }>(
          session,
          sanitizedDomQueryExpression(selector),
        );
        if (!result.found) return selectorNotFound(selector);
        return {
          success: true,
          html: result.html.slice(0, maxChars),
          truncated: result.html.length > maxChars,
          totalLength: result.html.length,
          url: await evaluate<string>(session, 'location.href'),
          title: await evaluate<string>(session, 'document.title'),
        };
      } catch (error) {
        if (isBrowserOperationInterruption(error)) throw error;
        return browserQueryFailure(error);
      }
    }
    if (kind === 'console') {
      const diagnosticsReady = await session.cdpHelper.ensureConsoleDiagnosticsReady(
        session.commandSignal,
      );
      if (!diagnosticsReady || !session.cdpHelper.isConsoleDiagnosticsAvailable()) {
        return {
          success: false,
          code: 'CONSOLE_DIAGNOSTICS_UNAVAILABLE',
          error: 'Console diagnostics are unavailable for the current Browser tab.',
          recovery: 'Keep the current Browser tab open and retry once it finishes initializing.',
        };
      }
      const diagnostics = session.cdpHelper.getConsoleDiagnostics({
        ...(input.levels !== undefined
          ? {
              levels: stringArray(input.levels) as CDPConsoleDiagnosticLevelFilter[],
            }
          : {}),
        ...(input.filter !== undefined ? { filter: asString(input.filter) } : {}),
        limit: Math.max(1, Math.min(200, Math.floor(asNumber(input.limit, 100)))),
      });
      const page = await evaluate<{ url: string; title: string }>(
        session,
        '({ url: location.href, title: document.title })',
      );
      return {
        success: true,
        kind: 'console',
        url: sanitizeConsoleDiagnosticUrl(asString(page.url)),
        title: asString(page.title),
        ...diagnostics,
      };
    }
    if (kind === 'network') {
      const diagnosticsReady = await session.cdpHelper.ensureNetworkDiagnosticsReady(
        session.commandSignal,
      );
      if (!diagnosticsReady || !session.cdpHelper.isNetworkDiagnosticsAvailable()) {
        return {
          success: false,
          code: 'NETWORK_DIAGNOSTICS_UNAVAILABLE',
          error: 'Network diagnostics are unavailable for the current Browser tab.',
          recovery: 'Keep the current Browser tab open and retry once it finishes initializing.',
        };
      }
      const diagnostics = session.cdpHelper.getNetworkDiagnostics({
        ...(input.status !== undefined
          ? { status: stringArray(input.status) as CDPNetworkDiagnosticStatusFilter[] }
          : {}),
        ...(input.resourceTypes !== undefined
          ? {
              resourceTypes: stringArray(input.resourceTypes) as CDPNetworkDiagnosticResourceType[],
            }
          : {}),
        ...(input.filter !== undefined ? { filter: asString(input.filter) } : {}),
        ...(input.afterSequence !== undefined
          ? { afterSequence: Math.max(0, Math.floor(asNumber(input.afterSequence))) }
          : {}),
        limit: Math.max(1, Math.min(200, Math.floor(asNumber(input.limit, 100)))),
      });
      const page = await evaluate<{ url: string; title: string }>(
        session,
        '({ url: location.href, title: document.title })',
      );
      return {
        success: true,
        kind: 'network',
        url: sanitizeConsoleDiagnosticUrl(asString(page.url)),
        title: asString(page.title),
        ...diagnostics,
      };
    }
    throw new Error(
      'query requires kind: text, semantic, dom, editable, snapshot, console, or network',
    );
  }
}

function sanitizedDomQueryExpression(selector: string): string {
  return `(() => {
    const source = document.querySelector(${JSON.stringify(selector)});
    if (!source || source.closest('[data-mavis-agent-cursor-host]')) return { found: false, html: '' };
    const blocked = 'script, noscript, style, link, template, iframe, object, embed, svg defs, svg symbol';
    if (source.matches('[data-mavis-agent-cursor-host], ' + blocked)) return { found: true, html: '' };
    const clone = source.cloneNode(true);
    clone.querySelectorAll('[data-mavis-agent-cursor-host]').forEach((element) => element.remove());
    clone.querySelectorAll(blocked).forEach((element) => element.remove());

    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((comment) => comment.remove());

    clone.querySelectorAll('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [style*="visibility:hidden"]').forEach((element) => element.remove());

    const keepAttrs = new Set([
      'href', 'src', 'alt', 'title', 'type', 'name', 'id', 'class', 'for',
      'placeholder', 'value', 'checked', 'disabled', 'readonly', 'required',
      'min', 'max', 'pattern', 'maxlength', 'minlength', 'role',
      'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-expanded',
      'aria-selected', 'aria-checked', 'aria-disabled', 'aria-haspopup',
      'aria-controls', 'aria-hidden', 'data-testid', 'data-id', 'data-value',
      'data-name', 'colspan', 'rowspan', 'scope', 'target', 'rel', 'download',
      'action', 'method', 'enctype', 'tabindex', 'contenteditable', 'lang', 'dir'
    ]);
    clone.querySelectorAll('*').forEach((element) => {
      Array.from(element.attributes).forEach((attribute) => {
        const name = attribute.name;
        if (!keepAttrs.has(name) && !name.startsWith('aria-') && !name.startsWith('data-')) {
          element.removeAttribute(name);
        }
      });
    });
    return { found: true, html: clone.outerHTML || '' };
  })()`;
}

function selectorNotFound(selector: string): Record<string, unknown> {
  return {
    success: false,
    code: 'QUERY_FAILED',
    error: `Element not found: ${selector}`,
    recovery: 'Inspect the current page and retry with a selector that matches the current DOM.',
  };
}

function browserQueryFailure(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const invalidSelector =
    /(?:failed to execute ['"]?queryselector|not a valid selector|invalid selector|selector[^\n]*syntaxerror|syntaxerror[^\n]*selector)/iu.test(
      message,
    );
  return {
    success: false,
    code: invalidSelector ? 'INVALID_SELECTOR' : 'QUERY_FAILED',
    error: message,
    recovery: invalidSelector
      ? 'Use query with kind: "text" for text matching, or continue inspect and act through a returned opaque ref. CSS selectors must use standard CSS syntax.'
      : 'Inspect the current page state and retry the query once; if navigation occurred, continue from the new snapshot.',
  };
}

function editablePage(
  snapshot: Snapshot,
  query: NonNullable<Snapshot['editableQuery']>,
  offset: number,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const limit = Math.max(1, Math.min(200, Math.floor(asNumber(input.limit, 100))));
  const pageElements = query.elements.slice(offset, offset + limit);
  const exposed: Record<string, unknown>[] = pageElements.map((element) =>
    exposeElement(
      element,
      snapshot.page.viewport,
      snapshot.frameRefs?.get(element.frameId ?? 'main'),
    ),
  );
  let returned = exposed;
  while (returned.length > 1 && byteLength({ targets: returned }) > 56 * 1024) {
    returned = returned.slice(0, -1);
  }
  const end = offset + returned.length;
  const truncated = end < query.elements.length;
  query.nextOffset = truncated ? end : null;
  return {
    success: true,
    url: snapshot.page.url,
    title: snapshot.page.title,
    viewport: snapshot.page.viewport,
    snapshotId: snapshot.id,
    offset,
    totalTargets: query.elements.length,
    returnedTargets: returned.length,
    targets: returned,
    truncated,
    ...(truncated ? { nextOffset: end } : {}),
    ...(truncated
      ? {
          continuation: {
            action: 'query',
            input: { kind: 'editable', snapshotId: snapshot.id, offset: end },
          },
        }
      : {}),
  };
}

function isEditableElement(
  element: Pick<ElementRecord, 'tag' | 'role' | 'type' | 'attributes'>,
): boolean {
  const tag = asString(element.tag).toLowerCase();
  const role = asString(element.role).toLowerCase();
  const attributes = isRecord(element.attributes) ? element.attributes : {};
  const type = asString(attributes.type, asString(element.type)).toLowerCase();
  if (tag === 'input' && NON_EDITABLE_INPUT_TYPES.has(type)) return false;
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    role === 'textbox' ||
    role === 'searchbox' ||
    asString(attributes.contenteditable).toLowerCase() === 'true' ||
    asString(attributes.role).toLowerCase() === 'textbox' ||
    asString(attributes.role).toLowerCase() === 'searchbox'
  );
}
