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
    if (Array.isArray(data)) {
      for (const item of data) {
        process.stdout.write(
          JSON.stringify(item) + "\n",
        );
      }
    } else if (typeof obj.ok === "boolean") {
      process.stdout.write(
        `${obj.ok ? "OK" : "FAIL"}: ${JSON.stringify(obj)}\n`,
      );
    } else {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// runMcpCli entry point
// ---------------------------------------------------------------------------

export async function runMcpCli(argv: string[]): Promise<void> {
  const subcommand = argv[0];
  const stateDir =
    process.env.TAH_STATE_DIR ?? path.resolve(".tiny-agent");

  const registryPath = path.join(stateDir, "mcp-servers.json");
  const registry = new McpRegistryStore(registryPath);

  const jsonMode = argv.includes("--json");

  switch (subcommand) {
    // -------------------------------------------------------------------
    // list
    // -------------------------------------------------------------------
    case "list": {
      const servers = registry.list();
      output({ servers }, jsonMode);
      break;
    }

    // -------------------------------------------------------------------
    // add
    // -------------------------------------------------------------------
    case "add": {
      const name = argv[1];
      const command = argv[2];
      if (!name || !command) {
        die("Usage: mcp add <name> <command> [args...]");
      }
      const args = argv.slice(3);
      registry.add({ name, command, args });
      output({ ok: true, name }, jsonMode);
      break;
    }

    // -------------------------------------------------------------------
    // remove
    // -------------------------------------------------------------------
    case "remove": {
      const name = argv[1];
      if (!name) die("Usage: mcp remove <name>");
      const removed = registry.remove(name);
      output({ ok: removed, name }, jsonMode);
      break;
    }

    // -------------------------------------------------------------------
    // tools — list tools from a server
    // -------------------------------------------------------------------
    case "tools": {
      const serverName = argv[1];
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

    // -------------------------------------------------------------------
    // call
    // -------------------------------------------------------------------
    case "call": {
      const serverName = argv[1];
      const toolName = argv[2];
      if (!serverName || !toolName) {
        die("Usage: mcp call <server> <tool> [--json '<args>']");
      }

      const config = registry.get(serverName);
      if (!config) die(`MCP server not found: ${serverName}`);

      let toolArgs: Record<string, unknown> = {};
      const jsonFlagIdx = argv.indexOf("--json");
      if (jsonFlagIdx !== -1 && jsonFlagIdx + 1 < argv.length) {
        const nextArg = argv[jsonFlagIdx + 1]!;
        // Only parse if it looks like JSON (starts with {)
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

    // -------------------------------------------------------------------
    // help / default
    // -------------------------------------------------------------------
    case "--help":
    case "-h":
    case undefined:
    default: {
      process.stdout.write(
        "Usage: mcp <list|add|remove|tools|call> [options]\n" +
          "  mcp list [--json]\n" +
          "  mcp add <name> <command> [args...]\n" +
          "  mcp remove <name>\n" +
          "  mcp tools <server> [--json]\n" +
          "  mcp call <server> <tool> [--json '<args>']\n",
      );
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Direct invocation
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpCli(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(
      `[mcp] Fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
