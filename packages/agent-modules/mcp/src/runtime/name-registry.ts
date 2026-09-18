import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { lockSync } from 'proper-lockfile';
import {
  MCP_RUNTIME_SERVER_SEGMENT_MAX_LENGTH,
  MCP_RUNTIME_TOOL_NAME_MAX_LENGTH,
  normalizeMcpNameSegment,
  shortenMcpNameSegment,
} from './tool-name.js';

interface ToolAssignment {
  raw: string;
  segment: string;
}
interface ServerAssignment {
  key: string;
  raw: string;
  segment: string;
  tools: ToolAssignment[];
}
interface State {
  version: 1;
  servers: ServerAssignment[];
}
export interface McpNameCandidate {
  readonly key: string;
  readonly name: string;
}
export interface McpNameAssignments {
  readonly names: ReadonlyMap<string, string>;
  readonly errors: ReadonlyMap<string, string>;
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const validSegment = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/u.test(value) &&
  /[A-Za-z0-9]/u.test(value);

/**
 * Host-scoped, two-level allocation. Never derives identity from a public name.
 * Removed identities retain their assignments so a new source cannot inherit a name.
 * Disk-backed instances refresh inside an exclusive transaction before allocating.
 */
export class McpNameRegistry {
  private state: State = { version: 1, servers: [] };
  constructor(private readonly filePath?: string) {}

  assignServers(candidates: readonly McpNameCandidate[]): McpNameAssignments {
    return this.transaction(() => {
      const existing = new Map(this.state.servers.map((entry) => [entry.key, entry]));
      const result = allocate(
        candidates,
        new Map(this.state.servers.map((entry) => [entry.key, entry.segment])),
        'server',
        MCP_RUNTIME_SERVER_SEGMENT_MAX_LENGTH,
      );
      for (const candidate of candidates) {
        const segment = result.names.get(candidate.key);
        if (segment && !existing.has(candidate.key)) {
          const entry = { key: candidate.key, raw: candidate.name, segment, tools: [] };
          this.state.servers.push(entry);
          existing.set(entry.key, entry);
        }
      }
      return result;
    });
  }

  assignTools(serverKey: string, rawNames: readonly string[]): McpNameAssignments {
    return this.transaction(() => {
      const server = this.state.servers.find((entry) => entry.key === serverKey);
      if (!server) throw new Error('MCP server name has not been allocated');
      const result = allocate(
        rawNames.map((name) => ({ key: name, name })),
        new Map(server.tools.map((entry) => [entry.raw, entry.segment])),
        'tool',
        MCP_RUNTIME_TOOL_NAME_MAX_LENGTH - 7 - server.segment.length,
      );
      const existing = new Set(server.tools.map((entry) => entry.raw));
      for (const raw of rawNames) {
        const segment = result.names.get(raw);
        if (segment && !existing.has(raw)) {
          server.tools.push({ raw, segment });
          existing.add(raw);
        }
      }
      return {
        names: new Map(
          [...result.names].map(([raw, segment]) => [raw, `mcp__${server.segment}__${segment}`]),
        ),
        errors: result.errors,
      };
    });
  }

