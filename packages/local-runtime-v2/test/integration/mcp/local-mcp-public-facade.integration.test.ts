import { describe, expect, it } from "vitest";

import { LocalMcpPublicFacade } from "../../../src/service/mcp/tools/public-facade.js";

describe("LocalMcpPublicFacade", () => {
  it("filters by name and serializes only the public status projection", async () => {
    const facade = new LocalMcpPublicFacade({
      inspectProjectMcp: async () => ({
        path: "/repo/.mcp.json",
        digest: "test",
        servers: [],
      }),
      getSessionMcpServers: () => undefined,
      configureSessionServers: async () => undefined,
      clearSessionServers: async () => undefined,
      listBuiltinPublicServerCapabilities: async () => [],
      listPublicServerStatuses: async () => [
        {
          name: "Search Tools",
          enabled: true,
          transport: "stdio",
          description: "Search automation",
          status: "available" as const,
          available: true,
        },
        {
          name: "database",
          enabled: true,
          transport: "http",
          status: "error" as const,
          available: false,
          error:
            "MCP server connection failed. Retry or check its configuration.",
        },
      ],
    });

    const result = await facade.listLocalMcpServers({ keyword: "SEARCH" });

    expect(result.servers).toEqual([
      {
        name: "Search Tools",
        enabled: true,
        transport: "stdio",
        description: "Search automation",
        configJson: '{"status":"available","available":true}',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /command|url|env|header|token|credential/iu,
    );
  });

  it("returns a source-aware capability catalog and filters Builtin tools without exposing config", async () => {
    const facade = new LocalMcpPublicFacade({
      inspectProjectMcp: async () => ({
        path: "/repo/.mcp.json",
        digest: "test",
        servers: [],
      }),
      getSessionMcpServers: () => undefined,
      configureSessionServers: async () => undefined,
      clearSessionServers: async () => undefined,
      listPublicServerStatuses: async () => [
        {
          name: "database",
          enabled: true,
          transport: "stdio",
          status: "available" as const,
          available: true,
        },
      ],
      listBuiltinPublicServerCapabilities: async () => [
        {
          name: "matrix",
          sourceKind: "builtin" as const,
          managed: true,
          enabled: false,
          transport: "stdio" as const,
          description: "Built-in Matrix tools",
          status: "unavailable" as const,
          available: false,
          error: "Built-in MCP server is not active in this Runtime.",
          tools: [
            { name: "web_search", description: "Search the web" },
            { name: "image_synthesize", description: "Create an image" },
          ],
        },
      ],
    });

    const result = await facade.listMcpCapabilities({ keyword: "image" });

    expect(result.servers).toEqual([
      {
        name: "matrix",
        sourceKind: "builtin",
        managed: true,
        enabled: false,
        transport: "stdio",
        description: "Built-in Matrix tools",
        status: "unavailable",
        available: false,
        error: "Built-in MCP server is not active in this Runtime.",
        tools: [{ name: "image_synthesize", description: "Create an image" }],
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /command|url|env|header|token|credential/iu,
    );
  });
});
