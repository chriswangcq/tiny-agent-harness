import { ManagedTerminalRuntime } from "../bash/managed-terminal-runtime.js";
import { serveTerminalHost } from "./server.js";
import type { Readable, Writable } from "node:stream";

type TerminalHostCliOptions = {
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
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
    env: NodeJS.ProcessEnv;
  } = {
    stdin: process.stdin,
    stdout: process.stdout,
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

  await serveTerminalHost({
    terminal: runtime.createRunPort(),
    input: io.stdin,
    output: io.stdout,
  });
  return 0;
}

function parseTerminalHostCliOptions(args: string[]): TerminalHostCliOptions {
  let defaultSessionId = "default";
  let cwd = process.cwd();
  let promptNonce = `terminal-host-${Date.now()}`;
  let sessionsDir: string | undefined;
  let rows = 24;
  let cols = 80;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if (arg === "--default-session" && value) {
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

  return {
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