  private transaction<T>(run: () => T): T {
    const path = this.filePath;
    if (!path) return run();
    mkdirSync(dirname(path), { recursive: true });
    const release = lockSync(path, { realpath: false, retries: 0 });
    let temporaryDirectory: string | undefined;
    try {
      this.state = existsSync(path)
        ? parseState(readFileSync(path, 'utf8'))
        : { version: 1, servers: [] };
      const before = JSON.stringify(this.state);
      const result = run();
      const after = JSON.stringify(this.state);
      if (before !== after) {
        temporaryDirectory = mkdtempSync(`${path}.tmp-`);
        const temp = join(temporaryDirectory, 'state.json');
        const output = openSync(temp, 'wx', 0o600);
        try {
          writeFileSync(output, `${after}\n`);
          fsyncSync(output);
        } finally {
          closeSync(output);
        }
        renameSync(temp, path);
      }
      return result;
    } finally {
      try {
        if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
      } finally {
        release();
      }
    }
  }
}

function allocate(
  candidates: readonly McpNameCandidate[],
  existing: ReadonlyMap<string, string>,
  kind: 'server' | 'tool',
  max: number,
): McpNameAssignments {
  const names = new Map<string, string>();
  const errors = new Map<string, string>();
  const used = new Set(existing.values());
  const pending: Array<{ key: string; base: string; natural: boolean }> = [];
  for (const { key, name } of [
    ...new Map(candidates.map((entry) => [entry.key, entry])).values(),
  ].sort((a, b) => compare(a.key, b.key))) {
    const saved = existing.get(key);
    if (saved) {
      names.set(key, saved);
      continue;
    }
    try {
      const base = shortenMcpNameSegment(normalizeMcpNameSegment(name, kind), max, kind);
      pending.push({ key, base, natural: base === name });
    } catch (error) {
      errors.set(key, error instanceof Error ? error.message : 'Invalid MCP name');
    }
  }
  pending.sort(
    (a, b) =>
      Number(b.natural) - Number(a.natural) ||
      sourcePriority(a.key) - sourcePriority(b.key) ||
      compare(a.key, b.key),
  );
  const conflicts: typeof pending = [];
  for (const entry of pending) {
    if (used.has(entry.base)) conflicts.push(entry);
    else {
      used.add(entry.base);
      names.set(entry.key, entry.base);
    }
  }
  for (const { key, base } of conflicts) {
    for (let number = 2; ; number++) {
      const suffix = `_${number}`;
      if (suffix.length >= max) {
        errors.set(key, `MCP ${kind} name has no room for a collision suffix`);
        break;
      }
      const candidate = `${shortenMcpNameSegment(base, max - suffix.length, kind)}${suffix}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        names.set(key, candidate);
        break;
      }
    }
  }
  return { names, errors };
}

function parseState(json: string): State {
  const state = JSON.parse(json) as State;
  if (state?.version !== 1 || !Array.isArray(state.servers))
    throw new Error('Invalid MCP name registry');
  const keys = new Set<string>();
  const servers = new Set<string>();
  for (const entry of state.servers) {
    if (
      !entry ||
      typeof entry.key !== 'string' ||
      typeof entry.raw !== 'string' ||
      !validSegment(entry.segment) ||
      entry.segment.length > MCP_RUNTIME_SERVER_SEGMENT_MAX_LENGTH ||
      !Array.isArray(entry.tools) ||
      keys.has(entry.key) ||
      servers.has(entry.segment)
    )
      throw new Error('Invalid MCP server assignment');
    keys.add(entry.key);
    servers.add(entry.segment);
    const tools = new Set<string>();
    const raw = new Set<string>();
    for (const tool of entry.tools) {
      if (
        !tool ||
        typeof tool.raw !== 'string' ||
        !validSegment(tool.segment) ||
        tool.segment.length + entry.segment.length + 7 > MCP_RUNTIME_TOOL_NAME_MAX_LENGTH ||
        raw.has(tool.raw) ||
        tools.has(tool.segment)
      )
        throw new Error('Invalid MCP tool assignment');
      raw.add(tool.raw);
      tools.add(tool.segment);
    }
  }
  return state;
}

export function configuredMcpNameKey(server: string): string {
  return JSON.stringify(['configured', server]);
}
export function pluginMcpNameKey(source: string, plugin: string, server: string): string {
  return JSON.stringify(['plugin', source, plugin, server]);
}

// Preserve the previous configured > official > local ownership on a fresh registry.
function sourcePriority(key: string): number {
  try {
    const identity: unknown = JSON.parse(key);
    if (Array.isArray(identity)) {
      if (identity[0] === 'configured') return 0;
      if (identity[0] === 'plugin' && identity[1] === 'OFFICIAL') return 1;
    }
  } catch {
    /* Tool keys are original names, not structured server identities. */
  }
  return 2;
}
