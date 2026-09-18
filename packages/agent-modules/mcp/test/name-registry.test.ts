import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockSync } from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import { McpNameRegistry, configuredMcpNameKey, pluginMcpNameKey } from '../src/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const configured = (name: string) => ({ key: configuredMcpNameKey(name), name });
const plugin = (name: string, server: string) => ({ key: pluginMcpNameKey('OFFICIAL', name, server), name: server });
function disk() { const root = mkdtempSync(join(tmpdir(), 'mcp-names-')); roots.push(root); return join(root, 'names.json'); }

describe('McpNameRegistry', () => {
  it('reserves natural suffixes and preserves already legal names', () => {
    const registry = new McpNameRegistry();
    const a = configured('docs.server'); const b = configured('docs_server'); const c = configured('docs_server_2');
    const result = registry.assignServers([a,b,c]);
    expect(result.names.get(b.key)).toBe('docs_server');
    expect(result.names.get(c.key)).toBe('docs_server_2');
    expect(result.names.get(a.key)).toBe('docs_server_3');
  });
  it('allocates tool collisions independently in each server and preserves raw names', () => {
    const registry = new McpNameRegistry(); const a=plugin('alpha','docs'); const b=plugin('beta','docs');
    registry.assignServers([a,b]);
    const tools = registry.assignTools(a.key,['get.user','get_user','get_user_2']);
    expect([...tools.names]).toContainEqual(['get.user','mcp__docs__get_user_3']);
    expect([...tools.names]).toContainEqual(['get_user','mcp__docs__get_user']);
    expect(registry.assignTools(b.key,['get_user']).names.get('get_user')).toBe('mcp__docs_2__get_user');
  });
  it('preserves configured, official, then local ownership on first allocation', () => {
    const registry = new McpNameRegistry();
    const local = {key: pluginMcpNameKey('LOCAL_MINIMAX', 'a', 'docs'), name: 'docs'};
    const official = plugin('z', 'docs');
    const config = configured('docs');
    const names = registry.assignServers([local, official, config]).names;
    expect(names.get(config.key)).toBe('docs');
    expect(names.get(official.key)).toBe('docs_2');
    expect(names.get(local.key)).toBe('docs_3');
  });
  it('gives an unchanged name priority over a lossy name from a higher-priority source', () => {
    const registry = new McpNameRegistry();
    const config = configured('docs.server');
    const local = { key: pluginMcpNameKey('LOCAL_MINIMAX', 'docs', 'docs_server'), name: 'docs_server' };
    const names = registry.assignServers([config, local]).names;
    expect(names.get(local.key)).toBe('docs_server');
    expect(names.get(config.key)).toBe('docs_server_2');
  });
  it('preserves case-sensitive Server and Tool identities across restart', () => {
    const path = disk();
    const upper = configured('Docs'); const lower = configured('docs');
    const registry = new McpNameRegistry(path);
    const servers = registry.assignServers([lower, upper]).names;
    expect(servers.get(upper.key)).toBe('Docs');
    expect(servers.get(lower.key)).toBe('docs');
    const tools = registry.assignTools(lower.key, ['search', 'Search']).names;
    expect(tools.get('search')).toBe('mcp__docs__search');
    expect(tools.get('Search')).toBe('mcp__docs__Search');
    const restarted = new McpNameRegistry(path);
    expect([...restarted.assignServers([upper, lower]).names].sort()).toEqual([...servers].sort());
    expect([...restarted.assignTools(lower.key, ['Search', 'search']).names].sort()).toEqual([...tools].sort());
  });
  it('does not depend on input order' , () => {
    const candidates = [plugin('beta','docs'),configured('docs'),plugin('alpha','docs'),configured('docs_2')];
    const one = new McpNameRegistry(); const two = new McpNameRegistry();
    const a = one.assignServers(candidates); const b=two.assignServers([...candidates].reverse());
    expect([...a.names].sort()).toEqual([...b.names].sort());
    const names=['search.docs','search_docs','search__docs','Search_Docs','search_docs_2'];
    expect([...one.assignTools(candidates[0]!.key,names).names].sort()).toEqual([...two.assignTools(candidates[0]!.key,[...names].reverse()).names].sort());
  });
  it('retains server and tool numbers across restart, removal and new natural names', () => {
    const path=disk(); const a=plugin('alpha','docs'); const b=plugin('beta','docs');
    const one=new McpNameRegistry(path); one.assignServers([a,b]);
    one.assignTools(a.key,['search']); one.assignTools(a.key,['search.docs','search_docs']);
    const two=new McpNameRegistry(path); const c=configured('docs_2');
    expect(two.assignServers([b,c]).names.get(c.key)).toBe('docs_2_2');
    expect(two.assignTools(a.key,['search.docs']).names.get('search.docs')).toBe('mcp__docs__search_docs_2');
    expect(two.assignTools(a.key,['search']).names.get('search')).toBe('mcp__docs__search');
    expect(readFileSync(path,'utf8')).not.toContain('_h');
  });
  it('refreshes disk assignments before a second instance writes', () => {
    const path=disk(); const one=new McpNameRegistry(path); const two=new McpNameRegistry(path);
    const a=plugin('alpha','docs'); const b=plugin('beta','docs');
    one.assignServers([a]); two.assignServers([b]);
    expect(one.assignServers([b]).names.get(b.key)).toBe('docs_2');
  });
  it('fails closed on corrupt storage instead of reallocating', () => {
    const path=disk(); writeFileSync(path,'{"version":99,"servers":[]}');
    expect(()=>new McpNameRegistry(path).assignServers([configured('docs')])).toThrow('Invalid');
    expect(readFileSync(path,'utf8')).toContain('99');
  });
  it('does not displace a live writer', () => {
    const path=disk(); const release = lockSync(path, { realpath: false });
    try {
      expect(()=>new McpNameRegistry(path).assignServers([configured('docs')])).toThrow(expect.objectContaining({ code: 'ELOCKED' }));
    } finally { release(); }
    expect(new McpNameRegistry(path).assignServers([configured('docs')]).names.size).toBe(1);
  });
  it('recovers a stale lock left by an exited writer without losing assignments', () => {
    const path = disk();
    const a = plugin('alpha', 'docs'); const b = plugin('beta', 'docs');
    new McpNameRegistry(path).assignServers([a]);
    mkdirSync(`${path}.lock`);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, stale, stale);

    expect(new McpNameRegistry(path).assignServers([a, b]).names.get(b.key)).toBe('docs_2');
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(new McpNameRegistry(path).assignServers([a]).names.get(a.key)).toBe('docs');
  });
  it('rejects an overlapping process writer and refreshes its committed assignments after release', async () => {
    const path = disk();
    const registry = new McpNameRegistry(path);
    const a = plugin('alpha', 'docs'); const b = plugin('beta', 'docs');
    // Populate this instance before the other process adds an assignment.
    registry.assignServers([]);
    const moduleUrl = new URL('../src/runtime/name-registry.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { lockSync } from 'proper-lockfile';
      import { McpNameRegistry } from ${JSON.stringify(moduleUrl)};
      new McpNameRegistry(${JSON.stringify(path)}).assignServers(${JSON.stringify([a])});
      const release = lockSync(${JSON.stringify(path)}, { realpath: false });
      process.send('locked');
      process.once('message', () => { release(); process.disconnect(); });
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    try {
      const ready = await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error(`Registry writer exited before acquiring lock: ${stderr}`); }),
      ]);
      expect(ready[0]).toBe('locked');
      expect(() => registry.assignServers([b])).toThrow(expect.objectContaining({ code: 'ELOCKED' }));
      expect(JSON.parse(readFileSync(path, 'utf8')).servers).toHaveLength(1);
    } finally {
      if (child.connected) child.send('release');
      else child.kill();
      expect((await exited)[0]).toBe(0);
    }
    expect(registry.assignServers([b]).names.get(b.key)).toBe('docs_2');
    expect(new McpNameRegistry(path).assignServers([a, b]).names.size).toBe(2);
  });
  it('shortens both levels without changing raw identities or assignments after restart', () => {
    const path = disk();
    const registry = new McpNameRegistry(path);
    const serverPrefix = 's'.repeat(48); const toolPrefix = 't'.repeat(25);
    const a = configured(`${serverPrefix}-alpha-long-server`);
    const b = plugin('beta', `${serverPrefix}-beta-long-server`);
    const rawTools = [`${toolPrefix}-first-long-tool`, `${toolPrefix}-second-long-tool`];
    const servers = registry.assignServers([b, a]);
    expect(servers.errors.size).toBe(0);
    expect(servers.names.get(a.key)).toBe(serverPrefix);
    expect(servers.names.get(b.key)).toBe(`${'s'.repeat(46)}_2`);
    const first = registry.assignTools(a.key, rawTools);
    const second = registry.assignTools(b.key, rawTools);
    expect(first.errors.size + second.errors.size).toBe(0);
    const publicNames = [...first.names.values(), ...second.names.values()];
    expect(new Set(publicNames).size).toBe(4);
    for (const name of publicNames) {
      expect(name).toHaveLength(80);
      expect(name.split('__')).toHaveLength(3);
    }
    expect(first.names.get(rawTools[1]!)).toBe(`mcp__${serverPrefix}__${'t'.repeat(23)}_2`);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.servers.find((entry: { key: string }) => entry.key === a.key).raw).toBe(a.name);
    expect(saved.servers.find((entry: { key: string }) => entry.key === a.key).tools.map((entry: { raw: string }) => entry.raw)).toEqual(rawTools);
    const restarted = new McpNameRegistry(path);
    expect([...restarted.assignServers([a, b]).names].sort()).toEqual([...servers.names].sort());
    expect([...restarted.assignTools(a.key, [...rawTools].reverse()).names].sort()).toEqual([...first.names].sort());
    expect([...restarted.assignTools(b.key, rawTools).names].sort()).toEqual([...second.names].sort());
  });
  it('reserves natural long suffixes before numbering shortened collisions', () => {
    const registry = new McpNameRegistry();
    const prefix = 's'.repeat(48); const natural = configured(prefix); const suffix = configured(`${'s'.repeat(46)}_2`);
    const long = configured(`${prefix}-long`);
    const names = registry.assignServers([long, suffix, natural]).names;
    expect(names.get(natural.key)).toBe(prefix);
    expect(names.get(suffix.key)).toBe(suffix.name);
    expect(names.get(long.key)).toBe(`${'s'.repeat(46)}_3`);
    const toolPrefix = 't'.repeat(25); const toolSuffix = `${'t'.repeat(23)}_2`;
    const toolA = `${toolPrefix}-alpha`; const toolB = `${toolPrefix}-beta`;
    const tools = registry.assignTools(natural.key, [toolA, toolB, toolSuffix]).names;
    expect(tools.get(toolSuffix)).toBe(`mcp__${prefix}__${toolSuffix}`);
    expect(tools.get(toolA)).toBe(`mcp__${prefix}__${toolPrefix}`);
    expect(tools.get(toolB)).toBe(`mcp__${prefix}__${'t'.repeat(23)}_3`);
  });
  it('reserves another prefix character when numbering grows from nine to ten', () => {
    const registry = new McpNameRegistry();
    const candidates = Array.from({ length: 12 }, (_, index) => configured(`${'s'.repeat(48)}-${String(index).padStart(2, '0')}`));
    const servers = registry.assignServers(candidates);
    expect(servers.errors.size).toBe(0);
    expect(servers.names.get(candidates[8]!.key)).toBe(`${'s'.repeat(46)}_9`);
    expect(servers.names.get(candidates[9]!.key)).toBe(`${'s'.repeat(45)}_10`);
    const rawTools = Array.from({ length: 12 }, (_, index) => `${'t'.repeat(25)}-${String(index).padStart(2, '0')}`);
    const tools = registry.assignTools(candidates[0]!.key, rawTools);
    expect(tools.errors.size).toBe(0);
    expect(tools.names.get(rawTools[8]!)).toBe(`mcp__${'s'.repeat(48)}__${'t'.repeat(23)}_9`);
    expect(tools.names.get(rawTools[9]!)).toBe(`mcp__${'s'.repeat(48)}__${'t'.repeat(22)}_10`);
    expect(new Set(tools.names.values()).size).toBe(rawTools.length);
    for (const name of tools.names.values()) expect(name).toHaveLength(80);
  });
  it('checks fallback prefixes against natural names after shortening for a suffix', () => {
    const registry = new McpNameRegistry();
    const server = configured('s'.repeat(48));
    registry.assignServers([server]);
    const prefix = `${'-'.repeat(24)}a`;
    const tools = registry.assignTools(server.key, [`${prefix}-alpha`, `${prefix}-beta`, 'tool_2']);
    expect(tools.errors.size).toBe(0);
    expect(tools.names.get(`${prefix}-alpha`)).toBe(`mcp__${server.name}__${prefix}`);
    expect(tools.names.get(`${prefix}-beta`)).toBe(`mcp__${server.name}__tool_3`);
    expect(tools.names.get('tool_2')).toBe(`mcp__${server.name}__tool_2`);
  });
});
