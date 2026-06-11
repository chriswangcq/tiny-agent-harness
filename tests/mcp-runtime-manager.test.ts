import { describe, expect, it } from "vitest";
import {
  McpRuntimeManager,
  planMcpRuntime,
  type McpServerConfig,
} from "../src/mcp/index.js";

const NOW = "2026-06-11T00:00:00.000Z";

describe("planMcpRuntime", () => {
  it("creates project-owned process records for stdio MCP servers", () => {
    const plan = planMcpRuntime({
      projectId: "project-1",
      now: NOW,
      config: {
        name: "local",
        command: "node",
        args: ["server.js"],
        env: {
          SECRET_TOKEN: "secret",
        },
      },
    });

    expect(plan.kind).toBe("local-process");
    if (plan.kind !== "local-process") throw new Error("expected process");
    expect(plan.process).toMatchObject({
      id: "mcp-server:project-1:local",
      kind: "mcp-server",
      owner: {
        scope: "project",
        projectId: "project-1",
      },
      status: "planned",
      command: {
        executable: "node",
        args: ["server.js"],
        envKeys: ["SECRET_TOKEN"],
      },
      metadata: {
        serverName: "local",
        transport: "stdio",
      },
    });
  });

  it("represents remote MCP servers without a local process", () => {
    const plan = planMcpRuntime({
      projectId: "project-1",
      now: NOW,
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

describe("McpRuntimeManager", () => {
  it("reads project-scoped registry entries through injected ports", () => {
    const servers: McpServerConfig[] = [
      { name: "local", command: "node", args: ["server.js"] },
      { name: "remote", type: "sse", url: "https://api.example.test/sse" },
    ];
    const manager = new McpRuntimeManager({
      projectId: "project-1",
      nowIso: () => NOW,
      registry: {
        list: () => servers,
        get: (name) => servers.find((server) => server.name === name),
      },
    });

    expect(manager.listRuntimePlans().map((plan) => plan.kind)).toEqual([
      "local-process",
      "remote-endpoint",
    ]);
    expect(manager.getRuntimePlan("local")?.kind).toBe("local-process");
    expect(manager.getRuntimePlan("missing")).toBeUndefined();
  });
});
