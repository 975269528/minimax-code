export const DEFAULT_CDP_TIMEOUT_MS = 15_000;
export const DRAG_PATH_STEPS = 8;

export interface DOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  nodeType: number;
  nodeValue?: string;
  attributes?: string[];
  children?: DOMNode[];
  shadowRoots?: DOMNode[];
  contentDocument?: DOMNode;
  frameId?: string;
}

export interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  properties?: Array<{
    name: string;
    value?: { value?: unknown };
  }>;
  childIds?: string[];
  ignored?: boolean;
}

export interface DOMSnapshotResult {
  documents: Array<{
    documentURL?: number;
    frameId?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    nodes: {
      backendNodeId?: number[];
      nodeName?: number[];
      nodeType?: number[];
      parentIndex?: number[];
      attributes?: Array<{ name: number; value: number }[]>;
      isClickable?: { index: number[] };
    };
    layout?: {
      nodeIndex?: number[];
      bounds?: number[][];
      styles?: number[][];
      paintOrders?: number[];
      clientRects?: number[][];
      scrollRects?: number[][];
    };
  }>;
  strings?: string[];
}

export interface CDPDragData {
  items: Array<{
    mimeType: string;
    data: string;
    title?: string;
    baseURL?: string;
  }>;
  files?: string[];
  dragOperationsMask: number;
}

export const DRAG_CANCEL_DATA: CDPDragData = {
  items: [],
  dragOperationsMask: 0xffff,
};

export interface CDPDragGestureResult {
  mode: 'pointer' | 'html5';
  dragStarted: boolean;
  dropDispatched: boolean;
}

export interface CDPDragGestureOptions {
  /** Equivalent to Playwright's Progress timeout for awaiting Input.dragIntercepted. */
  interceptTimeoutMs?: number;
  /** Bound each CDP command issued by the gesture. */
  commandTimeoutMs?: number;
  /** Cancel the gesture while still allowing bounded pointer cleanup. */
  signal?: AbortSignal;
}

export interface CDPFileUploadOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CDPFileUploadResult {
  filesAttached: number;
  chooserOpened: boolean;
}

/** Scope a backend-node read to the CDP session that owns the node. */
export interface CDPBackendNodeInspectionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  commandSessionId?: string;
}

export interface CDPEditableState {
  tag: string;
  role: string;
  contentEditable: boolean;
  editable: boolean;
  focused: boolean;
  textLength: number;
  fingerprint: string;
  /** Computed in-page only when an expected value is supplied; editable content is never returned. */
  matchesExpected?: boolean;
  /** Computed in-page only when expected text is supplied; editable content is never returned. */
  containsExpected?: boolean;
}

export interface CDPFocusedEditableState extends CDPEditableState {
  /** Whether the deep active element is the activation host itself or one of its descendants. */
  withinTarget: boolean;
}

export interface CDPRenderedState {
  textLength: number;
  fingerprint: string;
  /** Computed in-page only when an expected value is supplied; rendered text is never returned. */
  matchesExpected?: boolean;
  /** Computed in-page only when expected text is supplied; rendered text is never returned. */
  containsExpected?: boolean;
}

export interface CDPConsoleDiagnosticEntry {
  sequence: number;
  source: 'console' | 'exception';
  level: string;
  timestamp: number;
  message: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stack?: string[];
}

export type CDPConsoleDiagnosticLevelFilter =
  | 'debug'
  | 'info'
  | 'log'
  | 'warn'
  | 'warning'
  | 'error';

export interface CDPConsoleDiagnosticsOptions {
  limit?: number;
  levels?: readonly CDPConsoleDiagnosticLevelFilter[];
  filter?: string;
}

export interface CDPConsoleDiagnosticsPage {
  entries: CDPConsoleDiagnosticEntry[];
  totalEntries: number;
  returnedEntries: number;
  truncated: boolean;
}

export type CDPNetworkDiagnosticOutcome =
  | 'pending'
  | 'success'
  | 'redirect'
  | 'http-error'
  | 'failed';

export type CDPNetworkDiagnosticStatusFilter =
  | 'pending'
  | 'success'
  | 'failed'
  | '2xx'
  | '3xx'
  | '4xx'
  | '5xx';

export type CDPNetworkDiagnosticResourceType =
  | 'document'
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'script'
  | 'xhr'
  | 'fetch'
  | 'eventsource'
  | 'manifest'
  | 'preflight'
  | 'other';

export interface CDPNetworkDiagnosticEntry {
  sequence: number;
  method: string;
  url: string;
  resourceType: CDPNetworkDiagnosticResourceType;
  outcome: CDPNetworkDiagnosticOutcome;
  timestamp: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failureReason?: string;
  durationMs?: number;
}

export interface CDPNetworkDiagnosticsOptions {
  limit?: number;
  status?: readonly CDPNetworkDiagnosticStatusFilter[];
  resourceTypes?: readonly CDPNetworkDiagnosticResourceType[];
  filter?: string;
  afterSequence?: number;
}

export interface CDPNetworkDiagnosticsPage {
  entries: CDPNetworkDiagnosticEntry[];
  lastSequence: number;
  totalEntries: number;
  returnedEntries: number;
  truncated: boolean;
}

export type CDPHoverTargetNameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'title'
  | 'svg-title'
  | 'alt'
  | 'text'
  | 'none';

export interface CDPHoverSemanticSnapshot {
  target: {
    name: string;
    source: CDPHoverTargetNameSource;
    supportingText: string;
  };
  nearby: Array<{
    fingerprint: string;
    text: string;
    role: string;
    linked: boolean;
    distance: number;
  }>;
}

export type CDPTextInputErrorCode = 'INPUT_FOCUS_REJECTED';

export class CDPTextInputError extends Error {
  readonly code: CDPTextInputErrorCode;

  constructor(code: CDPTextInputErrorCode, message: string) {
    super(message);
    this.name = 'CDPTextInputError';
    this.code = code;
  }
}

export type CDPDragErrorCode = 'DRAG_DATA_UNAVAILABLE' | 'DROP_DISPATCH_FAILED';

export class CDPDragError extends Error {
  readonly code: CDPDragErrorCode;

  constructor(code: CDPDragErrorCode, message: string) {
    super(message);
    this.name = 'CDPDragError';
    this.code = code;
  }
}

/** Required computed styles, kept deliberately small for complex pages. */
export const REQUIRED_COMPUTED_STYLES = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
];

export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'spinbutton',
  'slider',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'gridcell',
  'row',
  'cell',
]);

export const INTERACTIVE_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'a',
  'details',
  'summary',
  'option',
  'optgroup',
  'video',
  'audio',
]);

export const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'meta', 'link', 'head']);
export const CONTAINER_TAGS = new Set(['html', 'body', '#document']);
export const SVG_ELEMENTS = new Set([
  'path',
  'rect',
  'g',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'use',
  'defs',
  'clipPath',
  'mask',
  'pattern',
  'image',
  'text',
  'tspan',
]);

export interface SnapshotNode {
  bounds: { x: number; y: number; width: number; height: number } | null;
  coordinateSpace: 'main-frame-viewport' | 'frame-local' | 'unavailable';
  computedStyles: Record<string, string>;
  isClickable: boolean;
  paintOrder: number | null;
  /** Owning CDP frame, retained for canonical semantic identity. */
  frameId?: string;
}
