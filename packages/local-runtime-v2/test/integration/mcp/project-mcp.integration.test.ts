import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { McpConnectionPool } from "@mavis/mcp/runtime/connection-pool";
import { LocalMcpService } from "../../../src/service/mcp/index.js";
import { LocalMcpPublicFacade } from "../../../src/service/mcp/tools/public-facade.js";

const roots: string[] = [];
const services: LocalMcpService[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const fixture = `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync('started', 'yes');
// Windows locks a live process cwd. Keep the transport open without holding the disappearing directory.
if (process.env.PROJECT_MCP_TEST === 'release-cwd') process.chdir(require('node:os').tmpdir());
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let callId;
readline.createInterface({input: process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (request.method === 'initialize') send({jsonrpc:'2.0', id:request.id, result:{protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'fixture',version:'1'}}});
 if (request.method === 'tools/list') send({jsonrpc:'2.0',id:request.id,result:{tools:[{name:'where',inputSchema:{type:'object'}}]}});
 if (request.method === 'tools/call' && request.params.arguments.hold) { fs.writeFileSync('called', 'yes'); return; }
 if (request.method === 'tools/call') { callId = request.id; send({jsonrpc:'2.0',id:'roots',method:'roots/list'}); }
 if (request.id === 'roots' && request.result) send({jsonrpc:'2.0',id:callId,result:{content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),root:request.result.roots[0].uri,env:process.env.PROJECT_MCP_TEST})}]}});
});
`;
async function setup() {
  const data = await realpath(
    await mkdtemp(join(tmpdir(), "project-mcp-live-")),
  );
  roots.push(data);
  const a = join(data, "a");
  const b = join(data, "b");
  await mkdir(a);
  await mkdir(b);
  for (const root of [a, b]) await writeFile(join(root, "server.cjs"), fixture);
  let service: LocalMcpService;
  const pool = new McpConnectionPool({
    getResolvedServer: (name) =>
      service.getServerLookup().getResolvedServer(name),
  });
  service = new LocalMcpService(() => data, { connectionPool: pool });
  services.push(service);
  return { data, a, b, service };
}
async function configure(root: string, env = "one") {
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        repo: {
          command: process.execPath,
          args: ["./server.cjs"],
          env: { PROJECT_MCP_TEST: env },
        },
      },
    }),
  );
}
it("loads automatically at first discovery with project cwd, roots and isolated connections", async () => {
  const { a, b, service } = await setup();
  await configure(a, "a");
  await configure(b, "b");
  const ca = { sessionId: "a", workspaceRoot: a };
  const cb = { sessionId: "b", workspaceRoot: b };
  await expect(access(join(a, "started"))).rejects.toThrow();
  expect((await service.inspectProjectMcp(ca))?.servers[0]?.status).toBe(
    "configured",
  );
  await expect(access(join(a, "started"))).rejects.toThrow();
  expect(await service.listNativeToolsForTurn(ca)).toHaveLength(1);
  const [ra, rb] = await Promise.all([
    service.call("repo", "where", {}, { context: ca }),
    service.call("repo", "where", {}, { context: cb }),
  ]);
  expect(ra.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({ cwd: a, root: pathToFileURL(a).href, env: "a" }),
    },
  ]);
  expect(rb.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({ cwd: b, root: pathToFileURL(b).href, env: "b" }),
    },
  ]);
  expect((await service.inspectProjectMcp(ca))?.servers[0]?.status).toBe(
    "available",
  );
});

it("shadows profile entries, survives ACP clear, and reloads automatically on edit or deletion", async () => {
  const { data, a, service } = await setup();
  await configure(a);
  const profile = JSON.stringify({
    mcpServers: { repo: { command: "should-never-start" } },
  });
  await writeFile(join(data, "mcp.json"), profile);
  const context = { sessionId: "one", workspaceRoot: a };
  expect((await service.getServerConfig("repo", context))?.command).toBe(
    process.execPath,
  );
  await service.configureSessionServers("one", [
    { name: "repo", config: { command: "client-wins" } },
  ]);
  expect((await service.getServerConfig("repo", context))?.command).toBe(
    "client-wins",
  );
  await service.clearSessionServers("one");
  expect(
    (await service.call("repo", "where", {}, { context })).isError,
  ).not.toBe(true);
  const facade = new LocalMcpPublicFacade(service);
  expect(
    (await facade.listMcpCapabilities({ context })).servers.filter(
      (server) => server.name === "repo",
    ),
  ).toMatchObject([{ sourceScope: "project", status: "available" }]);
  await configure(a, "changed");
  expect((await service.inspectProjectMcp(context))?.servers[0]?.status).toBe(
    "configured",
  );
  expect(
    (await service.call("repo", "where", {}, { context })).content,
  ).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        cwd: a,
        root: pathToFileURL(a).href,
        env: "changed",
      }),
    },
  ]);
  expect(await readFile(join(data, "mcp.json"), "utf8")).toBe(profile);
  await rm(join(a, ".mcp.json"));
  expect((await service.getServerConfig("repo", context))?.command).toBe(
    "should-never-start",
  );
});

it("invalidates malformed files without retaining the old executable", async () => {
  const { a, service } = await setup();
  await configure(a);
  const context = { sessionId: "one", workspaceRoot: a };
  expect(await service.listNativeToolsForTurn(context)).toHaveLength(1);
  await writeFile(join(a, ".mcp.json"), "{bad json");
  expect(await service.listNativeToolsForTurn(context)).toEqual([]);
  expect((await service.inspectProjectMcp(context))?.error).toContain(
    "Cannot read",
  );
});

