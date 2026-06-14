import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { failureEnvelope, successEnvelope } from "../cli/envelope.js";
import { McpJsonRpcClient, type McpRemoteServerConfig, type McpServerConfig } from "./client.js";
import { redactSensitive } from "./redaction.js";
import { McpRegistryStore } from "./registry.js";
import { StateRootResolver } from "../state/root.js";
import { createMcpTransport } from "./transport-factory.js";
import type {
  McpHostExecuteRequest,
  McpHostResponse,
} from "./host.js";

const DEFAULT_MCP_HOST_TIMEOUT_MS = 30_000;

export interface McpCommandDeps {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type McpClientRequest = {
  socketPath: string;
  request: McpHostExecuteRequest;
  timeoutMs: number;
};

export interface McpCliDeps extends McpCommandDeps {
  timeoutMs: number;
  newRequestId: () => string;
  requestHost: (request: McpClientRequest) => Promise<McpHostResponse>;
}

export function defaultMcpCommandDeps(): McpCommandDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
  };
}

export function defaultMcpCliDeps(): McpCliDeps {
  return {
    ...defaultMcpCommandDeps(),
    timeoutMs: DEFAULT_MCP_HOST_TIMEOUT_MS,
    newRequestId: () => `mcp-cli-${randomUUID()}`,
    requestHost: async (request) => {
      const { requestMcpHostSocket } = await import("./host.js");
      return await requestMcpHostSocket(request);
    },
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

/** Extract --state-dir <dir> from argv before -- separator.
 *  Returns the overridden state dir (if any) and cleaned argv.
 *  After --, everything is server args; --state-dir there is NOT consumed. */
function parseStateDir(argv: string[]): {
  stateDirOverride: string | undefined;
  cleanArgv: string[];
  error?: string;
} {
  const dashIdx = argv.indexOf("--");
  const preDash = dashIdx === -1 ? argv : argv.slice(0, dashIdx);
  const postDash = dashIdx === -1 ? [] : argv.slice(dashIdx);

  const stateIdx = preDash.indexOf("--state-dir");
  if (stateIdx !== -1) {
    // Validate: must have a next token that is not another flag
    if (stateIdx + 1 >= preDash.length || preDash[stateIdx + 1].startsWith("--")) {
      return {
        stateDirOverride: undefined,
        cleanArgv: argv,
        error: "Missing value for --state-dir",
      };
    }
    const stateDirOverride = preDash[stateIdx + 1];
    const cleanPreDash = [...preDash.slice(0, stateIdx), ...preDash.slice(stateIdx + 2)];
    return { stateDirOverride, cleanArgv: [...cleanPreDash, ...postDash] };
  }

  // --state-dir found in post-dash region: leave it alone (it's a server arg)
  return { stateDirOverride: undefined, cleanArgv: argv };
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

function writeStdout(deps: McpCommandDeps, data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    const raw = data as Record<string, unknown>;
    const isError = raw.ok === false;
    const envelope = isError
      ? failureEnvelope({ tool: "mcp", errorCode: "MCP_ERROR", error: String(raw.error ?? "unknown error") })
      : successEnvelope({ tool: "mcp", extra: { ...raw } });
    deps.stdout.write(JSON.stringify(envelope) + "\n");
  } else {
    const obj = data as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      deps.stdout.write(
        `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}\n`,
      );
    }
  }
}

function writeStderrError(deps: McpCommandDeps, message: string, errorCode = "MCP_ERROR"): void {
  const env = failureEnvelope({ tool: "mcp", errorCode, error: message });
  deps.stderr.write(JSON.stringify(env) + "\n");
}

type ParseRemoteAddResult =
  | { ok: true; config: McpRemoteServerConfig }
  | { ok: false; error: string };

function parseRemoteAddArgs(args: string[]): ParseRemoteAddResult {
  let url: string | undefined;
  let type: "http" | "sse" = "http";
  let protocolVersion: string | undefined;
  const headers: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--url": {
        const value = args[i + 1];
        if (!value || value.startsWith("--")) {
          return { ok: false, error: "Missing value for --url" };
        }
        url = value;
        i += 1;
        break;
      }
      case "--header":
      case "-H": {
        const value = args[i + 1];
        if (!value || value.startsWith("--")) {
          return { ok: false, error: `Missing value for ${arg}` };
        }
        const parsed = parseHeader(value);
        if (!parsed) {
          return { ok: false, error: `Invalid header: ${value}` };
        }
        headers[parsed.name] = parsed.value;
        i += 1;
        break;
      }
      case "--transport": {
        const value = args[i + 1];
        if (value !== "http" && value !== "sse") {
          return { ok: false, error: "--transport must be http or sse" };
        }
        type = value;
        i += 1;
        break;
      }
      case "--http": {
        type = "http";
        break;
      }
      case "--sse": {
        type = "sse";
        break;
      }
      case "--protocol-version": {
        const value = args[i + 1];
        if (!value || value.startsWith("--")) {
          return { ok: false, error: "Missing value for --protocol-version" };
        }
        protocolVersion = value;
        i += 1;
        break;
      }
      default:
        return { ok: false, error: `Unknown remote MCP option: ${arg}` };
    }
  }

  if (!url) {
    return { ok: false, error: "Remote MCP server requires --url <url>" };
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return { ok: false, error: "Remote MCP --url must use http or https" };
    }
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }

  return {
    ok: true,
    config: {
      type,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(protocolVersion ? { protocolVersion } : {}),
    },
  };
}

