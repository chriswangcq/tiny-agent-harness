import * as path from "node:path";
import { McpJsonRpcClient } from "./client.js";
import { ProcessMcpTransport } from "./process-transport.js";
import { McpRegistryStore } from "./registry.js";

export interface McpCliDeps {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function defaultMcpCliDeps(): McpCliDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  };
}

function parseOutputMode(argv: string[]): {
  cleanArgv: string[];
  jsonMode: boolean;
} {
  if (argv[0] === "--json") {
    return { cleanArgv: argv.slice(1), jsonMode: true };
  }

  const dashIdx = argv.indexOf("--");
  const lastFlagIdx = dashIdx === -1 ? argv.length - 1 : dashIdx - 1;
  if (lastFlagIdx >= 0 && argv[lastFlagIdx] === "--json") {
    return {
      cleanArgv: [...argv.slice(0, lastFlagIdx), ...argv.slice(lastFlagIdx + 1)],
      jsonMode: true,
    };
  }

  return { cleanArgv: argv, jsonMode: false };
}

/** Extract tool args from call command. Throws on invalid JSON. */
function extractCallJsonArgs(remaining: string[]): Record<string, unknown> {
  const argsIdx = remaining.indexOf("--args-json");
  if (argsIdx !== -1 && argsIdx + 1 < remaining.length) {
    try {
      return JSON.parse(remaining[argsIdx + 1]) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid JSON for --args-json");
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
        throw new Error("Invalid JSON args");
      }
    }
  }
  return {};
}

function writeStdout(deps: McpCliDeps, data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    deps.stdout.write(JSON.stringify(data) + "\n");
  } else {
    const obj = data as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      deps.stdout.write(
        `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}\n`,
      );
    }
  }
}

function writeStderrError(deps: McpCliDeps, message: string): void {
  deps.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n");
}

function resolveStateDir(deps: McpCliDeps): string {
  return deps.env.TAH_STATE_DIR ?? path.resolve(deps.cwd, ".tiny-agent");
}

export async function runMcpCli(
  argv: string[],
  deps: McpCliDeps = defaultMcpCliDeps(),
): Promise<number> {
  const { cleanArgv, jsonMode } = parseOutputMode(argv);

  const cmd = cleanArgv[0];

  if (!cmd || cmd === "--help") {
    deps.stdout.write(`Usage: mcp [--json] <command> [args...] [--json]

Commands:
  add <name> <command> [-- <server-args...>]  Register an MCP server
  remove <name>                                Remove an MCP server
  list                                        List registered servers
  tools <server>                              List tools from a server
  call <server> <tool> [--args-json '<json>'] Call a tool
`);
    return 0;
  }

  const stateDir = resolveStateDir(deps);
  const registryPath = path.join(stateDir, "mcp-servers.json");
  const registry = new McpRegistryStore(registryPath, stateDir);
  const remaining = cleanArgv;

  switch (cmd) {
    case "add": {
      const name = remaining[1];
      const command = remaining[2];
      if (!name || !command) {
        writeStderrError(deps, "Usage: mcp add <name> <command> [-- <args...>]");
        return 1;
      }

      // Support -- separator: args after -- become server args
      const dashIdx = remaining.indexOf("--", 3);
      const args =
        dashIdx !== -1
          ? remaining.slice(dashIdx + 1) // everything after --
          : remaining.slice(3).filter((a) => a !== "--json");

      await registry.add({ name, command, args });
      writeStdout(deps, { ok: true, name }, jsonMode);
      break;
    }

    case "remove": {
      const name = remaining[1];
      if (!name) {
        writeStderrError(deps, "Usage: mcp remove <name>");
        return 1;
      }
      const removed = await registry.remove(name);
      writeStdout(deps, { ok: removed, name }, jsonMode);
      break;
    }

    case "list": {
      const servers = registry.list();
      writeStdout(deps, { ok: true, servers }, jsonMode);
      break;
    }

    case "tools": {
      const serverName = remaining[1];
      if (!serverName) {
        writeStderrError(deps, "Usage: mcp tools <server>");
        return 1;
      }
      const config = registry.get(serverName);
      if (!config) {
        writeStderrError(deps, `MCP server not found: ${serverName}`);
        return 1;
      }

      const transport = new ProcessMcpTransport(
        config.command,
        config.args,
        config.env,
      );
      const client = new McpJsonRpcClient(transport);
      try {
        await client.initialize();
        const result = await client.listTools();
        writeStdout(
          deps,
          { ok: true, ...(result as Record<string, unknown>) },
          jsonMode,
        );
      } finally {
        client.disconnect();
      }
      break;
    }

    case "call": {
      const serverName = remaining[1];
      const toolName = remaining[2];
      if (!serverName || !toolName) {
        writeStderrError(
          deps,
          "Usage: mcp call <server> <tool> [--args-json '<json>']",
        );
        return 1;
      }
      const config = registry.get(serverName);
      if (!config) {
        writeStderrError(deps, `MCP server not found: ${serverName}`);
        return 1;
      }

      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = extractCallJsonArgs(remaining);
      } catch (e) {
        writeStderrError(
          deps,
          e instanceof Error ? e.message : "Invalid tool arguments",
        );
        return 1;
      }

      const transport = new ProcessMcpTransport(
        config.command,
        config.args,
        config.env,
      );
      const client = new McpJsonRpcClient(transport);
      try {
        await client.initialize();
        const result = await client.callTool(toolName, toolArgs);
        writeStdout(
          deps,
          { ok: true, ...(result as Record<string, unknown>) },
          jsonMode,
        );
      } finally {
        client.disconnect();
      }
      break;
    }

    default:
      writeStderrError(deps, `Unknown command: ${cmd}`);
      return 1;
  }

  return 0;
}
