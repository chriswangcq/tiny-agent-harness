import { describe, expect, it } from "vitest";
import {
  McpConnectionManager,
  planMcpConnection,
  type McpServerConfig,
} from "../src/mcp/index.js";

describe("planMcpConnection", () => {
  it("creates non-resident connection plans for stdio MCP servers", () => {
    const plan = planMcpConnection({
      config: {
        name: "local",
        command: "node",
        args: ["server.js"],
        env: {
          SECRET_TOKEN: "secret",
        },
      },
    });

    expect(plan.kind).toBe("local-stdio-connection");
    if (plan.kind !== "local-stdio-connection") {
      throw new Error("expected local stdio connection");
    }
    expect(plan.command).toEqual({
      executable: "node",
      args: ["server.js"],
      envKeys: ["SECRET_TOKEN"],
    });
    expect(JSON.stringify(plan)).not.toContain("secret");
    expect(JSON.stringify(plan)).not.toContain("mcp-server");
  });

  it("represents remote MCP servers without a local process", () => {
    const plan = planMcpConnection({
      config: {
        name: "remote",
        type: "http",
        url: "https://api.example.test/mcp",
        headers: {
          Authorization: "Bearer secret",
        },
        protocolVersion: "2025-03-26",
      },
    });

    expect(plan.kind).toBe("remote-endpoint");
    if (plan.kind !== "remote-endpoint") throw new Error("expected remote");
    expect(plan.endpoint).toEqual({
      type: "http",
      url: "https://api.example.test/mcp",
      protocolVersion: "2025-03-26",
    });
    expect(JSON.stringify(plan)).not.toContain("Bearer secret");
  });
});

describe("McpConnectionManager", () => {
  it("reads project-scoped registry entries through injected ports", () => {
    const servers: McpServerConfig[] = [
      { name: "local", command: "node", args: ["server.js"] },
      { name: "remote", type: "sse", url: "https://api.example.test/sse" },
    ];
    const manager = new McpConnectionManager({
      registry: {
        list: () => servers,
        get: (name) => servers.find((server) => server.name === name),
      },
    });

    expect(manager.listConnectionPlans().map((plan) => plan.kind)).toEqual([
      "local-stdio-connection",
      "remote-endpoint",
    ]);
    expect(manager.getConnectionPlan("local")?.kind).toBe(
      "local-stdio-connection",
    );
    expect(manager.getConnectionPlan("missing")).toBeUndefined();
  });
});
