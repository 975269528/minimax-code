import { DEFAULT_BROWSER_VIEWPORT } from './browser-constants.js';
import { modifierBit } from './browser-action-helpers.js';
import { browserKeyDescriptor } from './browser-keyboard.js';
import { BrowserQuerySupport } from './browser-query.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';
import {
  asString,
  cdp,
  clearBrowserSnapshots,
  evaluate,
  inputCoordinate,
  inputCoordinateScale,
  invalidateBrowserObservations,
  isRecord,
  resolveBrowserSnapshotElement,
  type PageSummary,
  type Rect,
  type BrowserSessionState as SessionState,
} from './browser-state.js';

export abstract class BrowserActionTargetSupport extends BrowserQuerySupport {
  protected async resolveTarget(
    session: SessionState,
    input: Record<string, unknown>,
    scrollIntoView = true,
    requireCoordinates = true,
  ): Promise<{
    x: number;
    y: number;
    contextX?: number;
    contextY?: number;
    rect?: Rect;
    backendNodeId?: number;
    virtualEditor?: boolean;
    commandSessionId?: string;
    coordinateSpace?: 'main-frame-viewport' | 'frame-local' | 'unavailable';
  }> {
    const ref = asString(input.ref);
    if (ref) {
      const allowFixtureFallback = session.snapshotAuthorityEstablished !== true;
      const retained = resolveBrowserSnapshotElement(session, ref);
      // Production refs are owned by retained snapshots so TTL/generation
      // checks cannot be bypassed by the legacy ElementMap mirror. The narrow
      // no-snapshot fallback keeps white-box provider fixtures compatible.
      const element =
        retained?.element ??
        (allowFixtureFallback ? session.elementMap.getElementByOpaqueRef(ref) : null);
      if (!element)
        throw new Error('STALE_ELEMENT_REF: element ref is not from the current inspect snapshot');
      const elementSnapshot = retained?.snapshot ?? session.snapshot;
      const requestedFrame = asString(input.frame);
      if (requestedFrame) {
        const expectedFrame = elementSnapshot?.frameRefs?.get(element.frameId ?? 'main');
        if (!expectedFrame || requestedFrame !== expectedFrame) {
          throw new Error(
            'STALE_ELEMENT_REF: element frame no longer matches the inspect snapshot',
          );
        }
      }
      if (requireCoordinates && element.coordinateSpace === 'unavailable') {
        throw new Error(
          'FRAME_COORDINATES_UNAVAILABLE: the inspected frame cannot be addressed safely by viewport coordinates',
        );
      }
      session.commandSessionId = element.commandSessionId;
      const viewport = elementSnapshot?.page.viewport ?? DEFAULT_BROWSER_VIEWPORT;
      const fullyVisible =
        element.rect.x >= 0 &&
        element.rect.y >= 0 &&
        element.rect.x + element.rect.width <= viewport.width &&
        element.rect.y + element.rect.height <= viewport.height;
      if (scrollIntoView && !fullyVisible) {
        await cdp(session, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId });
        await this.centerBackendNodeInView(session, element.backendNodeId);
      }
      const measuredRect = await this.readBox(session, element.backendNodeId).catch((error) => {
        if (isBrowserOperationInterruption(error)) throw error;
        return undefined;
      });
      if (!measuredRect && requireCoordinates) {
        throw new Error(
          element.commandSessionId
            ? 'FRAME_COORDINATES_UNAVAILABLE: the inspected frame target could not be measured safely in the current page'
            : 'STALE_ELEMENT_REF: inspected target no longer has a live box in the current page',
        );
      }
      const frameOffset = element.frameOffset ?? { x: 0, y: 0 };
      const localRect =
        measuredRect && measuredRect.width > 0 && measuredRect.height > 0
          ? measuredRect
          : {
              ...element.rect,
              x: element.rect.x - frameOffset.x,
              y: element.rect.y - frameOffset.y,
            };
      const rect = {
        ...localRect,
        x: localRect.x + frameOffset.x,
        y: localRect.y + frameOffset.y,
      };
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        contextX: localRect.x + localRect.width / 2,
        contextY: localRect.y + localRect.height / 2,
        rect,
        backendNodeId: element.backendNodeId,
        virtualEditor: element.virtualEditor,
        ...(element.coordinateSpace ? { coordinateSpace: element.coordinateSpace } : {}),
        ...(element.commandSessionId ? { commandSessionId: element.commandSessionId } : {}),
      };
    }
    const selector = asString(input.selector);
    if (selector) {
      const rect = await evaluate<Rect | null>(
        session,
        `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        let r = element.getBoundingClientRect();
        const fullyVisible = r.x >= 0 && r.y >= 0 &&
          r.x + r.width <= innerWidth && r.y + r.height <= innerHeight;
        if (${scrollIntoView ? 'true' : 'false'} && !fullyVisible) {
          element.scrollIntoView({ block: 'center', inline: 'center' });
          r = element.getBoundingClientRect();
        }
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
      );
      if (!rect) throw new Error('TARGET_NOT_FOUND: selector did not match an element');
      const backendNodeId = await this.resolveSelectorBackendNode(session, selector);
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        rect,
        ...(backendNodeId === undefined ? {} : { backendNodeId }),
      };
    }
    const viewport = await this.readCssViewport(session);
    const position = resolveViewportPosition(input, viewport);
    return {
      x: position.x,
      y: position.y,
      rect: { x: position.x, y: position.y, width: 1, height: 1 },
    };
  }

  protected async readCssViewport(
    session: SessionState,
  ): Promise<{ width: number; height: number }> {
    try {
      return await session.cdpHelper.getCssViewportSize();
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      const viewport = session.snapshot?.page.viewport;
      if (
        viewport &&
        Number.isFinite(viewport.width) &&
        Number.isFinite(viewport.height) &&
        viewport.width > 0 &&
        viewport.height > 0
      ) {
        return viewport;
      }
      throw new Error('VIEWPORT_UNAVAILABLE: current CSS viewport metrics are unavailable');
    }
  }

  private async resolveSelectorBackendNode(
    session: SessionState,
    selector: string,
  ): Promise<number | undefined> {
    const document = await cdp<{ root?: { nodeId?: number } }>(session, 'DOM.getDocument', {
      depth: 0,
      pierce: true,
    });
    const rootNodeId = document.root?.nodeId;
    if (rootNodeId === undefined) return undefined;
    const match = await cdp<{ nodeId?: number }>(session, 'DOM.querySelector', {
      nodeId: rootNodeId,
      selector,
    });
    if (match.nodeId === undefined || match.nodeId === 0) return undefined;
    const described = await cdp<{ node?: { backendNodeId?: number } }>(
      session,
      'DOM.describeNode',
      { nodeId: match.nodeId },
    );
    return described.node?.backendNodeId;
  }

  private async centerBackendNodeInView(
    session: SessionState,
    backendNodeId: number,
  ): Promise<void> {
    const resolved = await cdp<{ object?: { objectId?: string } }>(session, 'DOM.resolveNode', {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) return;
    try {
      await cdp(session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          this.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        }`,
        returnByValue: true,
        awaitPromise: true,
      });
    } finally {
      await cdp(session, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  protected async dispatchMouse(
    session: SessionState,
    x: number,
    y: number,
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const point = inputCoordinate(session, { x, y });
    const scale = inputCoordinateScale(session);
    const scaledExtra =
      type === 'mouseWheel'
        ? {
            ...extra,
            ...(typeof extra.deltaX === 'number' ? { deltaX: extra.deltaX * scale } : {}),
            ...(typeof extra.deltaY === 'number' ? { deltaY: extra.deltaY * scale } : {}),
          }
        : extra;
    await session.transport.send(
      'Input.dispatchMouseEvent',
      { type, ...point, ...scaledExtra },
      undefined,
      {
        ...(session.commandSignal ? { signal: session.commandSignal } : {}),
        ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
      },
    );
  }

  protected async dispatchKey(
    session: SessionState,
    key: string,
    modifiers: string[],
  ): Promise<void> {
    const modifierMask = modifiers.reduce((mask, modifier) => mask | modifierBit(modifier), 0);
    const descriptor = browserKeyDescriptor(key);
    await cdp(session, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: descriptor.key,
      code: descriptor.code,
      modifiers: modifierMask,
      ...(descriptor.windowsVirtualKeyCode === undefined
        ? {}
        : { windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode }),
      ...(descriptor.text === undefined || modifierMask !== 0
        ? {}
        : { text: descriptor.text, unmodifiedText: descriptor.text }),
    });
    await cdp(session, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: descriptor.key,
      code: descriptor.code,
      modifiers: modifierMask,
      ...(descriptor.windowsVirtualKeyCode === undefined
        ? {}
        : { windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode }),
    });
  }

  protected async readBox(session: SessionState, backendNodeId: number): Promise<Rect> {
    const result = await cdp<{
      model?: { border?: number[]; content?: number[]; width?: number; height?: number };
    }>(session, 'DOM.getBoxModel', { backendNodeId });
    const quad = result.model?.border ?? result.model?.content;
    if (!quad || quad.length < 8) throw new Error('Element box unavailable');
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    if ([...xs, ...ys].some((value) => typeof value !== 'number')) {
      throw new Error('Element box has invalid coordinates');
    }
    const numericXs = xs as number[];
    const numericYs = ys as number[];
    const x = Math.min(...numericXs);
    const y = Math.min(...numericYs);
    return {
      x,
      y,
      width: Math.max(...numericXs) - x,
      height: Math.max(...numericYs) - y,
    };
  }

  protected async readPageSummary(session: SessionState): Promise<PageSummary> {
    return session.transport.evaluate<PageSummary>(
      `(() => {
      const root = document.scrollingElement || document.documentElement;
      return {
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        scrollPosition: { x: root?.scrollLeft || 0, y: root?.scrollTop || 0 },
        pageHeight: Math.max(root?.scrollHeight || 0, document.body?.scrollHeight || 0),
        pageWidth: Math.max(root?.scrollWidth || 0, document.body?.scrollWidth || 0),
      };
    })()`,
      {
        ...(session.commandSignal ? { signal: session.commandSignal } : {}),
        ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
      },
    );
  }

  protected async readFocusedText(session: SessionState, virtualEditor = false): Promise<string> {
    return evaluate<string>(
      session,
      `(() => {
      const element = document.activeElement;
      if (!element) return '';
      if (${virtualEditor ? 'true' : 'false'}) {
        const editor = element.closest('.dcg-mq-editable-field');
        if (editor) return String(editor.textContent || editor.innerText || '').trim();
      }
      if ('value' in element) return String(element.value || '');
      return String(element.textContent || '').trim();
    })()`,
    );
  }

  protected invalidate(session: SessionState): void {
    session.generation += 1;
    session.frameEpochs?.clear();
    session.elementMap.clearOpaqueRefs();
    clearBrowserSnapshots(session);
    session.keyboardContinuationTarget = undefined;
  }

  protected invalidateObservation(session: SessionState): void {
    invalidateBrowserObservations(session);
  }
}

export function resolveViewportPosition(
  input: Record<string, unknown>,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const absolute = readPoint(input.position);
  const normalized = readPoint(input.normalized_position);
  if (!absolute && !normalized) {
    throw new Error('Browser target requires ref, selector, position, or normalized_position');
  }
  let position: { x: number; y: number };
  if (absolute) {
    position = absolute;
  } else {
    if (!normalized) throw new Error('Browser target requires valid coordinates');
    position = {
      x: Math.round(normalized.x * viewport.width),
      y: Math.round(normalized.y * viewport.height),
    };
  }
  if (
    position.x < 0 ||
    position.y < 0 ||
    position.x >= viewport.width ||
    position.y >= viewport.height
  ) {
    throw new Error('POSITION_OUT_OF_VIEWPORT: position must be inside the current viewport');
  }
  return position;
}

function readPoint(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value)) return undefined;
  const x = typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : undefined;
  const y = typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : undefined;
  return x === undefined || y === undefined ? undefined : { x, y };
}
