import type { McpRegistryStore } from "./registry.js";
import type { McpRemoteServerConfig, McpServerConfig } from "./client.js";
import { redactSensitive } from "./redaction.js";

export type McpConnectionPlan =
  | {
      kind: "local-stdio-connection";
      server: McpConnectionServerRef;
      command: {
        executable: string;
        args: readonly string[];
        envKeys?: readonly string[];
      };
    }
  | {
      kind: "remote-endpoint";
      server: McpConnectionServerRef;
      endpoint: Pick<McpRemoteServerConfig, "type" | "url" | "protocolVersion">;
    };

export type McpConnectionServerRef = {
  name: string;
  type: "stdio" | "http" | "sse";
};

export type McpConnectionManagerDeps = {
  registry: Pick<McpRegistryStore, "get" | "list">;
};

export function planMcpConnection(input: {
  config: McpServerConfig;
}): McpConnectionPlan {
  const config = input.config;

  if (!("command" in config)) {
    const endpoint = redactSensitive({
      type: config.type,
      url: config.url,
      protocolVersion: config.protocolVersion,
    }) as Pick<McpRemoteServerConfig, "type" | "url" | "protocolVersion">;
    return {
      kind: "remote-endpoint",
      server: { name: config.name, type: config.type },
      endpoint,
    };
  }

  return {
    kind: "local-stdio-connection",
    server: { name: config.name, type: "stdio" },
    command: {
      executable: config.command,
      args: config.args,
      envKeys: config.env ? Object.keys(config.env).sort() : undefined,
    },
  };
}

export class McpConnectionManager {
  constructor(private readonly deps: McpConnectionManagerDeps) {}

  listConnectionPlans(): McpConnectionPlan[] {
    return this.deps.registry.list().map((config) =>
      planMcpConnection({
        config,
      }),
    );
  }

  getConnectionPlan(name: string): McpConnectionPlan | undefined {
    const config = this.deps.registry.get(name);
    if (!config) {
      return undefined;
    }
    return planMcpConnection({
      config,
    });
  }
}
