import { asString, isRecord } from './browser-state.js';
import type { BrowserTransport, BrowserTransportEvent } from './browser-transport.js';

export type BrowserNavigationScope = 'main' | 'child' | 'unknown';

/** Classify root-page and iframe lifecycle events consistently for every provider. */
export function classifyBrowserNavigationEvent(
  event: Pick<BrowserTransportEvent, 'method' | 'params' | 'sessionId'> | undefined,
  transport: BrowserTransport,
  mainFrameId?: string | null,
): BrowserNavigationScope {
  if (
    !event ||
    (event.method !== 'Page.frameNavigated' && event.method !== 'Page.navigatedWithinDocument')
  ) {
    return 'unknown';
  }
  const params = isRecord(event.params) ? event.params : {};
  const frame = isRecord(params.frame) ? params.frame : {};
  const frameId = asString(frame.id) || asString(params.frameId);
  const eventSessionId = event.sessionId;
  if (
    eventSessionId &&
    (transport.listAttachedFrames?.() ?? []).some(
      (candidate) => candidate.sessionId === eventSessionId,
    )
  ) {
    return 'child';
  }
  if (asString(frame.parentId)) return 'child';
  if (mainFrameId && frameId) return frameId === mainFrameId ? 'main' : 'child';
  if (eventSessionId && eventSessionId !== transport.sessionId) return 'unknown';
  return frameId ? 'main' : 'unknown';
}

export function waitExpression(input: Record<string, unknown>): string {
  const selector = asString(input.selector);
  const text = asString(input.text);
  const url = asString(input.url);
  const kind = asString(input.kind);
  const load = input.load === true || kind === 'load';
  const selectorState = asString(input.state, selector ? 'visible' : 'attached');
  if (selector && !new Set(['attached', 'detached', 'visible', 'hidden']).has(selectorState)) {
    throw new Error(`Unsupported Browser wait selector state: ${selectorState}`);
  }
  return `(() => {
    ${
      selector
        ? `
      const element = document.querySelector(${JSON.stringify(selector)});
      const state = ${JSON.stringify(selectorState)};
      if (state === 'detached') {
        if (element) return false;
      } else {
        if (!element) return state === 'hidden';
        if (state === 'visible' || state === 'hidden') {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible = !element.hasAttribute('hidden') &&
            style.display !== 'none' && style.visibility !== 'hidden' &&
            style.opacity !== '0' && rect.width > 0 && rect.height > 0;
          if (state === 'visible' && !visible) return false;
          if (state === 'hidden' && visible) return false;
        }
      }
    `
        : ''
    }
    ${text ? `if (!String(document.body?.innerText || '').includes(${JSON.stringify(text)})) return false;` : ''}
    ${url ? `if (!location.href.includes(${JSON.stringify(url)})) return false;` : ''}
    ${load ? "if (document.readyState !== 'complete') return false;" : ''}
    return true;
  })()`;
}

export function buttonName(value: unknown): string {
  return value === 'right' || value === 'middle' ? value : 'left';
}

export function modifierBit(value: string): number {
  switch (value.toLowerCase()) {
    case 'alt':
      return 1;
    case 'control':
    case 'ctrl':
      return 2;
    case 'meta':
    case 'command':
      return 4;
    case 'shift':
      return 8;
    default:
      return 0;
  }
}
