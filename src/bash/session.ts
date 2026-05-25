import * as nodePty from "node-pty";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BashSessionState, CurrentCommand } from "../types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPLETION_MARKER = "__TAH_COMMAND_DONE__";

/**
 * The marker command appended after every user command.
 * It prints the marker, the exit code of the preceding command, and the
 * current working directory -- all on a single line.
 */
const MARKER_COMMAND = `printf '\\n${COMPLETION_MARKER} rc=%s cwd=%s\\n' "$?" "$PWD"`;

// ---------------------------------------------------------------------------
// BashSession
// ---------------------------------------------------------------------------

export interface BashSessionOptions {
  id: string;
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  defaultTimeoutMs?: number;
  maxObservationBytes?: number;
  logDir?: string;
}

/**
 * Internal wrapper around a single node-pty instance.
 *
 * Responsibilities:
 * - Spawn and own the pty process
 * - Accumulate output in an in-memory buffer
 * - Detect the completion marker and extract returnCode / cwd
 * - Append all output to a persistent log file
 */
export class BashSession {
  readonly id: string;
  readonly shell: string;
  readonly logPath: string;

  private pty: nodePty.IPty | null = null;
  private outputBuffer = "";
  private totalBytes = 0;
  private lastObservationOffset = 0;
  private markerSearchStart = 0;
  private truncatedCount = 0;

  state: BashSessionState = "idle";
  cwd: string;
  env: Record<string, string>;

  currentCommand: CurrentCommand | null = null;

  readonly defaultTimeoutMs: number;
  readonly maxObservationBytes: number;

  private markerResolve: ((info: { returnCode: number; cwd: string }) => void) | null = null;
  private exitResolve: (() => void) | null = null;

  readonly createdAt: string;
  updatedAt: string;

  constructor(options: BashSessionOptions) {
    this.id = options.id;
    this.shell = options.shell ?? "/bin/bash";
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? {};
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxObservationBytes = options.maxObservationBytes ?? 8192;

    const logDir = options.logDir ?? path.join(process.cwd(), ".tiny-agent", "sessions");
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, `${this.id}.log`);

    // Truncate any previous log for this session id
    fs.writeFileSync(this.logPath, "");

    const now = new Date().toISOString();
    this.createdAt = now;
    this.updatedAt = now;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Spawn the pty process.
   */
  spawn(): void {
    if (this.pty) {
      throw new Error(`Session "${this.id}" already has a running pty.`);
    }

    const mergedEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...this.env,
      TERM: "dumb",
    };

    this.pty = nodePty.spawn(this.shell, [], {
      name: "dumb",
      cols: 200,
      rows: 50,
      cwd: this.cwd,
      env: mergedEnv,
    });

    this.pty.onData((data: string) => {
      this.onData(data);
    });

    this.pty.onExit((_exitInfo: { exitCode: number; signal?: number }) => {
      this.state = "terminated";
      this.updatedAt = new Date().toISOString();
      if (this.exitResolve) {
        this.exitResolve();
        this.exitResolve = null;
      }
      // Also resolve any pending marker wait so it doesn't hang
      if (this.markerResolve) {
        this.markerResolve({ returnCode: -1, cwd: this.cwd });
        this.markerResolve = null;
      }
    });

