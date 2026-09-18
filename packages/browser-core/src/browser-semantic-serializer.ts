import type {
  AgentSemanticNode,
  AgentSemanticTreePage,
  SemanticNode,
  SemanticPageTree,
  SemanticTargetRef,
} from './browser-semantic-tree.js';

const MODEL_CONTEXT_ROLES = new Set([
  'document',
  'main',
  'navigation',
  'region',
  'article',
  'form',
  'dialog',
  'alertdialog',
  'heading',
  'list',
  'listitem',
  'table',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'group',
  'paragraph',
  'label',
  'caption',
  'note',
  'status',
  'alert',
  'description',
]);

function subtreeCounts(
  node: SemanticNode,
  refs: ReadonlyMap<string, SemanticTargetRef>,
  allowedRefs: ReadonlySet<string>,
  counts: Map<string, { anyActionable: number; allowedActionable: number }>,
): { anyActionable: number; allowedActionable: number } {
  const ownRef = node.targetKey ? refs.get(node.targetKey)?.ref : undefined;
  let anyActionable = ownRef ? 1 : 0;
  let allowedActionable = ownRef && allowedRefs.has(ownRef) ? 1 : 0;
  for (const child of node.children) {
    const childCounts = subtreeCounts(child, refs, allowedRefs, counts);
    anyActionable += childCounts.anyActionable;
    allowedActionable += childCounts.allowedActionable;
  }
  const result = { anyActionable, allowedActionable };
  counts.set(node.id, result);
  return result;
}

export function serializeSemanticTreePage(
  tree: SemanticPageTree,
  refs: ReadonlyMap<string, SemanticTargetRef>,
  allowedRefs: ReadonlySet<string>,
  options: { maxNodes?: number; maxBytes?: number } = {},
): AgentSemanticTreePage {
  const maxNodes = Math.max(1, options.maxNodes ?? 200);
  const maxBytes = Math.max(256, options.maxBytes ?? 12_000);
  const counts = new Map<string, { anyActionable: number; allowedActionable: number }>();
  tree.roots.forEach((root) => subtreeCounts(root, refs, allowedRefs, counts));
  let retainedNodes = 0;
  let retainedBytes = 0;
  let truncated = tree.truncated;

  const actionableFirst = (nodes: readonly SemanticNode[]): SemanticNode[] =>
    nodes
      .map((node, index) => ({ node, index }))
      .sort((left, right) => {
        const leftAllowed = counts.get(left.node.id)?.allowedActionable ?? 0;
        const rightAllowed = counts.get(right.node.id)?.allowedActionable ?? 0;
        return rightAllowed - leftAllowed || left.index - right.index;
      })
      .map(({ node }) => node);

  const serialize = (node: SemanticNode, contextual = false): AgentSemanticNode | null => {
    const count = counts.get(node.id) ?? { anyActionable: 0, allowedActionable: 0 };
    const targetRef = node.targetKey ? refs.get(node.targetKey) : undefined;
    if (targetRef && !allowedRefs.has(targetRef.ref)) return null;
    if (!targetRef && count.anyActionable > 0 && count.allowedActionable === 0) return null;
    if (
      !targetRef &&
      count.allowedActionable === 0 &&
      !contextual &&
      !MODEL_CONTEXT_ROLES.has(node.role)
    ) {
      return null;
    }
    const base: AgentSemanticNode = {
      role: node.role,
      ...(node.name ? { name: node.name } : {}),
      ...(node.text ? { text: node.text } : {}),
      ...(node.level ? { level: node.level } : {}),
      ...(node.state ? { state: node.state } : {}),
      ...(targetRef
        ? {
            ref: targetRef.ref,
            frame: targetRef.frameRef,
            actionable: true as const,
            ...(node.coordinateSpace !== 'unavailable' && node.rect
              ? { rect: { ...node.rect } }
              : {}),
          }
        : {}),
    };
    const estimatedBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
    if (retainedNodes >= maxNodes || retainedBytes + estimatedBytes > maxBytes) {
      truncated = true;
      return null;
    }
    retainedNodes += 1;
    retainedBytes += estimatedBytes;
    const children = actionableFirst(node.children)
      .map((child) => serialize(child, count.allowedActionable > 0 || contextual))
      .filter((child): child is AgentSemanticNode => child !== null);
    return children.length > 0 ? { ...base, children } : base;
  };

  const roots = actionableFirst(tree.roots)
    .map((root) => serialize(root))
    .filter((root): root is AgentSemanticNode => root !== null);
  return { version: 1, roots, truncated };
}
