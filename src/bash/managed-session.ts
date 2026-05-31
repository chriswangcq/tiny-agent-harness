import * as nodePty from "node-pty";
import { execFileSync } from "node:child_process";
import { buildManagedShellInitSnippet } from "../application/managed-shell.js";
import { applyPtyChunkToSnapshot } from "../application/terminal-state-adapter.js";
import type { TerminalRuntimeSnapshot } from "../application/terminal-ports.js";
import { createTerminalState, markTerminalTerminated } from "../terminal/index.js";
import {
  XtermTerminalScreenBuffer,
  type TerminalScreenBuffer,
  type TerminalScreenBufferSnapshot,
} from "../terminal/screen-buffer.js";

export type ForegroundInspector = (shellPid: number) => string | null;

export const defaultForegroundInspector: ForegroundInspector = (
  shellPid: number,
): string | null => {
  try {
    const tpgid = execFileSync(
      "ps",
      ["-o", "tpgid=", "-p", String(shellPid)],
      { encoding: "utf-8", timeout: 500 },
    ).trim();
    if (!tpgid) return null;

    const commandOutput = execFileSync(
      "ps",
      ["-o", "comm=", "-g", tpgid],
      { encoding: "utf-8", timeout: 500 },
    );
    return (
      commandOutput
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
};

export type ManagedPtySessionOptions = {
  id: string;
  promptNonce: string;
  cwd: string;
  shell?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  foregroundInspector?: ForegroundInspector;
  screenBuffer?: TerminalScreenBuffer;
};

/**
 * Managed PTY session for the terminal-state protocol.
 */
export class ManagedPtySession {
  readonly id: string;
  readonly promptNonce: string;
  readonly cwd: string;
  readonly shell: string;
  readonly shellArgs: string[];
  readonly env: Record<string, string>;

  private pty: nodePty.IPty | null = null;
  private currentSnapshot: TerminalRuntimeSnapshot;
  private readonly outputChunks: Buffer[] = [];
  private outputBytes = 0;
  private readonly foregroundInspector: ForegroundInspector;
  private readonly screenBuffer: TerminalScreenBuffer;
  private readonly cols: number;
  private readonly rows: number;

  constructor(options: ManagedPtySessionOptions) {
    this.id = options.id;
    this.promptNonce = options.promptNonce;
    this.cwd = options.cwd;
    this.shell = options.shell ?? "/bin/bash";
    this.shellArgs = options.shellArgs ?? [
      "--noprofile",
      "--norc",
      "--noediting",
      "-i",
    ];
    this.cols = positiveInteger(options.cols) ?? 80;
    this.rows = positiveInteger(options.rows) ?? 24;
    this.env = normalizePtyEnv({
      ...processEnv(),
      ...(options.env ?? {}),
      TERM: "dumb",
    });
    this.foregroundInspector = options.foregroundInspector ?? defaultForegroundInspector;
    this.screenBuffer =
      options.screenBuffer ??
      new XtermTerminalScreenBuffer({ cols: this.cols, rows: this.rows });
    this.currentSnapshot = {
      session: this.id,
      terminal: createTerminalState({
        cwd: this.cwd,
        promptSeq: 0,
        lastReturnCode: null,
      }),
      parserState: { pending: "", totalBytes: 0 },
    };
  }

  spawn(): void {
    if (this.pty !== null) {
      throw new Error(`Managed PTY session "${this.id}" already spawned.`);
    }

    this.pty = nodePty.spawn(this.shell, this.shellArgs, {
      name: "dumb",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.env,
    });
    this.pty.onData((chunk: string) => {
      this.applyChunk(chunk);
    });
    this.pty.write(`${buildManagedShellInitSnippet({ nonce: this.promptNonce })}\n`);
  }

  write(input: string): void {
    if (this.pty === null) {
      throw new Error(`Managed PTY session "${this.id}" is not spawned.`);
    }
    this.pty.write(input);
  }

  interrupt(): void {
    this.write("\x03");
  }

  terminate(): void {
    if (this.pty === null) {
      return;
    }
    this.pty.kill();
    this.pty = null;
    this.currentSnapshot = {
      ...this.currentSnapshot,
      terminal: markTerminalTerminated(this.currentSnapshot.terminal, {
        exitCode: null,
        reason: "terminated",
      }),
    };
    this.screenBuffer.dispose();
  }

  detectForegroundProcess(): string | null {
    if (this.pty === null) return null;
    return this.foregroundInspector(this.pty.pid);
  }

  get snapshot(): TerminalRuntimeSnapshot {
    return this.currentSnapshot;
  }

  readOutputSince(byteOffset: number): {
    chunk: string;
    startOffset: number;
    endOffset: number;
  } {
    const startOffset = Math.max(0, Math.min(byteOffset, this.outputBytes));
    const output = Buffer.concat(this.outputChunks, this.outputBytes);
    return {
      chunk: output.subarray(startOffset).toString("utf-8"),
      startOffset,
      endOffset: this.outputBytes,
    };
  }

  async readScreen(): Promise<TerminalScreenBufferSnapshot> {
    return this.screenBuffer.snapshot();
  }

  private applyChunk(chunk: string): void {
    const bytes = Buffer.from(chunk, "utf-8");
    this.outputChunks.push(bytes);
    this.outputBytes += bytes.byteLength;
    this.screenBuffer.write(chunk);

    const result = applyPtyChunkToSnapshot({
      snapshot: this.currentSnapshot,
      chunk,
      promptNonce: this.promptNonce,
    });
    this.currentSnapshot = result.snapshot;
  }
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function normalizePtyEnv(env: Record<string, string>): Record<string, string> {
  if (!hasUtf8Locale(env)) {
    env.LANG = env.LANG && isUtf8Locale(env.LANG) ? env.LANG : "C.UTF-8";
    env.LC_CTYPE =
      env.LC_CTYPE && isUtf8Locale(env.LC_CTYPE)
        ? env.LC_CTYPE
        : env.LANG;
  }
  return env;
}

function hasUtf8Locale(env: Record<string, string>): boolean {
  return [env.LC_ALL, env.LC_CTYPE, env.LANG].some(
    (value) => value !== undefined && isUtf8Locale(value),
  );
}

function isUtf8Locale(value: string): boolean {
  return /utf-?8/iu.test(value);
}
