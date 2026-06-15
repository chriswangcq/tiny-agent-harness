import { ManagedTerminalRuntime } from "../bash/managed-terminal-runtime.js";
import { listenTerminalHostSocket } from "./server.js";

type TerminalHostCliOptions = {
  socketPath: string;
  defaultSessionId: string;
  cwd: string;
  promptNonce: string;
  sessionsDir?: string;
  rows: number;
  cols: number;
};

export async function runTerminalHostCli(
  args: string[],
  io: {
    stderr: { write(text: string): unknown };
    env: NodeJS.ProcessEnv;
  } = {
    stderr: process.stderr,
    env: process.env,
  },
): Promise<number> {
  let options: TerminalHostCliOptions;
  try {
    options = parseTerminalHostCliOptions(args);
  } catch (error) {
    io.stderr.write(
      `[tiny-agent terminal-host] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const runtime = new ManagedTerminalRuntime({
    defaultSessionId: options.defaultSessionId,
    cwd: options.cwd,
    promptNonce: options.promptNonce,
    env: io.env as Record<string, string>,
    sessionsDir: options.sessionsDir,
    screenRows: options.rows,
    screenCols: options.cols,
  });

  const server = await listenTerminalHostSocket({
    terminal: runtime.createRunPort(),
    socketPath: options.socketPath,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });
  return 0;
}

function parseTerminalHostCliOptions(args: string[]): TerminalHostCliOptions {
  let socketPath: string | undefined;
  let defaultSessionId = "default";
  let cwd = process.cwd();
  let promptNonce = `terminal-host-${Date.now()}`;
  let sessionsDir: string | undefined;
  let rows = 24;
  let cols = 80;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if (arg === "--socket" && value) {
      socketPath = value;
      index += 1;
    } else if (arg === "--default-session" && value) {
      defaultSessionId = value;
      index += 1;
    } else if (arg === "--cwd" && value) {
      cwd = value;
      index += 1;
    } else if (arg === "--prompt-nonce" && value) {
      promptNonce = value;
      index += 1;
    } else if (arg === "--sessions-dir" && value) {
      sessionsDir = value;
      index += 1;
    } else if (arg === "--rows" && value) {
      rows = parsePositiveInt(value, "--rows");
      index += 1;
    } else if (arg === "--cols" && value) {
      cols = parsePositiveInt(value, "--cols");
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }

  if (!socketPath) {
    throw new Error("Usage: tiny-agent terminal-host --socket <path>");
  }

  return {
    socketPath,
    defaultSessionId,
    cwd,
    promptNonce,
    sessionsDir,
    rows,
    cols,
  };
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}
