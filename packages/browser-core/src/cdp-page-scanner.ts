import type { InteractiveElement } from './browser-core-contracts.js';
import { buildSemanticPageTree, type SemanticPageTree } from './browser-semantic-tree.js';
import type { BrowserTransport } from './browser-transport.js';
import {
  BROWSER_TIMEOUTS,
  isBrowserOperationInterruption,
  throwIfAborted,
  withTimeout,
} from './operation-timeout.js';
import {
  CONTAINER_TAGS,
  INTERACTIVE_ROLES,
  INTERACTIVE_TAGS,
  REQUIRED_COMPUTED_STYLES,
  SKIP_TAGS,
  SVG_ELEMENTS,
  type AXNode,
  type DOMNode,
  type DOMSnapshotResult,
  type SnapshotNode,
} from './cdp-helper-contracts.js';

export const DEFAULT_VIEWPORT = { width: 800, height: 600 };

type ScannerCommand = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<unknown>;

type JavaScriptFallbackElement = Omit<InteractiveElement, 'backendNodeId'> & {
  readonly backendNodeId?: number;
};

const browserInputDiagnosticLogger = {
  info(fields: Record<string, unknown>): void {
    if (process.env.MAVIS_BROWSER_DEBUG === '1') console.info(fields);
  },
};

function rethrowBrowserInterruption(error: unknown): void {
  if (isBrowserOperationInterruption(error)) throw error;
}

/**
 * Mature DOMSnapshot + DOM + AX + Runtime-listener page understanding.
 *
 * CDPHelper owns transport lifecycle and input primitives. This collaborator
 * owns only the page scan and semantic fusion algorithm so every provider uses
 * the same implementation without growing CDPHelper beyond the source-size gate.
 */
export class CDPPageScanner {
  private lastSemanticPageTree: SemanticPageTree | null = null;

  constructor(
    private readonly transport: BrowserTransport,
    private readonly ensurePageAttached: (signal?: AbortSignal) => Promise<boolean>,
    private readonly command: ScannerCommand,
  ) {}

  reset(): void {
    this.lastSemanticPageTree = null;
  }

  getLastSemanticPageTree(): SemanticPageTree | null {
    return this.lastSemanticPageTree;
  }

  private buildSemanticPageTreeSafely(
    input: Parameters<typeof buildSemanticPageTree>[0],
  ): SemanticPageTree | null {
    if (process.env.MAVIS_BROWSER_SEMANTIC_TREE_V1 === '0') return null;
    try {
      return buildSemanticPageTree(input);
    } catch (error) {
      console.warn('Failed to build browser semantic tree; keeping legacy ElementMap:', error);
      return null;
    }
  }

  private ensureAttached(signal?: AbortSignal): Promise<boolean> {
    return this.ensurePageAttached(signal);
  }

  private sendCommand(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = BROWSER_TIMEOUTS.cdpCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.command(method, params, timeoutMs, signal);
  }

  private async resolveJavaScriptFallbackElements(
    elements: readonly JavaScriptFallbackElement[],
    signal: AbortSignal,
  ): Promise<InteractiveElement[]> {
    if (elements.length === 0) return [];
    const document = (await this.sendCommand(
      'DOM.getDocument',
      { depth: 0, pierce: true },
      BROWSER_TIMEOUTS.cdpCommand,
      signal,
    )) as { root?: { nodeId?: number } };
    const rootNodeId = document.root?.nodeId;
    if (!rootNodeId) return [];

    const resolved: InteractiveElement[] = [];
    for (const element of elements) {
      if (Number.isFinite(element.backendNodeId) && Number(element.backendNodeId) > 0) {
        resolved.push(element as InteractiveElement);
        continue;
      }
      if (!element.selector) continue;
      try {
        const match = (await this.sendCommand(
          'DOM.querySelectorAll',
          { nodeId: rootNodeId, selector: element.selector },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        )) as { nodeIds?: number[] };
        if (match.nodeIds?.length !== 1) continue;
        const [nodeId] = match.nodeIds;
        if (!nodeId) continue;
        const description = (await this.sendCommand(
          'DOM.describeNode',
          { nodeId },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        )) as { node?: { backendNodeId?: number } };
        const backendNodeId = description.node?.backendNodeId;
        if (!backendNodeId) continue;
        resolved.push({ ...element, backendNodeId });
      } catch (error) {
        rethrowBrowserInterruption(error);
      }
    }
    return resolved;
  }

