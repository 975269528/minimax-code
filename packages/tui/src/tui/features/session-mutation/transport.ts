const HIDDEN_CONTEXT_BLOCK_RE =
  /<(user-provided-context|mavis-chat-context|html-selection-context|deployed-website-context)\b[^>]*>[\s\S]*?<\/\1>/gu;
const DEPLOYED_WEBSITE_CONTEXT_RE =
  /<deployed-website-context\b[^>]*>[\s\S]*?<\/deployed-website-context>/gu;

/** Project Runtime transport into the text users are allowed to edit. */
export function visibleSessionMutationContent(transportContent: string | undefined): string {
  return (transportContent ?? '').replace(HIDDEN_CONTEXT_BLOCK_RE, '').trim();
}

/** Replace visible text without discarding the hidden context carried by Runtime transport. */
export function rebuildSessionMutationTransport(
  transportContent: string | undefined,
  content: string,
): string | undefined {
  if (!transportContent) return undefined;
  let contextPrefixEnd = 0;
  const contextBlocks: string[] = [];
  for (const match of transportContent.matchAll(HIDDEN_CONTEXT_BLOCK_RE)) {
    const matchStart = match.index;
    if (!/^\s*$/u.test(transportContent.slice(contextPrefixEnd, matchStart))) break;
    contextPrefixEnd = matchStart + match[0].length;
    contextBlocks.push(match[0].trim());
  }
  for (const match of transportContent.matchAll(DEPLOYED_WEBSITE_CONTEXT_RE)) {
    const block = match[0].trim();
    if (!contextBlocks.includes(block)) contextBlocks.push(block);
  }
  if (contextBlocks.length === 0) return undefined;
  const visibleContent = content.trim();
  return [...contextBlocks, ...(visibleContent ? [visibleContent] : [])].join('\n\n');
}
