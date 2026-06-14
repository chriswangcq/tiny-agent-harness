import type {
  BackendCapabilities,
  CodeIntelBackend,
  CodeIntelCommand,
  CodeIntelConfig,
  CodeIntelDiagnostic,
  CodeIntelEnvelope,
  CodeIntelErrorCode,
  CodeIntelQuery,
} from "./types.js";
import { loadCodeIntelConfig } from "./config.js";
import { parseSourceLocation } from "./location.js";
import { failureEnvelope, successEnvelope } from "./output.js";
import { findWorkspaceRoot } from "./workspace.js";
import { TypeScriptLspBackend, typescriptCapabilities } from "./lsp/typescript.js";
import { collectWorkspaceDiagnostics } from "./tsc-diagnostics.js";

export type CodeIntelRuntime = {
  cwd: string;
  workspaceRoot: string;
  config: CodeIntelConfig;
  configPath?: string;
  createBackend: () => CodeIntelBackend;
  collectWorkspaceDiagnostics: () => {
    diagnostics: CodeIntelDiagnostic[];
    truncated: boolean;
    omittedResults: number;
  };
};

export type CodeIntelExecutionOptions = {
  backend?: CodeIntelBackend;
  disposeBackend?: boolean;
};

export function createCodeIntelRuntime(cwd: string): CodeIntelRuntime {
  const workspaceRoot = findWorkspaceRoot(cwd);
  const { config, configPath } = loadCodeIntelConfig(workspaceRoot);
  return {
    cwd,
    workspaceRoot,
    config,
    configPath,
    createBackend: () =>
      new TypeScriptLspBackend({
        workspaceRoot,
        serverCommand: config.languages.typescript.serverCommand,
        initializationOptions: config.languages.typescript.initializationOptions,
        workspaceFiles: config.languages.typescript.workspaceFiles,
        limits: config.limits,
      }),
    collectWorkspaceDiagnostics: () =>
      collectWorkspaceDiagnostics({
        workspaceRoot,
        limits: config.limits,
      }),
  };
}