it("uses HTTP headers on a real loopback server and does not expose them in inspection", async () => {
  const { a, service } = await setup();
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    seen.push(String(req.headers.authorization));
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body.id && body.id !== 0) {
      res.writeHead(202).end();
      return;
    }
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "http-fixture", version: "1" },
          }
        : { tools: [{ name: "remote", inputSchema: { type: "object" } }] };
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected port.");
    await writeFile(
      join(a, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: `http://127.0.0.1:${address.port}/mcp?token=hidden`,
            headers: { Authorization: "Bearer private-token" },
          },
        },
      }),
    );
    const context = { sessionId: "http", workspaceRoot: a };
    expect(
      JSON.stringify(await service.inspectProjectMcp(context)),
    ).not.toMatch(/private-token|token=hidden/);
    expect(seen).toEqual([]);
    expect(await service.listNativeToolsForTurn(context)).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === "Bearer private-token")).toBe(true);
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("aborts an old project call on reload without marking the replacement as available", async () => {
  const { a, service } = await setup();
  await configure(a);
  const context = { sessionId: "one", workspaceRoot: a };
  const calling = service.call("repo", "where", { hold: true }, { context });
  // Real subprocess startup under CI coverage can exceed Vitest's default one second.
  await vi.waitFor(
    async () => {
      expect(await readFile(join(a, "called"), "utf8")).toBe("yes");
    },
    { timeout: 10_000 },
  );
  await configure(a, "replacement");
  await service.inspectProjectMcp(context);
  expect((await calling).isError).toBe(true);
  expect((await service.inspectProjectMcp(context))?.servers[0]?.status).toBe(
    "configured",
  );
  expect(
    (await service.call("repo", "where", {}, { context })).content,
  ).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        cwd: a,
        root: pathToFileURL(a).href,
        env: "replacement",
      }),
    },
  ]);
});

it("keeps built-in reserved names intact even when the project declares them", async () => {
  const { data, a } = await setup();
  // This case inspects reserved-name configuration without starting Matrix.
  // Use the local fixture instead of requiring an unrelated package dist build.
  vi.stubEnv("MAVIS_MATRIX_MCP_STDIO_ENTRYPOINT", join(a, "server.cjs"));
  const service = new LocalMcpService(() => data, {
    builtinMatrix: { enabled: true },
    connectionPool: new McpConnectionPool({ getResolvedServer: () => null }),
  });
  services.push(service);
  await writeFile(
    join(a, ".mcp.json"),
    JSON.stringify({ mcpServers: { matrix: { command: "malicious" } } }),
  );
  const context = { sessionId: "reserved", workspaceRoot: a };
  expect((await service.inspectProjectMcp(context))?.servers[0]?.status).toBe(
    "error",
  );
  expect((await service.getServerConfig("matrix", context))?.builtin).toBe(
    true,
  );
});

it("keeps disabled and invalid project entries from executing or falling back to profile", async () => {
  const { data, a, service } = await setup();
  await writeFile(
    join(data, "mcp.json"),
    JSON.stringify({ mcpServers: { repo: { command: "profile" } } }),
  );
  const context = { sessionId: "disabled", workspaceRoot: a };
  for (const config of [
    { command: process.execPath, args: ["./server.cjs"], enabled: false },
    { type: "invalid" },
  ]) {
    await writeFile(
      join(a, ".mcp.json"),
      JSON.stringify({ mcpServers: { repo: config } }),
    );
    expect(await service.listNativeToolsForTurn(context)).toEqual([]);
    expect((await service.getServerConfig("repo", context))?.enabled).toBe(
      false,
    );
    await expect(access(join(a, "started"))).rejects.toThrow();
  }
});

it("keeps profile tools available when a workspace disappears and releases old project connections", async () => {
  const { data, a, service } = await setup();
  await configure(a, "release-cwd");
  const context = { sessionId: "deleted", workspaceRoot: a };
  expect(await service.listNativeToolsForTurn(context)).toHaveLength(1);
  await writeFile(
    join(data, "mcp.json"),
    JSON.stringify({ mcpServers: { fallback: { command: "profile" } } }),
  );
  await rm(a, { recursive: true, force: true });
  expect(await service.getServerConfig("repo", context)).toBeUndefined();
  expect((await service.getServerConfig("fallback", context))?.command).toBe(
    "profile",
  );
});

it("disposes project calls and ACP configuration together for a deleted session", async () => {
  const { a, service } = await setup();
  await configure(a);
  const context = { sessionId: "deleted", workspaceRoot: a };
  await service.configureSessionServers("deleted", [
    { name: "client-only", config: { command: "unused" } },
  ]);
  const calling = service.call("repo", "where", { hold: true }, { context });
  // Real subprocess startup under CI coverage can exceed Vitest's default one second.
  await vi.waitFor(
    async () => {
      expect(await readFile(join(a, "called"), "utf8")).toBe("yes");
    },
    { timeout: 10_000 },
  );
  await service.disposeSession("deleted");
  expect((await calling).isError).toBe(true);
  expect(service.getSessionMcpServers("deleted")).toBeUndefined();
  expect((await service.inspectProjectMcp(context)).servers[0]?.status).toBe(
    "configured",
  );
});
