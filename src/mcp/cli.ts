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

/** --json is only valid as first arg (before subcommand) or standalone. */
function isOutputJson(argv: string[]): boolean {
  // --json at position 0
  if (argv[0] === "--json") return true;
  // --json at last position
  if (argv.length >= 2 && argv[argv.length - 1] === "--json") return true;
  return false;
}

/** Extract tool args from call command. Supports --args-json or legacy --json <json>. */
function extractCallJsonArgs(remaining: string[]): Record<string, unknown> {
  const argsIdx = remaining.indexOf("--args-json");
  if (argsIdx !== -1 && argsIdx + 1 < remaining.length) {
    try {
      return JSON.parse(remaining[argsIdx + 1]) as Record<string, unknown>;
    } catch {
      die("Invalid JSON for --args-json");
    }
  }
  // legacy: --json <json> after tool name
  const jsonIdx = remaining.indexOf("--json", 3);
  if (jsonIdx !== -1 && jsonIdx + 1 < remaining.length) {
    const nextArg = remaining[jsonIdx + 1];
    if (nextArg.startsWith("{")) {
      try {
        return JSON.parse(nextArg) as Record<string, unknown>;
      } catch {
        die("Invalid JSON args");
      }
    }
  }
  return {};
}

function resolveStateDir(): string {
  return process.env.TAH_STATE_DIR ?? path.resolve(".tiny-agent");
}

export async function runMcpCli(argv: string[]): Promise<number> {
  const jsonMode = isOutputJson(argv);
  // Remove --json for parsing: if at position 0, remove it; if at last, remove it
  const cleanArgv = jsonMode
    ? (argv[0] === "--json" ? argv.slice(1) : argv.slice(0, -1))
    : argv;

  const cmd = cleanArgv[0];

  if (!cmd || cmd === "--help") {
    process.stdout.write(`Usage: mcp [--json] <command> [args...] [--json]

Commands:
  add <name> <command> [-- <server-args...>]  Register an MCP server
  remove <name>                                Remove an MCP server
  list                                        List registered servers
  tools <server>                              List tools from a server
  call <server> <tool> [--args-json '<json>'] Call a tool
`);
    return 0;
  }

  const stateDir = resolveStateDir();
  const registryPath = path.join(stateDir, "mcp-servers.json");
  const registry = new McpRegistryStore(registryPath, stateDir);
  const remaining = cleanArgv;

  switch (cmd) {
    case "add": {
      const name = remaining[1];
      const command = remaining[2];
      if (!name || !command) die("Usage: mcp add <name> <command> [-- <args...>]");

      // Support -- separator: args after -- become server args (including literal --json)
      const dashIdx = remaining.indexOf("--", 3);
      const args = dashIdx !== -1
        ? remaining.slice(dashIdx + 1)  // everything after --
        : remaining.slice(3).filter(a => a !== "--json");

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
      if (!serverName) die("Usage: mcp tools <server>");
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
        die("Usage: mcp call <server> <tool> [--args-json '<json>']");
      }
      const config = registry.get(serverName);
      if (!config) die(`MCP server not found: ${serverName}`);

      const toolArgs = extractCallJsonArgs(remaining);

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
