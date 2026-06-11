import { createRequire } from "node:module";

import {
  stripManagedShellScreenNoise,
  type ScreenNoiseFilterState,
} from "./screen-filter.js";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

export type TerminalScreenBufferSize = {
  rows: number;
  cols: number;
};

export type TerminalScreenBufferSnapshot = TerminalScreenBufferSize & {
  text: string;
  hasScrollback: boolean;
  window: TerminalScreenBufferWindow;
};

export interface TerminalScreenBuffer {
  write(chunk: string): void;
  snapshot(options?: TerminalScreenBufferSnapshotOptions): Promise<TerminalScreenBufferSnapshot>;
  dispose(): void;
}

export type TerminalScreenBufferSnapshotOptions = {
  startLine?: number;
  lineCount?: number;
};

export type TerminalScreenBufferWindow = {
  startLine: number;
  endLine: number;
  totalLines: number;
  cols: number;
  rows: number;
  hasOlder: boolean;
  hasNewer: boolean;
};

export class XtermTerminalScreenBuffer implements TerminalScreenBuffer {
  private readonly terminal: import("@xterm/headless").Terminal;
  private pendingWrite: Promise<void> = Promise.resolve();
  private pendingOutput = "";
  private disposed = false;
  private filterState: ScreenNoiseFilterState = {
    pending: "",
    pendingPromptKind: null,
  };

  constructor(size: TerminalScreenBufferSize) {
    this.terminal = new Terminal({
      cols: positiveInteger(size.cols) ?? 80,
      rows: positiveInteger(size.rows) ?? 24,
      allowProposedApi: true,
      convertEol: false,
      scrollback: 1000,
      disableStdin: true,
      logLevel: "off",
    });
  }

  write(chunk: string): void {
    if (this.disposed || chunk.length === 0) {
      return;
    }

    const filtered = stripManagedShellScreenNoise(chunk, this.filterState);
    this.filterState = filtered.state;
    this.pendingOutput += filtered.output;
  }

  async snapshot(
    options: TerminalScreenBufferSnapshotOptions = {},
  ): Promise<TerminalScreenBufferSnapshot> {
    await this.flushPendingOutput();
    const buffer = this.terminal.buffer.active;
    const totalLines = Math.max(0, buffer.length);
    const lineCount = positiveInteger(options.lineCount) ?? this.terminal.rows;
    const startLine =
      options.startLine === undefined
        ? Math.max(0, totalLines - lineCount)
        : clamp(Math.floor(options.startLine), 0, totalLines);
    const endLine = Math.min(totalLines, startLine + lineCount);
    const lines: string[] = [];
    for (let row = startLine; row < endLine; row += 1) {
      const line = buffer.getLine(row);
      lines.push(line?.translateToString(true, 0, this.terminal.cols) ?? "");
    }
    return {
      rows: this.terminal.rows,
      cols: this.terminal.cols,
      text: lines.join("\n"),
      hasScrollback: startLine > 0 || endLine < totalLines,
      window: {
        startLine,
        endLine,
        totalLines,
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        hasOlder: startLine > 0,
        hasNewer: endLine < totalLines,
      },
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.terminal.dispose();
  }

  private async flushPendingOutput(): Promise<void> {
    if (this.pendingOutput.length === 0) {
      await this.pendingWrite;
      return;
    }

    const output = this.pendingOutput;
    this.pendingOutput = "";
    this.pendingWrite = this.pendingWrite.then(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(output, resolve);
        }),
    );
    await this.pendingWrite;
    if (this.pendingOutput.length > 0) {
      await this.flushPendingOutput();
    }
  }
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
