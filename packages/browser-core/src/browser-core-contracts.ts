/** Provider-neutral page semantics used by Electron and native-headless. */

export interface BrowserDOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  nodeType: number;
  nodeValue?: string;
  attributes?: string[];
  children?: BrowserDOMNode[];
  shadowRoots?: BrowserDOMNode[];
  contentDocument?: BrowserDOMNode;
  frameId?: string;
}

export interface BrowserAXNode {
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

export interface BrowserSnapshotNode {
  bounds: { x: number; y: number; width: number; height: number } | null;
  coordinateSpace: 'main-frame-viewport' | 'frame-local' | 'unavailable';
  computedStyles: Record<string, string>;
  isClickable: boolean;
  paintOrder: number | null;
  frameId?: string;
}

export interface BrowserInteractiveElement {
  index: number;
  backendNodeId: number;
  frameId?: string;
  commandSessionId?: string;
  frameOffset?: { x: number; y: number };
  selector: string;
  tag: string;
  type: string;
  text: string;
  normalizedPosition: { x: number; y: number };
  boundingBox: { x: number; y: number; width: number; height: number };
  coordinateSpace?: 'main-frame-viewport' | 'unavailable';
  isInViewport: boolean;
  isInteractable: boolean;
  attributes: Record<string, string>;
  paintOrder?: number;
  inputStrategy?: 'focused-keyboard';
  semanticBackendNodeId?: number;
}

export type BrowserWaitState = 'attached' | 'detached' | 'visible' | 'hidden';

export type BrowserWaitInput =
  | { kind: 'timeout'; timeout: number }
  | { kind: 'selector'; selector: string; state?: BrowserWaitState; timeout?: number }
  | { kind: 'text'; text: string; timeout?: number }
  | { kind: 'url'; url: string; timeout?: number }
  | { kind: 'load'; timeout?: number };

export type DOMNode = BrowserDOMNode;
export type AXNode = BrowserAXNode;
export type SnapshotNode = BrowserSnapshotNode;
export type InteractiveElement = BrowserInteractiveElement;
