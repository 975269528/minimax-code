const FS_UMBRELLA_TOOL_NAME = 'fs';
const FS_PERMISSION_TOOLS = new Set(['edit', 'write', 'read', 'glob', 'grep', 'list']);
const FS_WRITE_ASK_TOOLS = new Set(['edit', 'write']);

export function localPermissionRuleToolName(toolName: string): string {
  return FS_WRITE_ASK_TOOLS.has(toolName) ? FS_UMBRELLA_TOOL_NAME : toolName;
}

/**
 * Extract the primary identifier string from a tool input record.
 *
 * Shared by both the storage side (buildLocalPermissionRuleContents — what
 * gets persisted when the user clicks "Allow") and the matching side
 * (permissionInputTarget in rules.ts — what the incoming call is compared
 * against). Keeping them symmetric ensures that stored rules actually match
 * future calls.
 *
 * Priority order mirrors the most common tool input conventions:
 *   command > path > filePath > file_path > url > pattern (except grep) > cmd (bash)
 *
 * For tools with no recognized primary field (e.g. MCP tools with arbitrary
 * schemas), returns undefined — callers decide their own fallback (JSON
 * serialization for matching, or empty for storage → wildcard).
 */
export function resolveToolInputIdentifier(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const direct =
    input.command ??
    input.path ??
    input.filePath ??
    input.file_path ??
    input.url ??
    (toolName === 'grep' ? undefined : input.pattern);
  if (typeof direct === 'string' && direct.trim()) {
    const trimmed = direct.trim();
    // Normalize URLs to ensure path separator is present after the host,
    // so origin-wildcard rules like `https://host/*` can match URLs that
    // omit the path (e.g. `https://host?q=x` → `https://host/?q=x`).
    if (looksLikeUrl(trimmed)) return normalizeUrlForMatching(trimmed);
    return trimmed;
  }
  if (toolName === 'bash' && typeof input.cmd === 'string' && input.cmd.trim())
    return input.cmd.trim();
  return undefined;
}

export function buildLocalPermissionRuleContents(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const identifier = resolveToolInputIdentifier(toolName, input);
  if (identifier) return [normalizeLocalPermissionRuleContent(toolName, identifier)];
  return [];
}

export function buildLocalHardDenyReason(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  void toolName;
  void input;
  return undefined;
}

function normalizeLocalPermissionRuleContent(toolName: string, content: string): string {
  const trimmed = content.trim();
  if (!FS_PERMISSION_TOOLS.has(toolName)) {
    // URL-like content: normalize to host (domain + non-default port)
    // so that allowing one URL on a domain covers all paths/queries/protocols.
    if (looksLikeUrl(trimmed)) {
      return normalizeUrlToHost(trimmed);
    }
    return trimmed;
  }
  const normalized = trimmed.replaceAll('\\', '/');
  if (toolName === 'glob' && hasGlobMeta(normalized) && !startsWithPathRoot(normalized))
    return trimmed;
  if (!looksPathLikePermissionContent(normalized)) return trimmed;
  const directoryTools = new Set(['glob', 'grep', 'list']);
  const rawBase = directoryTools.has(toolName)
    ? normalized.replace(/\/+$/, '')
    : dirnameLike(normalized).replaceAll('\\', '/');
  const base = rawBase.replace(/\/+$/, '');
  if (!base || base === '.' || base === '..') return trimmed;
  return `${base}/**`;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Extract the host (hostname + non-default port) from a URL.
 * This is the permission scope identifier: `www.bbc.com`, `localhost:3000`.
 * Protocol and path are stripped — the permission is about domain trust.
 */
function extractUrlHost(url: string): string {
  try {
    const parsed = new URL(url);
    // parsed.host includes port if non-default (e.g. "localhost:3000")
    return parsed.host;
  } catch {
    // Malformed URL — best-effort extraction
    const protoEnd = url.indexOf('://');
    const rest = protoEnd >= 0 ? url.slice(protoEnd + 3) : url;
    const sep = rest.search(/[/?#]/);
    return sep > 0 ? rest.slice(0, sep) : rest;
  }
}

/**
 * Normalize a URL to its host identifier for matching.
 * `https://www.bbc.com/news?q=x` → `www.bbc.com`
 * `http://localhost:3000/api` → `localhost:3000`
 */
function normalizeUrlForMatching(url: string): string {
  return extractUrlHost(url);
}

/**
 * Normalize a URL to a host-level rule for storage.
 * `https://www.bbc.com/path` → `www.bbc.com`
 * `http://localhost:3000/api` → `localhost:3000`
 *
 * Stored in permission.json as: `web_fetch(www.bbc.com)`
 */
function normalizeUrlToHost(url: string): string {
  return extractUrlHost(url);
}

function dirnameLike(value: string): string {
  const idx = value.lastIndexOf('/');
  return idx >= 0 ? value.slice(0, idx) || '/' : '.';
}

function hasGlobMeta(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function startsWithPathRoot(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~/') || value.startsWith('./');
}

function looksPathLikePermissionContent(value: string): boolean {
  return startsWithPathRoot(value) || value.includes('/');
}