    this.state = "idle";
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Kill the pty process.
   */
  kill(): void {
    if (!this.pty) return;
    try {
      this.pty.kill();
    } catch {
      // Already dead
    }
    this.pty = null;
    this.state = "terminated";
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Send SIGINT (Ctrl-C) to the foreground process.
   */
  interrupt(): void {
    if (!this.pty) return;
    // Write Ctrl-C character
    this.pty.write("\x03");
    if (this.currentCommand) {
      this.currentCommand.status = "interrupted";
      this.currentCommand.returnCode = 130;
    }
    this.state = "idle";
    this.updatedAt = new Date().toISOString();
    // Resolve marker wait if pending
    if (this.markerResolve) {
      this.markerResolve({ returnCode: 130, cwd: this.cwd });
      this.markerResolve = null;
    }
  }

  /**
   * Write raw input to the pty (for sendInput control).
   */
  writeInput(input: string): void {
    if (!this.pty) {
      throw new Error(`Session "${this.id}" has no running pty.`);
    }
    this.pty.write(input);
  }

  // -----------------------------------------------------------------------
  // Command execution
  // -----------------------------------------------------------------------

  /**
   * Execute a command, injecting the completion marker, and wait for it
   * (or timeout).
   *
   * Returns the new output window and metadata.
   */
  async executeCommand(
    commandId: string,
    command: string,
    timeoutMs?: number,
  ): Promise<{
    output: string;
    outputTruncated: boolean;
    returnCode: number | null;
    timedOut: boolean;
    startOffset: number;
    endOffset: number;
  }> {
    if (!this.pty) {
      throw new Error(`Session "${this.id}" has no running pty.`);
    }

    if (this.state === "running") {
      throw new Error(
        `Session "${this.id}" is already running a command. Use poll, interrupt, or terminate.`,
      );
    }

    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
    const startOffset = this.totalBytes;
    this.markerSearchStart = this.outputBuffer.length;

    // Record current command
    this.currentCommand = {
      id: commandId,
      command,
      startedAt: new Date().toISOString(),
      timeoutMs: effectiveTimeout,
      status: "running",
      returnCode: null,
    };
    this.state = "running";
    this.updatedAt = new Date().toISOString();

    // Write the command + marker
    this.pty.write(`${command}\n`);
    this.pty.write(`${MARKER_COMMAND}\n`);

    // Wait for marker or timeout
    const result = await this.waitForMarker(effectiveTimeout);

    const endOffset = this.totalBytes;

    // Extract new output since startOffset
    let newOutput = this.getOutputSince(startOffset);

    // Remove the marker line from the output returned to the agent
    newOutput = this.stripMarkerFromOutput(newOutput);

    // Also strip the command echo lines (pty echoes what we write)
    newOutput = this.stripCommandEchoFromOutput(newOutput, command);

    // Truncation
    let outputTruncated = false;
    const newOutputBytes = Buffer.byteLength(newOutput, "utf-8");
    if (newOutputBytes > this.maxObservationBytes) {
      // Keep the last maxObservationBytes worth of output
      const buf = Buffer.from(newOutput, "utf-8");
      newOutput = buf.subarray(buf.length - this.maxObservationBytes).toString("utf-8");
      outputTruncated = true;
      this.truncatedCount++;
    }

    // Update lastObservationOffset
    this.lastObservationOffset = endOffset;

    if (result.timedOut) {
      if (this.currentCommand) {
        this.currentCommand.status = "timed_out";
      }
      // State stays "running" — the command is still going
      return {
        output: newOutput,
        outputTruncated,
        returnCode: null,
        timedOut: true,
        startOffset,
        endOffset,
      };
    }

    // Command completed
    this.cwd = result.cwd;
    if (this.currentCommand) {
      this.currentCommand.status = "exited";
      this.currentCommand.returnCode = result.returnCode;
    }
    this.state = "idle";
    this.updatedAt = new Date().toISOString();

    return {
      output: newOutput,
      outputTruncated,
      returnCode: result.returnCode,
      timedOut: false,
      startOffset,
      endOffset,
    };
  }

  // -----------------------------------------------------------------------
  // Poll — read new output without sending a command
  // -----------------------------------------------------------------------

  poll(): {
    output: string;
    outputTruncated: boolean;
    startOffset: number;
    endOffset: number;
  } {
    const startOffset = this.lastObservationOffset;
    const endOffset = this.totalBytes;

    let newOutput = this.getOutputSince(startOffset);

    // Strip markers from polled output too
    newOutput = this.stripMarkerFromOutput(newOutput);

    let outputTruncated = false;
    const newOutputBytes = Buffer.byteLength(newOutput, "utf-8");
    if (newOutputBytes > this.maxObservationBytes) {
      const buf = Buffer.from(newOutput, "utf-8");
      newOutput = buf.subarray(buf.length - this.maxObservationBytes).toString("utf-8");
      outputTruncated = true;
      this.truncatedCount++;
    }

    this.lastObservationOffset = endOffset;

    // Check if marker appeared (command finished while we weren't watching)
    // This is handled by the ongoing onData handler

    return { output: newOutput, outputTruncated, startOffset, endOffset };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private onData(data: string): void {
    this.outputBuffer += data;
    this.totalBytes += Buffer.byteLength(data, "utf-8");

    // Append to log file
    fs.appendFileSync(this.logPath, data);

    // Check for completion marker
    this.checkForMarker();
  }

  private checkForMarker(): void {
    if (!this.markerResolve) return;

    // Only search for markers in output produced after the current command started
    const searchRegion = this.outputBuffer.substring(this.markerSearchStart);
    const markerIndex = searchRegion.lastIndexOf(COMPLETION_MARKER);
    if (markerIndex === -1) return;

    const lineStart = markerIndex;
    const lineEnd = searchRegion.indexOf("\n", lineStart);
    if (lineEnd === -1) return;

    const markerLine = searchRegion.substring(lineStart, lineEnd);

    // Require rc=<number> to distinguish real marker output from PTY echo
    const rcMatch = markerLine.match(/rc=(-?\d+)/);
    if (!rcMatch) return;

    const cwdMatch = markerLine.match(/cwd=(.+)$/);
    const returnCode = parseInt(rcMatch[1], 10);
    const cwd = cwdMatch ? cwdMatch[1].trim() : this.cwd;

    this.markerResolve({ returnCode, cwd });
    this.markerResolve = null;
  }

  private waitForMarker(
    timeoutMs: number,
  ): Promise<{ timedOut: boolean; returnCode: number; cwd: string }> {
    return new Promise((resolve) => {
      // Check if marker already in buffer (only in the current command's region)
      const searchRegion = this.outputBuffer.substring(this.markerSearchStart);
      const markerIndex = searchRegion.lastIndexOf(COMPLETION_MARKER);
      if (markerIndex !== -1) {
        const lineStart = markerIndex;
        const lineEnd = searchRegion.indexOf("\n", lineStart);
        if (lineEnd !== -1) {
          const markerLine = searchRegion.substring(lineStart, lineEnd);
          const rcMatch = markerLine.match(/rc=(-?\d+)/);
          // Only resolve if this is a real marker (not just an echo)
          if (rcMatch) {
            const cwdMatch = markerLine.match(/cwd=(.+)$/);
            const returnCode = parseInt(rcMatch[1], 10);
            const cwd = cwdMatch ? cwdMatch[1].trim() : this.cwd;
            resolve({ timedOut: false, returnCode, cwd });
            return;
          }
        }
      }

      const timer = setTimeout(() => {
        this.markerResolve = null;
        resolve({ timedOut: true, returnCode: -1, cwd: this.cwd });
      }, timeoutMs);

      this.markerResolve = (info) => {
        clearTimeout(timer);
        resolve({ timedOut: false, ...info });
      };
    });
  }

  private getOutputSince(offset: number): string {
    // We track offsets in bytes but store output as a string.
    // Convert the full buffer to a Buffer, slice, and convert back.
    const buf = Buffer.from(this.outputBuffer, "utf-8");
    if (offset >= buf.length) return "";
    return buf.subarray(offset).toString("utf-8");
  }

  private stripMarkerFromOutput(output: string): string {
    // Remove lines containing the completion marker
    return output
      .split("\n")
      .filter((line) => !line.includes(COMPLETION_MARKER))
      .join("\n");
  }

  private stripCommandEchoFromOutput(output: string, command: string): string {
    // The pty echoes the typed command and the marker command.
    // Remove the first occurrence of each as an echoed line.
    const lines = output.split("\n");
    const result: string[] = [];
    let commandEchoStripped = false;
    let markerEchoStripped = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Strip the command echo (may have a prompt prefix)
      if (!commandEchoStripped && trimmed.endsWith(command.split("\n")[0])) {
        commandEchoStripped = true;
        continue;
      }

      // Strip the marker command echo
      if (!markerEchoStripped && trimmed.includes("__TAH_COMMAND_DONE__")) {
        markerEchoStripped = true;
        continue;
      }

      result.push(line);
    }

    return result.join("\n");
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  get isAlive(): boolean {
    return this.pty !== null && this.state !== "terminated";
  }

  getOutputInfo() {
    return {
      logPath: this.logPath,
      totalBytes: this.totalBytes,
      lastObservationOffset: this.lastObservationOffset,
      maxObservationBytes: this.maxObservationBytes,
      truncatedCount: this.truncatedCount,
    };
  }
}
