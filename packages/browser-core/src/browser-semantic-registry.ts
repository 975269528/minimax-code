import type {
  BrowserInteractiveElement,
  BrowserAXNode as AXNode,
  BrowserDOMNode as DOMNode,
  BrowserSnapshotNode as SnapshotNode,
} from './browser-core-contracts.js';
import type { CanonicalNode } from './browser-semantic-tree.js';

function canonicalKey(frameId: string, backendNodeId: number): string {
  return `${frameId}:${backendNodeId}`;
}

export class CanonicalNodeRegistry {
  private readonly nodes = new Map<string, CanonicalNode>();
  private readonly keysByBackendNodeId = new Map<number, Set<string>>();

  constructor(private readonly mainFrameId: string) {}

  private ensure(key: string, frameId: string, backendNodeId?: number): CanonicalNode {
    const existing = this.nodes.get(key);
    if (existing) return existing;
    const node: CanonicalNode = {
      key,
      frameId,
      ...(backendNodeId !== undefined ? { backendNodeId } : {}),
      provenance: new Set(),
    };
    this.nodes.set(key, node);
    if (backendNodeId !== undefined) {
      const keys = this.keysByBackendNodeId.get(backendNodeId) ?? new Set<string>();
      keys.add(key);
      this.keysByBackendNodeId.set(backendNodeId, keys);
    }
    return node;
  }

  private resolveKey(backendNodeId: number, frameId?: string): string | undefined {
    if (frameId) {
      const exact = canonicalKey(frameId, backendNodeId);
      if (this.nodes.has(exact)) return exact;
    }
    const keys = this.keysByBackendNodeId.get(backendNodeId);
    if (!keys || keys.size === 0) return undefined;
    if (keys.size === 1) return keys.values().next().value;
    const mainFrameKey = canonicalKey(this.mainFrameId, backendNodeId);
    return keys.has(mainFrameKey) ? mainFrameKey : undefined;
  }

  addDOMTree(root: DOMNode): void {
    const visit = (node: DOMNode, inheritedFrameId: string, parentKey?: string): void => {
      const frameId = node.frameId ?? inheritedFrameId;
      const key = canonicalKey(frameId, node.backendNodeId);
      const canonical = this.ensure(key, frameId, node.backendNodeId);
      canonical.dom = node;
      canonical.provenance.add('dom');
      if (parentKey && parentKey !== key) canonical.domParentKey = parentKey;
      for (const child of node.children ?? []) visit(child, frameId, key);
      for (const shadowRoot of node.shadowRoots ?? []) visit(shadowRoot, frameId, key);
      if (node.contentDocument)
        visit(node.contentDocument, node.contentDocument.frameId ?? frameId, key);
    };
    visit(root, root.frameId ?? this.mainFrameId);
  }

  addSnapshotRecords(records: ReadonlyMap<number, SnapshotNode>): void {
    for (const [backendNodeId, layout] of records) {
      const existingKey = this.resolveKey(backendNodeId, layout.frameId);
      const frameId =
        layout.frameId ??
        (existingKey ? this.nodes.get(existingKey)?.frameId : undefined) ??
        this.mainFrameId;
      const key = existingKey ?? canonicalKey(frameId, backendNodeId);
      const canonical = this.ensure(key, frameId, backendNodeId);
      canonical.layout = layout;
      canonical.provenance.add('snapshot');
    }
  }

  addAXTree(nodes: readonly AXNode[]): void {
    const keyByAxId = new Map<string, string>();
    for (const axNode of nodes) {
      const existingKey = axNode.backendDOMNodeId
        ? this.resolveKey(axNode.backendDOMNodeId)
        : undefined;
      const key =
        existingKey ??
        (axNode.backendDOMNodeId
          ? canonicalKey(this.mainFrameId, axNode.backendDOMNodeId)
          : `ax:${axNode.nodeId}`);
      const frameId = existingKey
        ? (this.nodes.get(existingKey)?.frameId ?? this.mainFrameId)
        : this.mainFrameId;
      const canonical = this.ensure(key, frameId, axNode.backendDOMNodeId);
      canonical.ax = axNode;
      canonical.provenance.add('ax');
      keyByAxId.set(axNode.nodeId, key);
    }
    for (const axNode of nodes) {
      const parentKey = keyByAxId.get(axNode.nodeId);
      if (!parentKey) continue;
      for (const childId of axNode.childIds ?? []) {
        const childKey = keyByAxId.get(childId);
        if (!childKey || childKey === parentKey) continue;
        const child = this.nodes.get(childKey);
        if (child) child.axParentKey = parentKey;
      }
    }
  }

  addInteractiveElements(elements: readonly BrowserInteractiveElement[]): void {
    for (const element of elements) {
      const frameId = element.frameId ?? this.mainFrameId;
      const key = canonicalKey(frameId, element.backendNodeId);
      const canonical = this.ensure(key, frameId, element.backendNodeId);
      canonical.target = element;
      if (
        element.semanticBackendNodeId !== undefined &&
        element.semanticBackendNodeId !== element.backendNodeId
      ) {
        canonical.semanticSourceKey =
          this.resolveKey(element.semanticBackendNodeId, frameId) ??
          canonicalKey(frameId, element.semanticBackendNodeId);
      }
    }
  }

  get(key: string): CanonicalNode | undefined {
    return this.nodes.get(key);
  }

  values(): CanonicalNode[] {
    return [...this.nodes.values()];
  }
}
