import * as path from "node:path";
import { McpJsonRpcClient, type McpServerConfig } from "./client.js";
import { ProcessMcpTransport } from "./process-transport.js";
import { McpRegistryStore } from "./registry.js";

function die(message: string): never {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
}

function output(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    const obj = data as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      process.stdout.write(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}\n`);
    }
  }
}

function resolveStateDir(): string {
  return process.env.TAH_STATE_DIR ?? path.resolve(".tiny-agent");
}

function parseJsonFlag(argv: string[]): { jsonMode: boolean; remaining: string[] } {
  const jsonMode = argv.includes("--json");
  return { jsonMode, remaining: argv.filter(a => a !== "--json") };
}

export async function runMcpCli(argv: string[]): Promise<number> {
  const { jsonMode, remaining } = parseJsonFlag(argv);
  const cmd = remaining[0];

  if (!cmd || cmd === "--help") {
    process.stdout.write(`Usage: mcp <command> [--json]

Commands:
  add <name> <command> [args...] [--json]    Register an MCP server
  remove <name> [--json]                     Remove an MCP server
  list [--json]                              List registered servers
  tools <server> [--json]                    List tools from a server
  call <server> <tool> [--json] [--json '<args>']  Call a tool
`);
    return 0;
  }

  const stateDir = resolveStateDir();
  const registryPath = path.join(stateDir, "mcp-servers.json");
  const registry = new McpRegistryStore(registryPath, stateDir);

  switch (cmd) {
    case "add": {
      const name = remaining[1];
      const command = remaining[2];
      if (!name || !command) {
        die("Usage: mcp add <name> <command> [args...]");
      }
      // args after <name> <command>, excluding --json
      const args = remaining.slice(3).filter(a => a !== "--json");
      await registry.add({ name, command, args });
      output({ ok: true, name }, jsonMode);
      break;
    }

    case "remove": {
      const name = remaining[1];
      if (!name) die("Usage: mcp remove <name>");
      const removed = await registry.remove(name);
      output({ ok: removed, name }, jsonMode);
      break;
    }

    case "list": {
      const servers = registry.list();
      output({ ok: true, servers }, jsonMode);
      break;
    }

    case "tools": {
      const serverName = remaining[1];
      if (!serverName) die("Usage: mcp tools <server> [--json]");
      const config = registry.get(serverName);
      if (!config) die(`MCP server not found: ${serverName}`);

      const transport = new ProcessMcpTransport(config.command, config.args, config.env);
      const client = new McpJsonRpcClient(transport);
      try {
        await client.initialize();
        const result = await client.listTools();
        output({ ok: true, ...(result as Record<string, unknown>) }, jsonMode);
      } finally {
        client.disconnect();
      }
      break;
    }

    case "call": {
      const serverName = remaining[1];
      const toolName = remaining[2];
      if (!serverName || !toolName) {
        die("Usage: mcp call <server> <tool> [--json '<args>']");
      }

      const config = registry.get(serverName);
      if (!config) die(`MCP server not found: ${serverName}`);

      let toolArgs: Record<string, unknown> = {};
      const jsonFlagIdx = remaining.indexOf("--json", 3);
      if (jsonFlagIdx !== -1 && jsonFlagIdx + 1 < remaining.length) {
        const nextArg = remaining[jsonFlagIdx + 1];
        if (nextArg.startsWith("{")) {
          try {
            toolArgs = JSON.parse(nextArg) as Record<string, unknown>;
          } catch {
            die("Invalid JSON args");
          }
        }
      }

      const transport = new ProcessMcpTransport(config.command, config.args, config.env);
      const client = new McpJsonRpcClient(transport);
      try {
        await client.initialize();
        const result = await client.callTool(toolName, toolArgs);
        output({ ok: true, ...(result as Record<string, unknown>) }, jsonMode);
      } finally {
        client.disconnect();
      }
      break;
    }

    default:
      die(`Unknown command: ${cmd}`);
  }

  return 0;
}
