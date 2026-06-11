import type { McpRegistryStore } from "./registry.js";
import type { McpRemoteServerConfig, McpServerConfig } from "./client.js";
import { redactSensitive } from "./redaction.js";
import {
  createRuntimeProcess,
  type RuntimeProcessRecord,
} from "../runtime/process-registry.js";

export type McpRuntimePlan =
  | {
      kind: "local-process";
      server: McpServerConfig;
      process: RuntimeProcessRecord;
    }
  | {
      kind: "remote-endpoint";
      server: McpServerConfig;
      endpoint: Pick<McpRemoteServerConfig, "type" | "url" | "protocolVersion">;
    };

export type McpRuntimeManagerDeps = {
  registry: Pick<McpRegistryStore, "get" | "list">;
  projectId: string;
  nowIso: () => string;
};

export function mcpServerProcessId(projectId: string, serverName: string): string {
  return `mcp-server:${projectId}:${serverName}`;
}

export function planMcpRuntime(input: {
  config: McpServerConfig;
  projectId: string;
  now: string;
}): McpRuntimePlan {
  const config = redactSensitive(input.config) as McpServerConfig;

  if (!("command" in config)) {
    return {
      kind: "remote-endpoint",
      server: config,
      endpoint: {
        type: config.type,
        url: config.url,
        protocolVersion: config.protocolVersion,
      },
    };
  }

  return {
    kind: "local-process",
    server: config,
    process: createRuntimeProcess({
      id: mcpServerProcessId(input.projectId, config.name),
      kind: "mcp-server",
      owner: {
        scope: "project",
        projectId: input.projectId,
      },
      command: {
        executable: config.command,
        args: config.args,
        envKeys: config.env ? Object.keys(config.env).sort() : undefined,
      },
      now: input.now,
      metadata: {
        serverName: config.name,
        transport: "stdio",
      },
    }),
  };
}

export class McpRuntimeManager {
  constructor(private readonly deps: McpRuntimeManagerDeps) {}

  listRuntimePlans(): McpRuntimePlan[] {
    return this.deps.registry.list().map((config) =>
      planMcpRuntime({
        config,
        projectId: this.deps.projectId,
        now: this.deps.nowIso(),
      }),
    );
  }

  getRuntimePlan(name: string): McpRuntimePlan | undefined {
    const config = this.deps.registry.get(name);
    if (!config) {
      return undefined;
    }
    return planMcpRuntime({
      config,
      projectId: this.deps.projectId,
      now: this.deps.nowIso(),
    });
  }
}