function parseHeader(value: string): { name: string; value: string } | undefined {
  const colon = value.indexOf(":");
  if (colon <= 0) return undefined;
  const name = value.slice(0, colon).trim();
  const headerValue = value.slice(colon + 1).trim();
  if (!name || !headerValue) return undefined;
  return { name, value: headerValue };
}

function shouldParseRemoteAdd(argsBeforeSeparator: string[]): boolean {
  return argsBeforeSeparator.includes("--url");
}

function redactServers(servers: McpServerConfig[]): McpServerConfig[] {
  return redactSensitive(servers) as McpServerConfig[];
}

function protocolVersionForConfig(config: McpServerConfig): string | undefined {
  if (config.type === "http" || config.type === "sse") {
    if (config.protocolVersion) return config.protocolVersion;
    return config.type === "http" ? "2025-03-26" : undefined;
  }
  return undefined;
}

function resolveStateDir(deps: McpCommandDeps, override?: string): string {
  if (override) return path.resolve(deps.cwd, override);
  if (deps.env.TAH_PROJECT_STATE_DIR) return path.resolve(deps.cwd, deps.env.TAH_PROJECT_STATE_DIR);
  if (deps.env.TAH_STATE_DIR) return path.resolve(deps.cwd, deps.env.TAH_STATE_DIR);
  const homeDir = deps.env.HOME ?? deps.env.USERPROFILE ?? path.join(deps.cwd, ".home");
  return new StateRootResolver({
    env: { ...deps.env, TAH_PROJECT_STATE_DIR: undefined, TAH_STATE_DIR: undefined },
    cwd: () => deps.cwd,
    homeDir: () => homeDir,
  }).resolve().stateDir;
}