  async scan(signal: AbortSignal): Promise<InteractiveElement[]> {
    throwIfAborted(signal);
    const startedAt = Date.now();
    const logPhase = (phase: string, extra: Record<string, unknown> = {}) => {
      browserInputDiagnosticLogger.info({
        msg: '[EmbeddedBrowserOperation] cdp-scan-phase',
        phase,
        browserSessionId: this.transport.sessionId,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    };

    // Try to connect CDP; return silently on failure.
    logPhase('start');
    const attached = await this.ensureAttached(signal).catch((error) => {
      rethrowBrowserInterruption(error);
      return false;
    });
    if (!attached) return [];
    logPhase('attached');

    try {
      // Enable required CDP domains.
      await Promise.all([
        this.sendCommand('DOM.enable', undefined, BROWSER_TIMEOUTS.cdpCommand, signal).catch(
          (error) => {
            rethrowBrowserInterruption(error);
          },
        ),
        this.sendCommand(
          'DOMSnapshot.enable',
          undefined,
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        ).catch((error) => {
          rethrowBrowserInterruption(error);
        }),
        this.sendCommand(
          'Accessibility.enable',
          undefined,
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        ).catch((error) => {
          rethrowBrowserInterruption(error);
        }),
        this.sendCommand('Page.enable', undefined, BROWSER_TIMEOUTS.cdpCommand, signal).catch(
          (error) => {
            rethrowBrowserInterruption(error);
          },
        ),
      ]);
      throwIfAborted(signal);
      logPhase('domains-enabled');

      // 1. Fetch the three data sources and detect JS event listeners in parallel.
      const [
        snapshotResult,
        domTreeResult,
        axTreeResult,
        jsListenerBackendIds,
        viewportInfo,
        snapshotToCssScale,
      ] = await Promise.all([
        // DOMSnapshot.captureSnapshot: Fetch layout information and computed styles.
        this.captureSnapshot(signal).catch((e) => {
          rethrowBrowserInterruption(e);
          console.warn('Failed to capture snapshot:', e);
          return null;
        }),

        // DOM.getDocument: Fetch the full DOM tree.
        this.sendCommand(
          'DOM.getDocument',
          { depth: -1, pierce: true },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        ).catch((e) => {
          rethrowBrowserInterruption(e);
          console.warn('Failed to get DOM document:', e);
          return null;
        }) as Promise<{ root: DOMNode } | null>,

        // Accessibility.getFullAXTree: Fetch the accessibility tree.
        this.sendCommand(
          'Accessibility.getFullAXTree',
          undefined,
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        ).catch((e) => {
          rethrowBrowserInterruption(e);
          console.warn('Failed to get AX tree:', e);
          return null;
        }) as Promise<{ nodes: AXNode[] } | null>,

        // Detect JS event listeners.
        this.detectJSEventListeners(signal).catch((error) => {
          rethrowBrowserInterruption(error);
          return new Set<number>();
        }),

        // Get viewport information, including scroll offsets.
        withTimeout(
          (commandSignal) =>
            this.transport.evaluate<{
              width: number;
              height: number;
              scrollX: number;
              scrollY: number;
              pageHeight: number;
              pageWidth: number;
            }>(
              `({
              width: window.innerWidth,
              height: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              pageHeight: Math.max(
                document.body.scrollHeight,
                document.documentElement.scrollHeight,
                document.body.offsetHeight,
                document.documentElement.offsetHeight
              ),
              pageWidth: Math.max(
                document.body.scrollWidth,
                document.documentElement.scrollWidth,
                document.body.offsetWidth,
                document.documentElement.offsetWidth
              )
            })`,
              {
                signal: commandSignal,
                timeoutMs: BROWSER_TIMEOUTS.cdpCommand,
              },
            ),
          BROWSER_TIMEOUTS.cdpCommand,
          'Browser viewport inspection',
          { signal },
        ).catch((error) => {
          rethrowBrowserInterruption(error);
          return {
            width: DEFAULT_VIEWPORT.width,
            height: DEFAULT_VIEWPORT.height,
            scrollX: 0,
            scrollY: 0,
            pageHeight: DEFAULT_VIEWPORT.height,
            pageWidth: DEFAULT_VIEWPORT.width,
          };
        }),

        // Electron/Chromium DOMSnapshot layout uses legacy viewport units; convert to CSS viewport units.
        this.getSnapshotToCssScale(signal).catch((error) => {
          rethrowBrowserInterruption(error);
          return 1;
        }),
      ]);
      throwIfAborted(signal);
      logPhase('sources-settled', {
        hasSnapshot: snapshotResult !== null,
        hasDomTree: domTreeResult !== null,
        axNodeCount: axTreeResult?.nodes?.length ?? 0,
        jsListenerCount: jsListenerBackendIds.size,
      });

      // 2. DOMSnapshot bounds use each Document's coordinates; normalize legacy units, scroll offsets, and viewport.
      const mainFrameId = domTreeResult?.root?.frameId ?? 'main';
      const snapshotLookup = this.buildSnapshotLookup(
        snapshotResult,
        mainFrameId,
        snapshotToCssScale,
      );

      // 3. Build the AX tree lookup (backendDOMNodeId → AX node).
      const axTreeLookup = new Map<number, AXNode>();
      if (axTreeResult?.nodes) {
        for (const node of axTreeResult.nodes) {
          if (node.backendDOMNodeId) {
            axTreeLookup.set(node.backendDOMNodeId, node);
          }
        }
      }

      // 4. Traverse the DOM tree and collect interactive elements.
      const elements: InteractiveElement[] = [];
      const processedBackendIds = new Set<number>();

      if (domTreeResult?.root) {
        await this.traverseDOMTree(
          domTreeResult.root,
          elements,
          processedBackendIds,
          snapshotLookup,
          axTreeLookup,
          jsListenerBackendIds,
          viewportInfo,
          mainFrameId,
          [],
          signal,
        );
      }

      // 5. If DOM traversal found no elements, supplement it with a JavaScript scan.
      if (elements.length === 0) {
        const jsElements = await this.scanInteractiveElementsViaJS(viewportInfo, signal);
        elements.push(...jsElements);
      }

      // 6. Sort by position, top to bottom and left to right.
      elements.sort((a, b) => {
        const yDiff = a.boundingBox.y - b.boundingBox.y;
        if (Math.abs(yDiff) > 10) return yDiff;
        return a.boundingBox.x - b.boundingBox.x;
      });

      // 7. Reassign indices.
      elements.forEach((el, idx) => {
        el.index = idx;
      });

      this.lastSemanticPageTree = this.buildSemanticPageTreeSafely({
        mainFrameId,
        domRoot: domTreeResult?.root,
        axNodes: axTreeResult?.nodes ?? [],
        snapshotLookup,
        interactiveElements: elements,
      });
      logPhase('complete', { interactiveElementCount: elements.length });

      return elements;
    } catch (error) {
      rethrowBrowserInterruption(error);
      logPhase('primary-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn('Failed to get interactive elements:', error);
      // Fall back to a pure JS scan.
      try {
        const viewportInfo = await withTimeout(
          (commandSignal) =>
            this.transport.evaluate<{
              width: number;
              height: number;
              scrollX: number;
              scrollY: number;
            }>(
              `({
              width: window.innerWidth,
              height: window.innerHeight,
              scrollX: window.scrollX,
              scrollY: window.scrollY
            })`,
              {
                signal: commandSignal,
                timeoutMs: BROWSER_TIMEOUTS.cdpCommand,
              },
            ),
          BROWSER_TIMEOUTS.cdpCommand,
          'Browser viewport fallback inspection',
          { signal },
        ).catch((fallbackError) => {
          rethrowBrowserInterruption(fallbackError);
          return {
            width: DEFAULT_VIEWPORT.width,
            height: DEFAULT_VIEWPORT.height,
            scrollX: 0,
            scrollY: 0,
          };
        });
        throwIfAborted(signal);
        const elements = await this.scanInteractiveElementsViaJS(viewportInfo, signal);
        this.lastSemanticPageTree = this.buildSemanticPageTreeSafely({
          mainFrameId: 'main',
          interactiveElements: elements,
        });
        logPhase('fallback-complete', { interactiveElementCount: elements.length });
        return elements;
      } catch (fallbackError) {
        rethrowBrowserInterruption(fallbackError);
        logPhase('fallback-failed');
        return [];
      }
    }
  }

  /**
   * Capture a page snapshot using DOMSnapshot.captureSnapshot.
   */
  private async captureSnapshot(signal?: AbortSignal): Promise<DOMSnapshotResult | null> {
    const result = (await this.sendCommand(
      'DOMSnapshot.captureSnapshot',
      {
        computedStyles: REQUIRED_COMPUTED_STYLES,
        includePaintOrder: true,
        includeDOMRects: true,
        includeBlendedBackgroundColors: false,
        includeTextColorOpacities: false,
      },
      BROWSER_TIMEOUTS.cdpCommand,
      signal,
    )) as DOMSnapshotResult;

    return result;
  }

  /**
   * DOMSnapshot layout and Page.getLayoutMetrics' deprecated viewport share legacy units. Compare
   * legacy/CSS viewports to derive the conversion ratio; this is not the system devicePixelRatio.
   */
  private async getSnapshotToCssScale(signal?: AbortSignal): Promise<number> {
    try {
      const metrics = (await this.sendCommand(
        'Page.getLayoutMetrics',
        undefined,
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      )) as {
        visualViewport?: { clientWidth?: number };
        cssVisualViewport?: { clientWidth?: number };
      };
      const legacyWidth = Number(metrics.visualViewport?.clientWidth);
      const cssWidth = Number(metrics.cssVisualViewport?.clientWidth);
      if (legacyWidth > 0 && cssWidth > 0) {
        const scale = legacyWidth / cssWidth;
        if (Number.isFinite(scale) && scale > 0) return scale;
      }
    } catch (error) {
      rethrowBrowserInterruption(error);
      // captureSnapshot itself can still be used with the protocol default scale.
    }
    return 1;
  }

  /**
   * Build the snapshot lookup (backendNodeId → layout information).
   * @param snapshot DOMSnapshot result.
   * @param mainFrameId Main frame CDP id.
   */
  buildSnapshotLookup(
    snapshot: DOMSnapshotResult | null,
    mainFrameId: string,
    snapshotToCssScale = 1,
  ): Map<number, SnapshotNode> {
    const lookup = new Map<number, SnapshotNode>();
    if (!snapshot?.documents) return lookup;

    const strings = snapshot.strings || [];
    const scale =
      Number.isFinite(snapshotToCssScale) && snapshotToCssScale > 0 ? snapshotToCssScale : 1;

    for (let documentIndex = 0; documentIndex < snapshot.documents.length; documentIndex += 1) {
      const document = snapshot.documents[documentIndex];
      if (!document) continue;
      const nodes = document.nodes;
      const layout = document.layout;
      const documentFrameId =
        document.frameId !== undefined ? strings[document.frameId] : undefined;
      const isMainDocument =
        documentIndex === 0 || (documentFrameId !== undefined && documentFrameId === mainFrameId);
      const scrollOffsetX = Number.isFinite(document.scrollOffsetX)
        ? Number(document.scrollOffsetX)
        : 0;
      const scrollOffsetY = Number.isFinite(document.scrollOffsetY)
        ? Number(document.scrollOffsetY)
        : 0;
      const coordinateSpace = isMainDocument ? 'main-frame-viewport' : 'frame-local';

      if (!nodes?.backendNodeId) continue;

      // Build the nodeIndex → layoutIndex mapping.
      const layoutIndexMap = new Map<number, number>();
      if (layout?.nodeIndex) {
        for (let i = 0; i < layout.nodeIndex.length; i++) {
          const nodeIndex = layout.nodeIndex[i];
          if (nodeIndex !== undefined && !layoutIndexMap.has(nodeIndex)) {
            layoutIndexMap.set(nodeIndex, i);
          }
        }
      }

      // Traverse all nodes.
      for (let i = 0; i < nodes.backendNodeId.length; i++) {
        const backendNodeId = nodes.backendNodeId[i];

        // Check whether the node is clickable.
        let isClickable = false;
        if (nodes.isClickable?.index) {
          isClickable = nodes.isClickable.index.includes(i);
        }

        // Get layout information.
        let bounds: { x: number; y: number; width: number; height: number } | null = null;
        const computedStyles: Record<string, string> = {};
        let paintOrder: number | null = null;

        const layoutIdx = layoutIndexMap.get(i);
        if (layoutIdx !== undefined && layout) {
          // For the main document, subtract scroll offsets in the same units, then convert to main-frame viewport CSS
          // coordinates using the legacy/CSS ratio. Child documents remain frame-local until DOM.getContentQuads converts them.
          if (layout.bounds && layoutIdx < layout.bounds.length) {
            const b = layout.bounds[layoutIdx];
            if (b && b.length >= 4) {
              bounds = {
                x: (b[0]! - scrollOffsetX) / scale,
                y: (b[1]! - scrollOffsetY) / scale,
                width: b[2]! / scale,
                height: b[3]! / scale,
              };
            }
          }

          // Parse computed styles.
          if (layout.styles && layoutIdx < layout.styles.length) {
            const styleIndices = layout.styles[layoutIdx];
            if (styleIndices) {
              for (let j = 0; j < styleIndices.length && j < REQUIRED_COMPUTED_STYLES.length; j++) {
                const styleIndex = styleIndices[j];
                const styleName = REQUIRED_COMPUTED_STYLES[j];
                if (
                  styleName !== undefined &&
                  styleIndex !== undefined &&
                  styleIndex >= 0 &&
                  styleIndex < strings.length
                ) {
                  computedStyles[styleName] = strings[styleIndex] ?? '';
                }
              }
            }
          }

          // Parse paint order.
          if (layout.paintOrders && layoutIdx < layout.paintOrders.length) {
            paintOrder = layout.paintOrders[layoutIdx] ?? null;
          }
        }

        if (backendNodeId === undefined) continue;
        lookup.set(backendNodeId, {
          bounds,
          coordinateSpace,
          computedStyles,
          isClickable,
          paintOrder,
          frameId: documentFrameId || mainFrameId,
        });
      }
    }

    return lookup;
  }

  /**
   * DOM.getContentQuads returns viewport-relative CSS quads, reliably mapping child-frame elements
   * to the main-frame viewport. Union multiple fragments into one bounding box; callers fail closed
   * on protocol errors.
   */
  async getViewportBoundsByBackendNodeId(
    backendNodeId: number,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const result = (await this.sendCommand(
        'DOM.getContentQuads',
        { backendNodeId },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      )) as { quads?: number[][] };
      const coordinates = (result.quads ?? [])
        .filter((quad) => Array.isArray(quad) && quad.length >= 8)
        .flatMap((quad) => quad.slice(0, 8));
      if (coordinates.length < 8 || coordinates.some((value) => !Number.isFinite(value))) {
        return null;
      }
      const xs = coordinates.filter((_, index) => index % 2 === 0);
      const ys = coordinates.filter((_, index) => index % 2 === 1);
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      if (right <= left || bottom <= top) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    } catch (error) {
      rethrowBrowserInterruption(error);
      return null;
    }
  }

  /**
   * Detect JavaScript event listeners using CDP's getEventListeners API (requires
   * includeCommandLineAPI).
   */
  private async detectJSEventListeners(signal?: AbortSignal): Promise<Set<number>> {
    const backendIds = new Set<number>();

    try {
      // Use Runtime.evaluate with includeCommandLineAPI to access getEventListeners.
      const result = (await this.sendCommand(
        'Runtime.evaluate',
        {
          expression: `
          (function() {
            if (typeof getEventListeners !== 'function') {
              return null;
            }

            const elementsWithListeners = new Set();
            const allElements = document.querySelectorAll('*');
            const explicitCandidateSelector = [
              'button', 'a[href]', 'input', 'textarea', 'select',
              '[role]', '[tabindex]', '[contenteditable="true"]',
              '[data-action]', '[data-command]', '[data-testid]'
            ].join(',');
            const delegatedEventTypes = [
              'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart'
            ];
            const genericLeafTags = new Set(['DIV', 'SPAN', 'LI', 'P']);
            const globalDelegationRoots = new Set([
              document.documentElement,
              document.body
            ]);

            const isVisibleCandidate = (candidate) => {
              const style = getComputedStyle(candidate);
              if (style.display === 'none' || style.visibility === 'hidden' ||
                  Number.parseFloat(style.opacity || '1') <= 0 ||
                  style.pointerEvents === 'none') return false;
              const rect = candidate.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };

            const hasFrameworkActionSignal = (candidate) => {
              for (const attribute of candidate.attributes) {
                const name = attribute.name.toLowerCase();
                if (/^(?:onclick|onmousedown|onmouseup|ng-click|data-(?:action|command|click|event|handler))$/.test(name) ||
                    /^(?:@|v-on:|x-on:)click$/.test(name) ||
                    name.startsWith('hx-')) return true;
              }
              return false;
            };

            const isScopedDelegatedLeaf = (candidate, listenerRoot) => {
              if (globalDelegationRoots.has(listenerRoot) || !isVisibleCandidate(candidate)) {
                return false;
              }
              const style = getComputedStyle(candidate);
              if (style.cursor === 'pointer' || hasFrameworkActionSignal(candidate)) return true;
              if (!genericLeafTags.has(candidate.tagName) && !candidate.tagName.includes('-')) {
                return false;
              }
              const semanticText = (
                candidate.getAttribute('aria-label') ||
                candidate.getAttribute('title') ||
                candidate.textContent || ''
              ).trim();
              if (!semanticText) return false;
              return !Array.from(candidate.children).some((child) =>
                isVisibleCandidate(child) && (child.textContent || '').trim().length > 0
              );
            };

            const addCandidate = (candidate) => {
              if (elementsWithListeners.size < 500) elementsWithListeners.add(candidate);
            };

            for (const el of allElements) {
              try {
                const listeners = getEventListeners(el);
                if (delegatedEventTypes.some((type) => listeners[type]?.length)) {
                  const delegatedCandidates = new Set();
                  for (const candidate of el.querySelectorAll(explicitCandidateSelector)) {
                    if (isVisibleCandidate(candidate)) delegatedCandidates.add(candidate);
                  }
                  // A scoped delegation root often targets a plain div/span/li with
                  // no ARIA or framework-specific attribute. Promote visible,
                  // text-bearing leaves generically; never apply this broad signal to
                  // html/body because global delegation would turn page prose into
                  // controls.
                  for (const candidate of el.querySelectorAll('div,span,li,p,*')) {
                    if (isScopedDelegatedLeaf(candidate, el)) delegatedCandidates.add(candidate);
                    if (delegatedCandidates.size >= 200) break;
                  }
                  // Preserve direct listeners. When a scoped listener has concrete
                  // delegated descendants, do not expose the structural ancestor as
                  // a competing control.
                  if (delegatedCandidates.size === 0 ||
                      el.matches(explicitCandidateSelector) ||
                      getComputedStyle(el).cursor === 'pointer' ||
                      hasFrameworkActionSignal(el)) {
                    addCandidate(el);
                  }
                  for (const candidate of delegatedCandidates) {
                    addCandidate(candidate);
                    if (elementsWithListeners.size >= 500) break;
                  }
                }
              } catch (e) {
                // Ignore errors for individual elements.
              }
            }

            return Array.from(elementsWithListeners);
          })()
        `,
          includeCommandLineAPI: true,
          returnByValue: false,
        },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      )) as { result?: { objectId?: string } };

      const objectId = result?.result?.objectId;
      if (!objectId) return backendIds;

      // Get array properties.
      const propsResult = (await this.sendCommand(
        'Runtime.getProperties',
        { objectId, ownProperties: true },
        BROWSER_TIMEOUTS.cdpCommand,
        signal,
      )) as { result?: Array<{ name: string; value?: { objectId?: string } }> };

      // Get each element's backendNodeId.
      const elementObjectIds: string[] = [];
      for (const prop of propsResult.result || []) {
        if (prop.name && /^\d+$/.test(prop.name) && prop.value?.objectId) {
          elementObjectIds.push(prop.value.objectId);
        }
      }

      // Fetch backendNodeIds in parallel.
      const nodePromises = elementObjectIds.map(async (objId) => {
        try {
          const nodeInfo = (await this.sendCommand(
            'DOM.describeNode',
            { objectId: objId },
            BROWSER_TIMEOUTS.cdpCommand,
            signal,
          )) as { node?: { backendNodeId?: number } };
          return nodeInfo?.node?.backendNodeId;
        } catch (error) {
          rethrowBrowserInterruption(error);
          return undefined;
        }
      });

      const nodeIds = await Promise.all(nodePromises);
      for (const id of nodeIds) {
        if (id !== undefined) {
          backendIds.add(id);
        }
      }

      // Release objects.
      try {
        await this.sendCommand(
          'Runtime.releaseObject',
          { objectId },
          BROWSER_TIMEOUTS.cdpCommand,
          signal,
        );
      } catch (error) {
        rethrowBrowserInterruption(error);
        // Ignore release errors.
      }
    } catch (error) {
      rethrowBrowserInterruption(error);
      console.warn('Failed to detect JS event listeners:', error);
    }

    return backendIds;
  }

  /**
   * Traverse the DOM tree and collect interactive elements.
   */
  private axBooleanProperty(axNode: AXNode | undefined, name: string): boolean {
    return (
      axNode?.properties?.some(
        (property) => property.name === name && property.value?.value === true,
      ) === true
    );
  }

  private axHasEnabledProperty(axNode: AXNode | undefined, name: string): boolean {
    return (
      axNode?.properties?.some(
        (property) => property.name === name && property.value?.value !== false,
      ) === true
    );
  }

  private isVirtualEditorProxy(node: DOMNode, axNode: AXNode | undefined): boolean {
    const tagName = node.nodeName?.toLowerCase() || '';
    const inputType = this.getNodeAttribute(node, 'type')?.toLowerCase() || '';
    const role = (axNode?.role?.value || this.getNodeAttribute(node, 'role') || '').toLowerCase();
    const editableNode =
      tagName === 'textarea' ||
      (tagName === 'input' && inputType !== 'hidden') ||
      this.getNodeAttribute(node, 'contenteditable') === 'true';
    return (
      editableNode &&
      (role === 'textbox' || role === 'searchbox') &&
      (this.axBooleanProperty(axNode, 'focused') ||
        (this.axBooleanProperty(axNode, 'focusable') &&
          (this.axHasEnabledProperty(axNode, 'editable') ||
            this.axBooleanProperty(axNode, 'settable'))))
    );
  }

  private findVisibleVirtualEditorHost(
    ancestors: readonly DOMNode[],
    snapshotLookup: Map<number, SnapshotNode>,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
    frameId: string,
  ): { node: DOMNode; snapshotNode: SnapshotNode } | null {
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const candidate = ancestors[index];
      if (!candidate) continue;
      const tagName = candidate.nodeName?.toLowerCase() || '';
      if (
        candidate.nodeType !== 1 ||
        CONTAINER_TAGS.has(tagName) ||
        (candidate.frameId && candidate.frameId !== frameId)
      ) {
        continue;
      }
      const snapshotNode = snapshotLookup.get(candidate.backendNodeId);
      if (
        this.isElementVisible(snapshotNode, viewportInfo) &&
        snapshotNode?.bounds &&
        snapshotNode.bounds.width >= 16 &&
        snapshotNode.bounds.height >= 16
      ) {
        return { node: candidate, snapshotNode };
      }
    }
    return null;
  }

  private createVirtualEditorElement(
    proxyNode: DOMNode,
    hostNode: DOMNode,
    hostSnapshotNode: SnapshotNode,
    axNode: AXNode,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
    index: number,
    frameId: string,
  ): InteractiveElement | null {
    const element = this.createInteractiveElement(
      proxyNode,
      hostSnapshotNode,
      axNode,
      viewportInfo,
      index,
      frameId,
    );
    if (!element) return null;
    return {
      ...element,
      backendNodeId: hostNode.backendNodeId,
      semanticBackendNodeId: proxyNode.backendNodeId,
      selector: `[data-backend-node-id="${hostNode.backendNodeId}"]`,
      inputStrategy: 'focused-keyboard',
    };
  }

  async traverseDOMTree(
    node: DOMNode,
    elements: InteractiveElement[],
    processedBackendIds: Set<number>,
    snapshotLookup: Map<number, SnapshotNode>,
    axTreeLookup: Map<number, AXNode>,
    jsListenerBackendIds: Set<number>,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
    frameId: string,
    ancestors: readonly DOMNode[] = [],
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return;
    // Skip nodes already processed.
    if (processedBackendIds.has(node.backendNodeId)) return;
    processedBackendIds.add(node.backendNodeId);

    const tagName = node.nodeName?.toLowerCase() || '';

    // Skip text and comment nodes (nodeType: 1=Element, 3=Text, 8=Comment).
    if (node.nodeType === 3 || node.nodeType === 8) {
      return;
    }

    // Tags to skip entirely, including their descendants.
    if (SKIP_TAGS.has(tagName) || SVG_ELEMENTS.has(tagName)) {
      return;
    }

    // Runtime listener discovery can promote a custom div/section out of the
    // structural-container bucket. This is required for direct and delegated
    // application controls that have no native tag/role/tabindex signal.
    const hasJSEventListener = jsListenerBackendIds.has(node.backendNodeId);
    const isContainer = CONTAINER_TAGS.has(tagName) && !hasJSEventListener;

    if (!isContainer) {
      // Get snapshot information.
      let snapshotNode = snapshotLookup.get(node.backendNodeId);

      // Get AX node information.
      const axNode = axTreeLookup.get(node.backendNodeId);

      // Check whether the element is interactive.
      const isInteractive = this.isElementInteractive(
        node,
        snapshotNode,
        axNode,
        hasJSEventListener,
      );

      // Only issue additional CDP quad queries for interactive child-frame nodes, avoiding a round trip per DOM node.
      if (isInteractive && snapshotNode?.coordinateSpace === 'frame-local') {
        const viewportBounds = await this.getViewportBoundsByBackendNodeId(
          node.backendNodeId,
          signal,
        );
        snapshotNode = viewportBounds
          ? {
              ...snapshotNode,
              bounds: viewportBounds,
              coordinateSpace: 'main-frame-viewport',
            }
          : {
              ...snapshotNode,
              coordinateSpace: 'unavailable',
            };
      }

      // Check element visibility.
      const isVisible = this.isElementVisible(snapshotNode, viewportInfo);

      // Add visible, interactive elements to the results.
      if (isVisible && isInteractive) {
        const element = this.createInteractiveElement(
          node,
          snapshotNode,
          axNode,
          viewportInfo,
          elements.length,
          node.frameId ?? frameId,
          hasJSEventListener,
        );
        if (element) {
          elements.push(element);
        }
      } else if (isInteractive && axNode && this.isVirtualEditorProxy(node, axNode)) {
        const host = this.findVisibleVirtualEditorHost(
          ancestors,
          snapshotLookup,
          viewportInfo,
          node.frameId ?? frameId,
        );
        if (host) {
          let hostSnapshotNode = host.snapshotNode;
          if (hostSnapshotNode.coordinateSpace === 'frame-local') {
            const viewportBounds = await this.getViewportBoundsByBackendNodeId(
              host.node.backendNodeId,
              signal,
            );
            hostSnapshotNode = viewportBounds
              ? {
                  ...hostSnapshotNode,
                  bounds: viewportBounds,
                  coordinateSpace: 'main-frame-viewport',
                }
              : {
                  ...hostSnapshotNode,
                  coordinateSpace: 'unavailable',
                };
          }
          const existingIndex = elements.findIndex(
            (element) => element.backendNodeId === host.node.backendNodeId,
          );
          const element = this.createVirtualEditorElement(
            node,
            host.node,
            hostSnapshotNode,
            axNode,
            viewportInfo,
            existingIndex >= 0 ? existingIndex : elements.length,
            node.frameId ?? frameId,
          );
          if (element) {
            if (existingIndex >= 0) elements[existingIndex] = element;
            else elements.push(element);
          }
        }
      }
    }

    // Recursively process child nodes.
    if (node.children) {
      for (const child of node.children) {
        await this.traverseDOMTree(
          child,
          elements,
          processedBackendIds,
          snapshotLookup,
          axTreeLookup,
          jsListenerBackendIds,
          viewportInfo,
          child.frameId ?? frameId,
          [...ancestors, node],
          signal,
        );
      }
    }

    // Process shadow DOM.
    if (node.shadowRoots) {
      for (const shadowRoot of node.shadowRoots) {
        await this.traverseDOMTree(
          shadowRoot,
          elements,
          processedBackendIds,
          snapshotLookup,
          axTreeLookup,
          jsListenerBackendIds,
          viewportInfo,
          shadowRoot.frameId ?? frameId,
          [...ancestors, node],
          signal,
        );
      }
    }

    // Process iframe contentDocument.
    if (node.contentDocument) {
      await this.traverseDOMTree(
        node.contentDocument,
        elements,
        processedBackendIds,
        snapshotLookup,
        axTreeLookup,
        jsListenerBackendIds,
        viewportInfo,
        node.contentDocument.frameId ?? node.frameId ?? frameId,
        [],
        signal,
      );
    }
  }

  /**
   * Check element visibility.
   */
  isElementVisible(
    snapshotNode: SnapshotNode | undefined,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
  ): boolean {
    if (!snapshotNode?.bounds) return false;

    const { bounds, computedStyles } = snapshotNode;

    // Check dimensions.
    if (bounds.width <= 0 || bounds.height <= 0) return false;

    // Check CSS visibility.
    const display = computedStyles.display?.toLowerCase();
    const visibility = computedStyles.visibility?.toLowerCase();
    const opacity = computedStyles.opacity;

    if (display === 'none') return false;
    if (visibility === 'hidden') return false;
    if (opacity !== undefined) {
      const opacityValue = parseFloat(opacity);
      if (!isNaN(opacityValue) && opacityValue <= 0) return false;
    }

    // Keep child-frame refs whose coordinates cannot be converted, but do not expose their rect to the model later.
    if (snapshotNode.coordinateSpace === 'unavailable') return true;

    // Check whether the element is in the viewport, allowing a margin.
    const threshold = 1000; // Allow elements within 1000px outside the viewport.
    const viewportRight = viewportInfo.width;
    // Keep vertically offscreen controls discoverable so the Core can scroll
    // them into view. Horizontally detached nodes are commonly focus traps or
    // hidden editor proxies and must remain excluded.
    const isInActionableDocument =
      bounds.x < viewportRight + threshold &&
      bounds.x + bounds.width > -threshold &&
      bounds.y + bounds.height > -threshold;

    return isInActionableDocument;
  }

  /**
   * Search-related keywords (following browser-use).
   */
  private static readonly SEARCH_INDICATORS = new Set([
    'search',
    'magnify',
    'glass',
    'lookup',
    'find',
    'query',
    'search-icon',
    'search-btn',
    'search-button',
    'searchbox',
  ]);

  /**
   * Check whether the element is search-related.
   */
  private isSearchElement(node: DOMNode): boolean {
    // Check class.
    const className = this.getNodeAttribute(node, 'class')?.toLowerCase() || '';
    const classList = className.split(/\s+/);
    for (const cls of classList) {
      for (const indicator of CDPPageScanner.SEARCH_INDICATORS) {
        if (cls.includes(indicator)) return true;
      }
    }

    // Check id.
    const id = this.getNodeAttribute(node, 'id')?.toLowerCase() || '';
    for (const indicator of CDPPageScanner.SEARCH_INDICATORS) {
      if (id.includes(indicator)) return true;
    }

    // Check data attributes.
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        const attrName = node.attributes[i];
        const attrValue = node.attributes[i + 1]?.toLowerCase() || '';
        if (attrName?.startsWith('data-')) {
          for (const indicator of CDPPageScanner.SEARCH_INDICATORS) {
            if (attrValue.includes(indicator)) return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Check whether the element is an interactive icon (a small 10–50px element).
   */
  private isInteractiveIcon(node: DOMNode, snapshotNode: SnapshotNode | undefined): boolean {
    if (!snapshotNode?.bounds) return false;

    const { width, height } = snapshotNode.bounds;

    // Check icon dimensions (10–50px).
    if (width < 10 || width > 50 || height < 10 || height > 50) {
      return false;
    }

    // Check for interaction-related attributes.
    const hasInteractiveAttr =
      this.getNodeAttribute(node, 'class') !== null ||
      this.getNodeAttribute(node, 'role') !== null ||
      this.getNodeAttribute(node, 'onclick') !== null ||
      this.getNodeAttribute(node, 'data-action') !== null ||
      this.getNodeAttribute(node, 'aria-label') !== null;

    return hasInteractiveAttr;
  }

  /**
   * Some rich editors expose only a visible activation surface until the first click. The real
   * input/contenteditable is mounted or focused afterwards. Keep this signal narrow: the surface
   * must explicitly render a text cursor and carry a semantic name; execution still fails closed
   * unless clicking it produces an editable focus inside the surface.
   */
  private isTextEntryActivationSurface(
    node: DOMNode,
    snapshotNode: SnapshotNode | undefined,
    axNode: AXNode | undefined,
  ): boolean {
    const tagName = node.nodeName?.toLowerCase() || '';
    if (tagName !== 'div' && tagName !== 'span') return false;
    if (snapshotNode?.computedStyles?.cursor !== 'text') return false;

    const role = (axNode?.role?.value || this.getNodeAttribute(node, 'role') || '').toLowerCase();
    if (role && role !== 'generic' && role !== 'none' && role !== 'textbox') return false;

    const semanticName =
      axNode?.name?.value ||
      this.getNodeAttribute(node, 'aria-label') ||
      this.getNodeAttribute(node, 'title') ||
      this.getNodeAttribute(node, 'placeholder') ||
      '';
    return semanticName.trim().length > 0;
  }

  /**
   * Check element interactivity, following browser-use's ClickableElementDetector.
   */
  isElementInteractive(
    node: DOMNode,
    snapshotNode: SnapshotNode | undefined,
    axNode: AXNode | undefined,
    hasJSClickListener: boolean,
  ): boolean {
    const tagName = node.nodeName?.toLowerCase() || '';

    // 0. Exclude text and non-element nodes.
    if (tagName === '#text' || tagName === '#comment' || node.nodeType !== 1) {
      return false;
    }

    // 1. Check JS event listeners (highest priority).
    if (hasJSClickListener) return true;

    // 1.1 AX ignored only means the accessibility tree does not expose the
    // node; it cannot override positive Runtime listener evidence above.
    if (axNode?.ignored) return false;

    // 2. Check natively interactive tags.
    if (INTERACTIVE_TAGS.has(tagName)) return true;

    // 3. Check ARIA role.
    const role = this.getNodeAttribute(node, 'role')?.toLowerCase();
    if (role && INTERACTIVE_ROLES.has(role)) return true;

    // 4. Check AX tree role, excluding generic and none.
    if (axNode?.role?.value) {
      const axRole = axNode.role.value.toLowerCase();
      // generic and none are not truly interactive roles.
      if (axRole !== 'generic' && axRole !== 'none' && INTERACTIVE_ROLES.has(axRole)) {
        return true;
      }
    }

    // 5. Check contenteditable.
    if (this.getNodeAttribute(node, 'contenteditable') === 'true') return true;

    // 6. Check tabindex (other than -1).
    const tabindex = this.getNodeAttribute(node, 'tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;

    // 7. Check event attributes such as onclick.
    const eventAttrs = [
      'onclick',
      'onmousedown',
      'onmouseup',
      'onkeydown',
      'onkeyup',
      'ontouchstart',
    ];
    for (const attr of eventAttrs) {
      if (this.getNodeAttribute(node, attr) !== null) return true;
    }

    // 8. Check search elements (following browser-use).
    if (this.isSearchElement(node)) return true;

    // 9. Check interactive icons (small 10–50px elements).
    if (this.isInteractiveIcon(node, snapshotNode)) return true;

    // 9.1 Check rich-text editor surfaces that mount/focus their actual input proxy only after a click.
    if (
      this.isTextEntryActivationSurface(node, snapshotNode, axNode) &&
      (snapshotNode?.isClickable === true ||
        this.axBooleanProperty(axNode, 'focusable') ||
        this.getNodeAttribute(node, 'tabindex') !== null)
    ) {
      return true;
    }

    // 10. Check cursor: pointer, requiring additional interaction signals.
    const hasCursorPointer = snapshotNode?.computedStyles?.cursor === 'pointer';

    // 11. Check the snapshot's isClickable flag.
    // Note: isClickable can produce false positives; combine it with other signals.
    const isClickable = snapshotNode?.isClickable === true;

    // 12. Check AX properties.
    let hasInteractiveAxProp = false;
    if (axNode?.properties) {
      for (const prop of axNode.properties) {
        // Editable or settable, excluding focusable because many elements are focusable.
        if (['editable', 'settable'].includes(prop.name) && prop.value?.value === true) {
          hasInteractiveAxProp = true;
          break;
        }
        // Interaction-state properties: their presence indicates interactivity.
        if (['checked', 'expanded', 'pressed', 'selected'].includes(prop.name)) {
          hasInteractiveAxProp = true;
          break;
        }
      }
    }

    // Generic elements such as div/span require multiple signals to count as interactive.
    if (tagName === 'div' || tagName === 'span') {
      // Require at least two signals or an explicit interaction attribute.
      const signals = [hasCursorPointer, isClickable, hasInteractiveAxProp].filter(Boolean).length;
      if (signals >= 2 || hasInteractiveAxProp) {
        return true;
      }
      return false;
    }

    // For other elements, any signal is sufficient.
    if (hasCursorPointer || isClickable || hasInteractiveAxProp) {
      return true;
    }

    // 13. Check for labels containing form controls.
    if (tagName === 'label') {
      // Skip labels with a for attribute to avoid duplicates.
      if (this.getNodeAttribute(node, 'for')) return false;
      if (this.hasFormControlDescendant(node)) return true;
    }

    // 14. Check iframes; those larger than 100x100 may require interaction.
    if ((tagName === 'iframe' || tagName === 'frame') && snapshotNode?.bounds) {
      if (snapshotNode.bounds.width > 100 && snapshotNode.bounds.height > 100) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get node attributes.
   */
  private getNodeAttribute(node: DOMNode, name: string): string | null {
    if (!node.attributes) return null;
    for (let i = 0; i < node.attributes.length; i += 2) {
      if (node.attributes[i] === name) {
        return node.attributes[i + 1] || '';
      }
    }
    return null;
  }

  /**
   * Check whether the node contains descendant form controls.
   */
  private hasFormControlDescendant(node: DOMNode, maxDepth = 2): boolean {
    if (maxDepth <= 0) return false;
    if (!node.children) return false;

    for (const child of node.children) {
      const tag = child.nodeName?.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        return true;
      }
      if (this.hasFormControlDescendant(child, maxDepth - 1)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Create an interactive element object.
   */
  private createInteractiveElement(
    node: DOMNode,
    snapshotNode: SnapshotNode | undefined,
    axNode: AXNode | undefined,
    viewportInfo: { width: number; height: number; scrollX: number; scrollY: number },
    index: number,
    frameId: string,
    runtimeDiscovered = false,
  ): InteractiveElement | null {
    const bounds = snapshotNode?.bounds;
    if (!bounds) return null;

    const tagName = node.nodeName?.toLowerCase() || '';

    const textEntryActivationSurface = this.isTextEntryActivationSurface(
      node,
      snapshotNode,
      axNode,
    );

    // Get the element type.
    let type = tagName;
    if (textEntryActivationSurface) {
      type = 'textbox';
    } else if (axNode?.role?.value) {
      type = axNode.role.value.toLowerCase();
    } else {
      const role = this.getNodeAttribute(node, 'role');
      if (role) type = role.toLowerCase();
    }
    // Get the element text.
    let text = '';
    if (axNode?.name?.value) {
      text = axNode.name.value;
    } else {
      text =
        this.getNodeAttribute(node, 'aria-label') ||
        this.getNodeAttribute(node, 'title') ||
        this.getNodeAttribute(node, 'placeholder') ||
        this.getNodeAttribute(node, 'alt') ||
        '';
    }
    if (!text && runtimeDiscovered) text = this.getDescendantText(node);
    text = text.slice(0, 100).trim();

    // Filter empty generic elements with no text or meaningful attributes.
    // These are usually container divs with no interaction value for the LLM.
    if (!runtimeDiscovered && (type === 'generic' || type === 'none') && !text) {
      // Check for meaningful attributes.
      const meaningfulAttrs = [
        'aria-label',
        'title',
        'data-testid',
        'data-action',
        'onclick',
        'tabindex',
        'draggable',
      ];
      const hasMeaningfulAttr = meaningfulAttrs.some(
        (attr) => this.getNodeAttribute(node, attr) !== null,
      );

      // Check whether the element is small (possibly an icon button).
      const isSmallElement = bounds.width <= 60 && bounds.height <= 60;

      // Filter elements with no meaningful attributes unless they are small.
      if (!hasMeaningfulAttr && !isSmallElement) {
        return null;
      }
    }

    // Generate a selector, preferring backendNodeId.
    const selector = `[data-backend-node-id="${node.backendNodeId}"]`;

    // Compute normalized coordinates.
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const hasViewportCoordinates = snapshotNode?.coordinateSpace === 'main-frame-viewport';
    const normalizedX = hasViewportCoordinates
      ? Math.round((centerX / viewportInfo.width) * 1000) / 1000
      : 0;
    const normalizedY = hasViewportCoordinates
      ? Math.round((centerY / viewportInfo.height) * 1000) / 1000
      : 0;

    // Check whether the element is in the viewport.
    const isInViewport =
      hasViewportCoordinates &&
      bounds.y < viewportInfo.height &&
      bounds.y + bounds.height > 0 &&
      bounds.x < viewportInfo.width &&
      bounds.x + bounds.width > 0;

    // Collect attributes.
    const attributes: Record<string, string> = {};
    const attrNames = [
      'id',
      'class',
      'data-testid',
      'data-action',
      'href',
      'src',
      'placeholder',
      'value',
      'aria-label',
      'aria-expanded',
      'aria-selected',
      'aria-checked',
      'aria-pressed',
      'type',
      'target',
      'name',
      'role',
      'contenteditable',
      'tabindex',
      'draggable',
    ];
    for (const attrName of attrNames) {
      const val = this.getNodeAttribute(node, attrName);
      if (val) attributes[attrName] = val;
    }

    // Check whether the element is disabled.
    const isDisabled =
      this.getNodeAttribute(node, 'disabled') !== null ||
      this.getNodeAttribute(node, 'aria-disabled') === 'true';

    return {
      index,
      backendNodeId: node.backendNodeId,
      frameId,
      selector,
      tag: tagName,
      type,
      text,
      normalizedPosition: { x: normalizedX, y: normalizedY },
      boundingBox: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      },
      coordinateSpace: hasViewportCoordinates ? 'main-frame-viewport' : 'unavailable',
      isInViewport,
      isInteractable: !isDisabled,
      attributes,
      paintOrder: snapshotNode?.paintOrder ?? undefined,
      ...(textEntryActivationSurface ? { inputStrategy: 'focused-keyboard' as const } : {}),
    };
  }

  private getDescendantText(node: DOMNode): string {
    let text = '';
    const visit = (current: DOMNode): void => {
      if (text.length >= 200) return;
      if (current.nodeType === 3 && current.nodeValue) text += ` ${current.nodeValue}`;
      for (const child of current.children ?? []) visit(child);
      for (const shadowRoot of current.shadowRoots ?? []) visit(shadowRoot);
    };
    visit(node);
    return text.replace(/\s+/gu, ' ').trim();
  }

  /**
   * Generate a unique selector.
   */
  private generateSelector(node: DOMNode): string {
    const tagName = node.nodeName?.toLowerCase() || 'div';

    // Prefer id.
    const id = this.getNodeAttribute(node, 'id');
    if (id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
      return `#${id}`;
    }

    // Use data-testid.
    const testId = this.getNodeAttribute(node, 'data-testid');
    if (testId) {
      return `[data-testid="${testId}"]`;
    }

    // Use aria-label.
    const ariaLabel = this.getNodeAttribute(node, 'aria-label');
    if (ariaLabel) {
      return `${tagName}[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
    }

    // Use name.
    const name = this.getNodeAttribute(node, 'name');
    if (name) {
      return `${tagName}[name="${name}"]`;
    }

    // Fall back to backendNodeId.
    return `[data-backend-node-id="${node.backendNodeId}"]`;
  }

  /**
   * Scan interactive elements using JavaScript as a fallback when CDP methods fail.
   */
  private async scanInteractiveElementsViaJS(
    _viewportInfo: {
      width: number;
      height: number;
      scrollX: number;
      scrollY: number;
    },
    signal: AbortSignal,
  ): Promise<InteractiveElement[]> {
    try {
      const elements = (await withTimeout(
        (commandSignal) =>
          this.transport.evaluate(
            `
        (function() {
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const elements = [];
          const processedElements = new WeakSet();

          // Generate a unique selector.
          function getUniqueSelector(el) {
            if (el.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(el.id)) {
              const selector = '#' + CSS.escape(el.id);
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            if (el.dataset.testid) {
              const selector = '[data-testid="' + CSS.escape(el.dataset.testid) + '"]';
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) {
              const tag = el.tagName.toLowerCase();
              const selector = tag + '[aria-label="' + CSS.escape(ariaLabel) + '"]';
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            if (el.name) {
              const tag = el.tagName.toLowerCase();
              const selector = tag + '[name="' + CSS.escape(el.name) + '"]';
              if (document.querySelectorAll(selector).length === 1) return selector;
            }
            // Build a path selector.
            const path = [];
            let current = el;
            while (current && current !== document.body && path.length < 4) {
              let sel = current.tagName.toLowerCase();
              if (current.id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(current.id)) {
                path.unshift('#' + CSS.escape(current.id));
                break;
              }
              const parent = current.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                if (siblings.length > 1) {
                  sel += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                }
              }
              path.unshift(sel);
              current = current.parentElement;
            }
            return path.join(' > ');
          }

          // Get element text.
          function getElementText(el) {
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) return ariaLabel.trim().slice(0, 100);
            const title = el.getAttribute('title');
            if (title) return title.trim().slice(0, 100);
            const placeholder = el.getAttribute('placeholder');
            if (placeholder) return placeholder.trim().slice(0, 100);
            const text = el.innerText?.trim();
            if (text) return text.slice(0, 100);
            if (el.tagName === 'IMG') return el.alt?.trim().slice(0, 100) || '';
            return '';
          }

          // Detect nested form controls.
          function hasFormControlDescendant(el, maxDepth = 2) {
            if (maxDepth <= 0) return false;
            for (const child of el.children) {
              const tag = child.tagName.toLowerCase();
              if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
              if (hasFormControlDescendant(child, maxDepth - 1)) return true;
            }
            return false;
          }

          // Determine whether the element is interactive.
          function isInteractive(el) {
            const tag = el.tagName.toLowerCase();
            if (tag === 'html' || tag === 'body') return { interactive: false };

            // Natively interactive tags.
            const interactiveTags = new Set([
              'button', 'input', 'select', 'textarea', 'a',
              'details', 'summary', 'option', 'optgroup', 'video', 'audio'
            ]);
            if (interactiveTags.has(tag)) return { interactive: true, type: tag };

            // ARIA roles
            const role = el.getAttribute('role');
            const interactiveRoles = new Set([
              'button', 'link', 'menuitem', 'option', 'radio', 'checkbox',
              'tab', 'textbox', 'combobox', 'slider', 'spinbutton', 'search',
              'searchbox', 'switch', 'gridcell', 'row', 'cell', 'treeitem'
            ]);
            if (role && interactiveRoles.has(role)) return { interactive: true, type: role };

            // contenteditable
            if (el.getAttribute('contenteditable') === 'true') return { interactive: true, type: 'editable' };

            // tabindex
            const tabIndex = el.getAttribute('tabindex');
            if (tabIndex !== null && tabIndex !== '-1') return { interactive: true, type: 'focusable' };

            // Event attributes such as onclick.
            if (el.hasAttribute('onclick') || el.onclick !== null) return { interactive: true, type: 'clickable' };
            const eventAttrs = ['onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'ontouchstart'];
            for (const attr of eventAttrs) {
              if (el.hasAttribute(attr)) return { interactive: true, type: 'clickable' };
            }

            // cursor: pointer
            const style = window.getComputedStyle(el);
            if (style.cursor === 'pointer') return { interactive: true, type: 'clickable' };

            // label contains form controls.
            if (tag === 'label') {
              if (el.hasAttribute('for')) return { interactive: false };
              if (hasFormControlDescendant(el, 2)) return { interactive: true, type: 'label' };
            }

            // span contains form controls.
            if (tag === 'span' && hasFormControlDescendant(el, 2)) return { interactive: true, type: 'wrapper' };

            // Interaction-state attributes.
            const stateAttrs = ['aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked'];
            for (const attr of stateAttrs) {
              if (el.hasAttribute(attr)) return { interactive: true, type: 'stateful' };
            }

            return { interactive: false };
          }

          // Add the element.
          function addElement(el, type, text) {
            if (processedElements.has(el)) return false;

            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;

            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (parseFloat(style.opacity) === 0) return false;

            processedElements.add(el);

            elements.push({
              index: elements.length,
              selector: getUniqueSelector(el),
              tag: el.tagName.toLowerCase(),
              type: type,
              text: text || getElementText(el),
              normalizedPosition: {
                x: Math.round(((rect.left + rect.width / 2) / viewportWidth) * 1000) / 1000,
                y: Math.round(((rect.top + rect.height / 2) / viewportHeight) * 1000) / 1000
              },
              boundingBox: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              coordinateSpace: 'main-frame-viewport',
              isInViewport: rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0,
              isInteractable: !el.disabled,
              attributes: {}
            });
            return true;
          }

          // Traverse the DOM.
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            {
              acceptNode: function(node) {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
              }
            }
          );

          let node;
          while (node = walker.nextNode()) {
            const result = isInteractive(node);
            if (result.interactive) {
              addElement(node, result.type, '');
            }
          }

          return elements;
        })()
      `,
            {
              signal: commandSignal,
              timeoutMs: BROWSER_TIMEOUTS.cdpCommand,
            },
          ),
        BROWSER_TIMEOUTS.cdpCommand,
        'Browser JavaScript element scan',
        { signal },
      )) as JavaScriptFallbackElement[];

      return Array.isArray(elements)
        ? await this.resolveJavaScriptFallbackElements(elements, signal)
        : [];
    } catch (error) {
      rethrowBrowserInterruption(error);
      console.warn('Failed to scan interactive elements via JS:', error);
      return [];
    }
  }
}