export async function executeCodeIntelArgv(
  argv: string[],
  runtime = createCodeIntelRuntime(process.cwd()),
): Promise<CodeIntelEnvelope> {
  try {
    const command = parseCodeIntelArgv(argv);
    return await executeCodeIntelCommand(command, runtime);
  } catch (error) {
    return failureEnvelope({
      cwd: runtime.cwd,
      workspaceRoot: runtime.workspaceRoot,
      configPath: runtime.configPath,
      error: {
        code: classifyParseError(error),
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    });
  }
}

export async function executeCodeIntelCommand(
  command: CodeIntelCommand,
  runtime: CodeIntelRuntime,
  options: CodeIntelExecutionOptions = {},
): Promise<CodeIntelEnvelope> {
  const query = commandToQuery(command);
  const limits = { ...runtime.config.limits };

  if (command.kind === "capabilities") {
    const result: BackendCapabilities = {
      languages: [
        typescriptCapabilities({
          workspaceRoot: runtime.workspaceRoot,
          serverCommand: runtime.config.languages.typescript.serverCommand,
        }),
      ],
    };
    return successEnvelope({
      cwd: runtime.cwd,
      workspaceRoot: runtime.workspaceRoot,
      configPath: runtime.configPath,
      query,
      result,
      limits,
    });
  }

  if (command.kind === "diagnostics" && command.workspace) {
    try {
      const result = runtime.collectWorkspaceDiagnostics();
      return successEnvelope({
        cwd: runtime.cwd,
        workspaceRoot: runtime.workspaceRoot,
        configPath: runtime.configPath,
        backend: {
          languageId: "typescript",
          server: "tsc",
          serverCommand: ["tsc", "--noEmit", "--pretty", "false"],
          capabilities: ["diagnostics"],
          source: "typescript-compiler",
        },
        query,
        result: { diagnostics: result.diagnostics },
        limits: {
          ...limits,
          truncated: result.truncated,
          omittedResults: result.omittedResults,
        },
      });
    } catch (error) {
      return commandFailure(error, runtime, "request_failed");
    }
  }

  const backend = options.backend ?? runtime.createBackend();
  const disposeBackend = options.disposeBackend ?? options.backend === undefined;
  try {
    const result = await runBackendCommand(command, backend);
    return successEnvelope({
      cwd: runtime.cwd,
      workspaceRoot: runtime.workspaceRoot,
      configPath: runtime.configPath,
      backend: backend.info(),
      query,
      result,
      limits,
    });
  } catch (error) {
    return commandFailure(error, runtime, classifyRuntimeError(error));
  } finally {
    if (disposeBackend) {
      await backend.dispose();
    }
  }
}

export function parseCodeIntelArgv(argv: string[]): CodeIntelCommand {
  const args = argv.filter((arg) => arg !== "--json");
  rejectWriteFlags(args);
  const [command, ...rest] = args;

  switch (command) {
    case "capabilities":
      return { kind: "capabilities" };
    case "diagnostics": {
      const workspace = rest.includes("--workspace");
      const path = rest.find((arg) => !arg.startsWith("--"));
      if (!workspace && !path) {
        throw new Error("Usage: tiny-agent codeq diagnostics <path> --json OR tiny-agent codeq diagnostics --workspace --json");
      }
      return { kind: "diagnostics", path, workspace };
    }
    case "symbols": {
      const target = requiredPositional(command, rest);
      return { kind: "symbols", path: target };
    }
    case "workspace-symbols": {
      const query = requiredPositional(command, rest);
      return { kind: "workspace-symbols", query };
    }
    case "definition": {
      const target = requiredPositional(command, rest);
      return { kind: "definition", location: parseSourceLocation(target) };
    }
    case "references": {
      const target = requiredPositional(command, rest);
      return {
        kind: "references",
        location: parseSourceLocation(target),
        includeDeclaration: rest.includes("--include-declaration"),
      };
    }
    case "implementation":
    case "implementations": {
      const target = requiredPositional(command, rest);
      return { kind: "implementations", location: parseSourceLocation(target) };
    }
    case "incoming-calls": {
      const target = requiredPositional(command, rest);
      return { kind: "incoming-calls", location: parseSourceLocation(target) };
    }
    case "outgoing-calls": {
      const target = requiredPositional(command, rest);
      return { kind: "outgoing-calls", location: parseSourceLocation(target) };
    }
    case "hover": {
      const target = requiredPositional(command, rest);
      return { kind: "hover", location: parseSourceLocation(target) };
    }
    default:
      throw new Error(
        "Usage: tiny-agent codeq <capabilities|diagnostics|symbols|workspace-symbols|definition|references|implementations|incoming-calls|outgoing-calls|hover> ... --json",
      );
  }
}

function rejectWriteFlags(args: string[]): void {
  if (args.includes("--apply")) {
    throw new Error("tiny-agent codeq is read-only; --apply is not supported");
  }
}

async function runBackendCommand(
  command: CodeIntelCommand,
  backend: CodeIntelBackend,
): Promise<unknown> {
  switch (command.kind) {
    case "capabilities":
      throw new Error("capabilities does not use a language backend");
    case "diagnostics":
      return backend.diagnostics(command);
    case "symbols":
      return backend.symbols(command.path);
    case "workspace-symbols":
      return backend.workspaceSymbols(command.query);
    case "definition":
      return backend.definition(command.location);
    case "references":
      return backend.references(command);
    case "implementations":
      return backend.implementations(command.location);
    case "incoming-calls":
      return backend.incomingCalls(command.location);
    case "outgoing-calls":
      return backend.outgoingCalls(command.location);
    case "hover":
      return backend.hover(command.location);
  }
}

function commandToQuery(command: CodeIntelCommand): CodeIntelQuery {
  switch (command.kind) {
    case "capabilities":
      return { command: "capabilities" };
    case "diagnostics":
      return {
        command: "diagnostics",
        path: command.path,
        workspace: command.workspace,
      };
    case "symbols":
      return { command: "symbols", path: command.path };
    case "workspace-symbols":
      return { command: "workspace-symbols", query: command.query };
    case "definition":
      return { command: "definition", location: command.location };
    case "references":
      return {
        command: "references",
        location: command.location,
        includeDeclaration: command.includeDeclaration,
      };
    case "implementations":
      return { command: "implementations", location: command.location };
    case "incoming-calls":
      return { command: "incoming-calls", location: command.location };
    case "outgoing-calls":
      return { command: "outgoing-calls", location: command.location };
    case "hover":
      return { command: "hover", location: command.location };
  }
}

function requiredPositional(command: string, rest: string[]): string {
  const value = rest.find((arg) => !arg.startsWith("--"));
  if (!value) {
    throw new Error(`Usage: tiny-agent codeq ${command} <target> --json`);
  }
  return value;
}

function commandFailure(
  error: unknown,
  runtime: CodeIntelRuntime,
  code: CodeIntelErrorCode,
): CodeIntelEnvelope {
  return failureEnvelope({
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    configPath: runtime.configPath,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: code === "server_timeout" || code === "server_crashed",
    },
  });
}

function classifyParseError(error: unknown): CodeIntelErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("<path>:<line>:<column>")
    ? "parse_location_failed"
    : "invalid_args";
}

function classifyRuntimeError(error: unknown): CodeIntelErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Could not find")) {
    return "server_not_found";
  }
  if (message.includes("timed out") || message.includes("Timed out")) {
    return "server_timeout";
  }
  if (message.includes("exited unexpectedly")) {
    return "server_crashed";
  }
  if (message.includes("File not found")) {
    return "file_not_found";
  }
  return "request_failed";
}