export async function executeMcpHostCommand(
  argv: string[],
  deps: McpCommandDeps = defaultMcpCommandDeps(),
): Promise<number> {
  const { cleanArgv, jsonMode: finalJsonMode } = parseOutputMode(argv);
  const { stateDirOverride, cleanArgv: finalArgv, error: stateDirError } = parseStateDir(cleanArgv);
  if (stateDirError) {
    writeStderrError(deps, stateDirError);
    return 1;
  }

  const cmd = finalArgv[0];

  if (!cmd || cmd === "--help") {
    deps.stdout.write(`Usage: tiny-agent mcp [--json] <command> [args...] [--json]

Commands:
  tiny-agent mcp add <name> <command> [-- <server-args...>]  Register an MCP server
  tiny-agent mcp add <name> --url <url> [--header 'Name: Value'] [--transport http|sse]
  tiny-agent mcp remove <name>                                Remove an MCP server
  tiny-agent mcp list                                         List registered servers
  tiny-agent mcp tools <server>                               List tools from a server
  tiny-agent mcp call <server> <tool> [--args-json '<json>']  Call a tool
`);
    return 0;
  }

  const stateDir = resolveStateDir(deps, stateDirOverride);
  const registry = new McpRegistryStore(stateDir);
  const remaining = finalArgv;

  switch (cmd) {
    case "add": {
      const name = remaining[1];
      if (!name) {
        writeStderrError(deps, "Usage: tiny-agent mcp add <name> <command> [-- <args...>] OR tiny-agent mcp add <name> --url <url> [--header 'Name: Value']");
        return 1;
      }

      // Support -- separator: args after -- become server args
      const dashIdx = remaining.indexOf("--", 3);
      const addArgs = dashIdx !== -1 ? remaining.slice(2, dashIdx) : remaining.slice(2);

      if (shouldParseRemoteAdd(addArgs)) {
        if (dashIdx !== -1) {
          writeStderrError(deps, "Remote MCP add does not accept server args after --");
          return 1;
        }
        const parsed = parseRemoteAddArgs(addArgs);
        if (!parsed.ok) {
          writeStderrError(deps, parsed.error);
          return 1;
        }
        await registry.add({ name, ...parsed.config });
        writeStdout(deps, { ok: true, name }, finalJsonMode);
        break;
      }

      const command = remaining[2];
      if (!command) {
        writeStderrError(deps, "Usage: tiny-agent mcp add <name> <command> [-- <args...>]");
        return 1;
      }

      const args =
        dashIdx !== -1
          ? remaining.slice(dashIdx + 1) // everything after --
          : remaining.slice(3).filter((a) => a !== "--json");

      await registry.add({ name, command, args });
      writeStdout(deps, { ok: true, name }, finalJsonMode);
      break;
    }

    case "remove": {
      const name = remaining[1];
      if (!name) {
        writeStderrError(deps, "Usage: tiny-agent mcp remove <name>");
        return 1;
      }
      const removed = await registry.remove(name);
      writeStdout(deps, { ok: removed, name }, finalJsonMode);
      break;
    }

    case "list": {
      const servers = registry.list();
      writeStdout(deps, { ok: true, servers: redactServers(servers) }, finalJsonMode);
      break;
    }

    case "tools": {
      const serverName = remaining[1];
      if (!serverName) {
        writeStderrError(deps, "Usage: tiny-agent mcp tools <server>");
        return 1;
      }
      const config = registry.get(serverName);
      if (!config) {
        writeStderrError(deps, `MCP server not found: ${serverName}`);
        return 1;
      }

      let transport;
      try {
        transport = createMcpTransport(config);
      } catch (e) {
        writeStderrError(
          deps,
          e instanceof Error ? e.message : String(e),
        );
        return 1;
      }
      const client = new McpJsonRpcClient(
        transport,
        30_000,
        { protocolVersion: protocolVersionForConfig(config) },
      );
      try {
        await client.initialize();
        const result = await client.listTools();
        writeStdout(
          deps,
          { ok: true, ...(result as Record<string, unknown>) },
          finalJsonMode,
        );
      } catch (e) {
        writeStderrError(
          deps,
          e instanceof Error ? e.message : String(e),
        );
        return 1;
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
          "Usage: tiny-agent mcp call <server> <tool> [--args-json '<json>']",
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

      let transport;
      try {
        transport = createMcpTransport(config);
      } catch (e) {
        writeStderrError(
          deps,
          e instanceof Error ? e.message : String(e),
        );
        return 1;
      }
      const client = new McpJsonRpcClient(
        transport,
        30_000,
        { protocolVersion: protocolVersionForConfig(config) },
      );
      try {
        await client.initialize();
        const result = await client.callTool(toolName, toolArgs);
        writeStdout(
          deps,
          { ok: true, ...(result as Record<string, unknown>) },
          finalJsonMode,
        );
      } catch (e) {
        writeStderrError(
          deps,
          e instanceof Error ? e.message : String(e),
        );
        return 1;
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

export async function runMcpCli(
  argv: string[],
  deps: McpCliDeps = defaultMcpCliDeps(),
): Promise<number> {
  if (argv[0] === "host") {
    const { runMcpHostCli } = await import("./host.js");
    return await runMcpHostCli(argv.slice(1));
  }

  if (!argv[0] || argv[0] === "--help" || argv[0] === "-h") {
    return await executeMcpHostCommand(argv, deps);
  }

  return await executeMcpClientArgv(argv, deps);
}

export async function executeMcpClientArgv(
  argv: string[],
  deps: McpCliDeps,
): Promise<number> {
  let options: {
    commandArgv: string[];
    socketPath?: string;
    timeoutMs?: number;
  };
  try {
    options = parseMcpClientOptions(argv, deps.env);
  } catch (error) {
    writeMcpClientFailure(
      deps,
      "MCP_HOST_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }

  if (!options.socketPath) {
    writeMcpClientFailure(
      deps,
      "MCP_HOST_NOT_FOUND",
      "tiny-agent mcp requires a run-scoped MCP host socket. Set TAH_MCP_HOST_SOCKET or pass --host-socket <path>.",
    );
    return 1;
  }

  try {
    const response = await deps.requestHost({
      socketPath: options.socketPath,
      timeoutMs: options.timeoutMs ?? deps.timeoutMs,
      request: {
        schemaVersion: 1,
        id: deps.newRequestId(),
        type: "mcp.execute",
        argv: options.commandArgv,
      },
    });

    if (response.type === "mcp.execute.result") {
      if (response.stdout) deps.stdout.write(response.stdout);
      if (response.stderr) deps.stderr.write(response.stderr);
      return response.exitCode;
    }

    const message =
      response.type === "mcp.error"
        ? response.error.message
        : `Unexpected MCP host response: ${response.type}`;
    writeMcpClientFailure(deps, "MCP_HOST_ERROR", message);
    return 1;
  } catch (error) {
    writeMcpClientFailure(
      deps,
      "MCP_HOST_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}

function parseMcpClientOptions(
  argv: string[],
  env: Record<string, string | undefined>,
): {
  commandArgv: string[];
  socketPath?: string;
  timeoutMs?: number;
} {
  const commandArgv: string[] = [];
  let socketPath = env.TAH_MCP_HOST_SOCKET;
  let timeoutMs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--host-socket") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Usage: tiny-agent mcp <command> --host-socket <path>");
      }
      socketPath = value;
      index += 1;
      continue;
    }
    if (arg === "--host-timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Usage: tiny-agent mcp <command> --host-timeout-ms <ms>");
      }
      timeoutMs = parsePositiveInteger(value, "--host-timeout-ms");
      index += 1;
      continue;
    }
    commandArgv.push(arg);
  }

  return { commandArgv, socketPath, timeoutMs };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function writeMcpClientFailure(
  deps: Pick<McpCliDeps, "stdout">,
  errorCode: string,
  error: string,
): void {
  deps.stdout.write(
    JSON.stringify(
      failureEnvelope({
        tool: "mcp",
        errorCode,
        error,
      }),
    ) + "\n",
  );
}
