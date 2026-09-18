import type { ToolResultContent } from '@mavis/agent-core/tools';
import type { LocalMcpCallResult } from '../contracts.js';
import { readRecord } from '../runtime/config.js';

export function normalizeCallResult(value: Record<string, unknown>): LocalMcpCallResult {
  const content = Array.isArray(value['content'])
    ? value['content'].filter(
        (item): item is LocalMcpCallResult['content'][number] =>
          !!item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as { type?: unknown }).type === 'string',
      )
    : [{ type: 'text', text: JSON.stringify(value) }];
  const structuredContent = readRecord(value['structuredContent']);
  const meta = readRecord(value['_meta']);
  return {
    content: content as LocalMcpCallResult['content'],
    ...(structuredContent ? { structuredContent } : {}),
    ...(typeof value['isError'] === 'boolean' ? { isError: value['isError'] } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

export function mapMcpContent(result: LocalMcpCallResult): {
  text: string;
  content: ToolResultContent[];
} {
  const content: ToolResultContent[] = [];
  const summary: string[] = [];

  for (const rawItem of result.content) {
    mapContentItem(rawItem, content, summary);
  }

  if (result.structuredContent) {
    pushTextFallback(content, summary, formatStructuredContent(result.structuredContent));
  }

  if (content.length > 0) {
    return { text: summary.join('\n'), content };
  }

  const text = result.isError ? 'MCP tool returned an error.' : 'MCP tool returned no content.';
  return { text, content: [{ type: 'text', text }] };
}

function pushTextFallback(content: ToolResultContent[], summary: string[], text: string): void {
  content.push({ type: 'text', text });
  summary.push(text);
}

function mapEmbeddedResource(
  item: Record<string, unknown>,
  content: ToolResultContent[],
  summary: string[],
): void {
  const resource = readRecord(item['resource']);
  if (!resource || typeof resource['uri'] !== 'string') {
    pushTextFallback(content, summary, '[invalid MCP resource]');
    return;
  }

  const uri = resource['uri'];
  const mimeType = nonemptyString(resource['mimeType']) ? resource['mimeType'] : undefined;
  const text = resource['text'];
  if (typeof text === 'string') {
    const header = `[MCP text resource: uri=${quoteField(uri)}${mimeField(mimeType)}]`;
    const projected = text.length > 0 ? `${header}\n${text}` : header;
    content.push({ type: 'text', text: projected });
    summary.push(projected);
    return;
  }

  const blob = resource['blob'];
  if (typeof blob !== 'string' || blob.length === 0) {
    pushTextFallback(content, summary, '[invalid MCP resource]');
    return;
  }

  const normalizedMimeType = mimeType?.toLowerCase();
  if (mimeType && normalizedMimeType?.startsWith('image/')) {
    content.push({ type: 'image', data: blob, mimeType });
    summary.push(`[MCP image resource: uri=${quoteField(uri)}; mime=${quoteField(mimeType)}]`);
    return;
  }

  const kind = resourceKind(normalizedMimeType);
  pushTextFallback(
    content,
    summary,
    `[MCP ${kind} resource: uri=${quoteField(uri)}${mimeField(mimeType)}; ` +
      'binary retained in details.mcp]',
  );
}

function formatResourceLink(item: Record<string, unknown>): string | undefined {
  const name = item['name'];
  const uri = item['uri'];
  if (!nonemptyString(name) || !nonemptyString(uri)) {
    return undefined;
  }

  const fields = [`name=${quoteField(name)}`, `uri=${quoteField(uri)}`];
  if (nonemptyString(item['mimeType'])) {
    fields.push(`mime=${quoteField(item['mimeType'])}`);
  }
  if (nonemptyString(item['title'])) {
    fields.push(`title=${quoteField(item['title'])}`);
  }
  if (typeof item['description'] === 'string' && item['description'].length > 0) {
    fields.push(`description=${quoteField(item['description'])}`);
  }
  return `[MCP resource link: ${fields.join('; ')}]`;
}

function formatStructuredContent(value: Record<string, unknown>): string {
  try {
    return `[MCP structured content]\n${JSON.stringify(value)}`;
  } catch {
    return '[invalid MCP structured content]';
  }
}

function mimeField(mimeType: string | undefined): string {
  return mimeType ? `; mime=${quoteField(mimeType)}` : '';
}

function quoteField(value: string): string {
  return JSON.stringify(value);
}

function mapContentItem(rawItem: unknown, content: ToolResultContent[], summary: string[]): void {
  // Live SDK calls are protocol-validated. Keep the runtime guards because
  // tests and metadata.mockResponses may still supply malformed values.
  const item = readRecord(rawItem) ?? {};
  const type = typeof item['type'] === 'string' ? item['type'] : 'unknown';

  if (type === 'text') return mapText(item, content, summary);

  if (type === 'image') return mapImage(item, content, summary);

  if (type === 'audio') return mapAudio(item, content, summary);

  if (type === 'resource_link') {
    const resourceLink = formatResourceLink(item);
    pushTextFallback(content, summary, resourceLink ?? '[invalid MCP resource link]');
    return;
  }

  if (type === 'resource') {
    mapEmbeddedResource(item, content, summary);
    return;
  }

  pushTextFallback(content, summary, `[unsupported MCP content: ${type}]`);
}

function mapText(
  item: Record<string, unknown>,
  content: ToolResultContent[],
  summary: string[],
): void {
  const text = item['text'];
  if (typeof text === 'string' && text.length > 0) {
    content.push({ type: 'text', text });
    summary.push(text);
  } else {
    pushTextFallback(content, summary, '[invalid MCP text]');
  }
}

function mapImage(
  item: Record<string, unknown>,
  content: ToolResultContent[],
  summary: string[],
): void {
  const data = item['data'];
  const mimeType = item['mimeType'];
  if (
    typeof data === 'string' &&
    data.length > 0 &&
    typeof mimeType === 'string' &&
    mimeType.toLowerCase().startsWith('image/')
  ) {
    content.push({ type: 'image', data, mimeType });
    summary.push(`[image: ${mimeType}]`);
  } else {
    pushTextFallback(content, summary, '[invalid MCP image]');
  }
}

function mapAudio(
  item: Record<string, unknown>,
  content: ToolResultContent[],
  summary: string[],
): void {
  const data = item['data'];
  const mimeType = item['mimeType'];
  if (
    typeof data === 'string' &&
    data.length > 0 &&
    typeof mimeType === 'string' &&
    mimeType.toLowerCase().startsWith('audio/')
  ) {
    pushTextFallback(
      content,
      summary,
      `[MCP audio: mime=${quoteField(mimeType)}; binary retained in details.mcp]`,
    );
  } else {
    pushTextFallback(content, summary, '[invalid MCP audio]');
  }
}

function resourceKind(mime?: string): string {
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  return 'file';
}
function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
