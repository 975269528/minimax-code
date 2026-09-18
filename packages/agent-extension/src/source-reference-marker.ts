type MarkerBlock = { readonly type: 'text'; readonly text: string };

// Host-created objects only: tool-provided text/details cannot opt out of the
// output budget by imitating the citation protocol. Never serialize this trust.
const markers = new WeakSet<object>();

export function createSourceReferenceMarkerBlock(text: string): MarkerBlock {
  const block: MarkerBlock = { type: 'text', text };
  markers.add(block);
  return block;
}

export function isSourceReferenceMarkerBlock(block: MarkerBlock): boolean {
  return markers.has(block);
}
