import * as nodePty from "node-pty";
import { buildManagedShellInitSnippet } from "../application/managed-shell.js";
import {
  applyPtyChunkToSnapshot,
  applySilenceTimeoutToSnapshot,
} from "../application/pty-owner-adapter.js";
import type { TerminalRuntimeSnapshot } from "../application/terminal-ports.js";
import { createShellOwner } from "../terminal/fsm.js";
import type { ProcessInputPolicy } from "../terminal/index.js";

export type ManagedPtySessionOptions = {
  id: string;
  promptNonce: string;
  cwd: string;
  shell?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
};

/**
 * Managed PTY session for the TerminalOwner protocol.
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

  constructor(options: ManagedPtySessionOptions) {
    this.id = options.id;
    this.promptNonce = options.promptNonce;
    this.cwd = options.cwd;
    this.shell = options.shell ?? "/bin/bash";
    this.shellArgs = options.shellArgs ?? ["--noprofile", "--norc", "-i"];
    this.env = { ...(options.env ?? {}), TERM: "dumb" };
    this.currentSnapshot = {
      session: this.id,
      owner: createShellOwner({
        cwd: this.cwd,
        promptSeq: 0,
        lastReturnCode: null,
        promptNonce: this.promptNonce,
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
      cols: 200,
      rows: 50,
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
  }

  applySilenceTimeout(input: {
    elapsedMs: number;
    commandLine: string | null;
    startedAt: string;
    inputPolicy?: ProcessInputPolicy;
  }): TerminalRuntimeSnapshot {
    const result = applySilenceTimeoutToSnapshot({
      snapshot: this.currentSnapshot,
      ...input,
    });
    this.currentSnapshot = result.snapshot;
    return this.currentSnapshot;
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

  private applyChunk(chunk: string): void {
    const bytes = Buffer.from(chunk, "utf-8");
    this.outputChunks.push(bytes);
    this.outputBytes += bytes.byteLength;

    const result = applyPtyChunkToSnapshot({
      snapshot: this.currentSnapshot,
      chunk,
      promptNonce: this.promptNonce,
    });
    this.currentSnapshot = result.snapshot;
  }
}
