import type { ToolDefinition } from '@mavis/agent-core/tools';
import { tokenize } from './tokenize.js';
import type { McpToolEntry, McpToolIndex, McpSearchHit } from './types.js';

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function flattenSchema(schema: unknown, max: number): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o.description === 'string') parts.push(o.description);
    if (Array.isArray(o.enum)) parts.push(o.enum.map(String).join(' '));
    if (Array.isArray(o.required)) parts.push(o.required.map(String).join(' '));
    if (o.properties && typeof o.properties === 'object') {
      for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
        parts.push(k);
        walk(v);
      }
    }
    if (o.items) walk(o.items);
  };
  walk(schema);
  return parts.join(' ').slice(0, max);
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface Doc {
  name: string;
  description: string;
  input_schema: unknown;
  raw: string;
  tokens: string[];
  len: number;
  tf: Map<string, number>;
}

/**
 * Pure, stable content signature for a candidate set. Hashes the sorted
 * `name:fnv1a(schema):fnv1a(description)` triples — it intentionally does NOT
 * depend on `maxSchemaTextLen`, so two indexes built from the same candidates
 * (regardless of schema-text truncation) share a signature. `buildIndex` and
 * `buildOrReuseIndex` both route through this so their signatures always agree.
 */
export function computeIndexSignature(candidates: readonly McpToolEntry[]): string {
  return fnv1a(
    [...candidates]
      .map(
        (e) =>
          `${e.tool.def.name}:${fnv1a(JSON.stringify(e.tool.def.schema ?? {}))}:${fnv1a(e.tool.def.description ?? '')}`,
      )
      .sort()
      .join('|'),
  );
}

export function buildIndex(
  candidates: readonly McpToolEntry[],
  opts: { maxSchemaTextLen: number },
): McpToolIndex {
  const docs: Doc[] = candidates.map((e) => {
    const def: ToolDefinition = e.tool.def;
    const schemaText = flattenSchema(def.schema, opts.maxSchemaTextLen);
    const raw = `${def.name} ${def.description ?? ''} ${schemaText}`;
    const tokens = tokenize(raw);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return {
      name: def.name,
      description: def.description ?? '',
      input_schema: def.schema,
      raw,
      tokens,
      len: tokens.length,
      tf,
    };
  });

  const N = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = N === 0 ? 0 : docs.reduce((s, d) => s + d.len, 0) / N;
  const idf = (t: string): number => {
    const n = df.get(t) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  const signature = computeIndexSignature(candidates);

  function bm25(queryTokens: string[], d: Doc): number {
    let score = 0;
    for (const qt of new Set(queryTokens)) {
      const f = d.tf.get(qt) ?? 0;
      if (f === 0) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * d.len) / (avgdl || 1));
      score += idf(qt) * ((f * (BM25_K1 + 1)) / denom);
    }
    return score;
  }

  function search(input: { query?: string; regex?: string; topK: number }): McpSearchHit[] {
    let pool = docs;
    if (input.regex) {
      const re = new RegExp(input.regex, 'i');
      pool = pool.filter((d) => re.test(d.raw));
    }
    let scored: { d: Doc; score: number }[];
    if (input.query && input.query.trim()) {
      const qt = tokenize(input.query);
      scored = pool.map((d) => ({ d, score: bm25(qt, d) })).filter((x) => x.score > 0);
      // `regex` is a hard filter; `query` only ranks within it. When the query
      // adds no BM25 signal but a regex narrowed the pool, still return that pool
      // (flat score) so a narrowing regex never silently yields nothing. With no
      // regex in play, a zero-hit query means no match. Either way `topK` bounds
      // the result, so the fallback cannot flood the context.
      if (scored.length === 0) {
        if (!input.regex) return [];
        scored = pool.map((d) => ({ d, score: 1 }));
      }
    } else {
      scored = pool.map((d) => ({ d, score: 1 }));
    }
    scored.sort((a, b) => b.score - a.score || a.d.name.localeCompare(b.d.name));
    return scored.slice(0, Math.max(0, input.topK)).map(({ d, score }) => ({
      name: d.name,
      description: d.description,
      input_schema: d.input_schema,
      score,
    }));
  }

  return { search, size: N, signature };
}

/**
 * Module-level bounded LRU of built indexes keyed by content signature. The
 * planner rebuilds candidates every deferred turn; caching by signature avoids
 * redundant per-turn BM25 index construction when the configured MCP tool set is
 * unchanged. Insertion-ordered `Map` doubles as the recency list.
 */
const CACHE_MAX = 16;
const indexCache = new Map<string, McpToolIndex>();

export function buildOrReuseIndex(
  candidates: readonly McpToolEntry[],
  opts: { maxSchemaTextLen: number },
): McpToolIndex {
  const sig = computeIndexSignature(candidates);
  const hit = indexCache.get(sig);
  if (hit !== undefined) {
    // Move to most-recent: delete + re-set so iteration order tracks recency.
    indexCache.delete(sig);
    indexCache.set(sig, hit);
    return hit;
  }
  const idx = buildIndex(candidates, opts);
  if (indexCache.size >= CACHE_MAX) {
    const oldest = indexCache.keys().next().value;
    if (oldest !== undefined) indexCache.delete(oldest);
  }
  indexCache.set(sig, idx);
  return idx;
}

/** Test-only: clear the module-level index cache for deterministic tests. */
export function __resetMcpIndexCacheForTest(): void {
  indexCache.clear();
}
