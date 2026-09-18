import { describe, expect, it } from 'vitest';
import { buildMcpServerRuntimeName, buildMcpToolRuntimeName } from '../src/index.js';
import { normalizeMcpNameSegment } from '../src/runtime/tool-name.js';

describe('hash-free MCP name candidates', () => {
  it.each([
    ['docs', 'search', 'mcp__docs__search'],
    ['github-mcp', 'list-issues', 'mcp__github-mcp__list-issues'],
    ['company.docs', 'search.documents', 'mcp__company_docs__search_documents'],
    ['finance__primary', '_quote_', 'mcp__finance_primary__quote'],
    ['资料库', '搜索', 'mcp__server__tool'],
    ['Docs', 'Search', 'mcp__Docs__Search'],
    ['docs', 'literal_h0123456789abcdef0123', 'mcp__docs__literal_h0123456789abcdef0123'],
  ])('projects %s/%s without a hash', (server, tool, expected) => {
    const name = buildMcpToolRuntimeName(server, tool);
    expect(name).toBe(expected);
    expect(name.split('__')).toHaveLength(3);
    expect(name.startsWith(`${buildMcpServerRuntimeName(server)}__`)).toBe(true);
  });
  it('fits long Tool and Server projections within the existing 80 character boundary', () => {
    expect(buildMcpToolRuntimeName('a', 't'.repeat(72))).toHaveLength(80);
    expect(buildMcpToolRuntimeName('a', 't'.repeat(120))).toBe(`mcp__a__${'t'.repeat(72)}`);
    expect(buildMcpToolRuntimeName('s'.repeat(32), 't'.repeat(48))).toBe(
      `mcp__${'s'.repeat(32)}__${'t'.repeat(41)}`,
    );
    expect(buildMcpToolRuntimeName('s'.repeat(120), 't'.repeat(120))).toBe(
      `mcp__${'s'.repeat(48)}__${'t'.repeat(25)}`,
    );
    expect(normalizeMcpNameSegment('s'.repeat(120), 'server')).toHaveLength(120);
  });
  it('keeps shortened segments nonempty and free of separator edges', () => {
    expect(buildMcpServerRuntimeName(`${'-'.repeat(48)}tail`)).toBe('mcp__server');
    expect(buildMcpToolRuntimeName('s'.repeat(48), `${'-'.repeat(25)}tail`)).toBe(
      `mcp__${'s'.repeat(48)}__tool`,
    );
    expect(buildMcpToolRuntimeName('s'.repeat(48), `${'t'.repeat(24)}_tail`)).toBe(
      `mcp__${'s'.repeat(48)}__${'t'.repeat(24)}`,
    );
  });
  it('rejects control characters', () => {
    expect(() => buildMcpToolRuntimeName('docs', 'read\0')).toThrow('Invalid');
  });
});
